/* Load .env FIRST — this must stay the very first import.
   ESM evaluates every `import` before any module body code, so the old
   `import dotenv from "dotenv"; dotenv.config();` actually ran AFTER
   config/prisma.js and all the route files had already been evaluated.
   Anything reading process.env at module scope (Prisma's DATABASE_URL,
   the mailer's SMTP_*) would see undefined. `dotenv/config` runs the
   loader as an import side effect, so being first in the list is enough. */
import "dotenv/config";

import express, { type Request, type Response } from "express";
import cors from "cors";
import compression from "compression";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "./config/prisma.js";
import { verifyMailer } from "./config/mailer.js";
import authRoutes from "./routes/authRoutes.js";
import serviceRoutes from "./routes/serviceRoutes.js";
import bookingRoutes from "./routes/bookingRoutes.js";
import postRoutes from "./routes/postRoutes.js";
import leadRoutes from "./routes/leadRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";
import invoiceRoutes from "./routes/invoiceRoutes.js";
import securityRoutes from "./routes/securityRoutes.js";
import taskRoutes from "./routes/taskRoutes.js";
import quickOrderRoutes from "./routes/quickOrderRoutes.js";
import { notFound, errorHandler } from "./middleware/error.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

// allowed frontend origins (local dev + deployed Vercel site)
const allowedOrigins = [
  "http://localhost:5173",
  "https://abhijitart.com",
  "https://www.abhijitart.com",
  "https://api.abhijitart.com",
  process.env.CLIENT_URL || "",
].filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// Compress all responses (gzip) — reduces payload size significantly
app.use(compression());

app.use(express.json());
app.set("trust proxy", true);

// Serve uploaded task images (and any future uploads) as static files.
// Files land at  backend/public/uploads/tasks/<filename>
// and are served at  /uploads/tasks/<filename>  — same path taskRoutes writes.
// process.cwd() always resolves to the backend root (C:\avijit-art\backend)
// regardless of whether we're running ts-node/tsx (src/) or compiled JS (dist/).
app.use(
  "/uploads",
  express.static(path.join(process.cwd(), "public", "uploads")),
);

// ── Socket.IO setup ────────────────────────────────────────────────────────
// Wrap Express in a raw HTTP server so Socket.IO can share the same port.
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

// Attach `io` to every request so route handlers can emit events without
// importing the io instance directly (avoids circular imports).
app.use((req: Request, _res, next) => {
  (req as any).io = io;
  next();
});

io.on("connection", (socket) => {
  // Allow clients to join a personal room so admin can target a specific
  // employee with task events instead of broadcasting to everyone.
  socket.on("join", (userId: string) => {
    if (typeof userId === "string" && userId.length > 0) {
      socket.join(`user:${userId}`);
    }
  });
});

// ── Routes ─────────────────────────────────────────────────────────────────
app.get("/", (_req: Request, res: Response) => res.send("Avijit Art API is running 🎨"));
app.use("/api/auth",          authRoutes);
app.use("/api/services",      serviceRoutes);
app.use("/api/bookings",      bookingRoutes);
app.use("/api/posts",         postRoutes);
// Chatbot leads. New semantic path:
app.use("/api/leads",         leadRoutes);
// Backward-compat alias so the existing ChatWidget (POST /api/visitors/lead)
// keeps working with no frontend change. Remove this line once the ChatWidget
// is switched over to /api/leads.
app.use("/api/visitors",      leadRoutes);
app.use("/api/users",         userRoutes);
app.use("/api/inventory",     inventoryRoutes);
app.use("/api/invoices",      invoiceRoutes);
app.use("/api/security",      securityRoutes);
app.use("/api/tasks",         taskRoutes);
app.use("/api/quick-orders",  quickOrderRoutes);

// ── Error handling (must come AFTER every route) ─────────────────────────────
// Any request that matched no route above falls through to notFound; anything
// a handler throws (or forwards via asyncHandler) lands in errorHandler, which
// is the single place that shapes an error into a JSON response. errorHandler
// MUST be the last app.use — Express identifies it as an error handler by its
// 4-argument signature.
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

// verify the DB connection on boot, then listen
prisma.$connect()
  .then(() => {
    console.log("✅ PostgreSQL (Neon) connected via Prisma");
    // Use httpServer (not app) so Socket.IO and Express share the same port.
    httpServer.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      /* Check the SMTP login once at boot so a bad App Password shows up here
         instead of as a failed send later. Logs and returns, never throws —
         email problems must not stop the API from serving. */
      verifyMailer();
    });
  })
  .catch((err: unknown) => {
    console.error("❌ Database connection failed:", (err as Error).message);
    process.exit(1);
  });