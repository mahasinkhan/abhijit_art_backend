// backend/src/server.ts

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
import { prisma } from "./config/prisma.js";
import { verifyMailer } from "./config/mailer.js";
import authRoutes from "./routes/authRoutes.js";
import serviceRoutes from "./routes/serviceRoutes.js";
import bookingRoutes from "./routes/bookingRoutes.js";
import postRoutes from "./routes/postRoutes.js";
import visitorRoutes from "./routes/visitorRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";
import invoiceRoutes from "./routes/invoiceRoutes.js";
import securityRoutes from "./routes/securityRoutes.js";

const app = express();

// allowed frontend origins (local dev + deployed Vercel site)
const allowedOrigins = [
  "http://localhost:5173",
  "https://abhijit-art-frontend.vercel.app",
  process.env.CLIENT_URL || "",
].filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

app.use(express.json());
app.set("trust proxy", true);

app.get("/", (_req: Request, res: Response) => res.send("Avijit Art API is running 🎨"));
app.use("/api/auth", authRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/visitors", visitorRoutes);
app.use("/api/users", userRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/security", securityRoutes);

const PORT = process.env.PORT || 5000;

// verify the DB connection on boot, then listen
prisma.$connect()
  .then(() => {
    console.log("✅ PostgreSQL (Neon) connected via Prisma");
    app.listen(PORT, () => {
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