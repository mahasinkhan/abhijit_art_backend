// backend/src/server.ts
import dotenv from "dotenv";
dotenv.config();

import express, { type Request, type Response } from "express";
import cors from "cors";
import { prisma } from "./config/prisma.js";
import authRoutes from "./routes/authRoutes.js";
import serviceRoutes from "./routes/serviceRoutes.js";
import bookingRoutes from "./routes/bookingRoutes.js";
import postRoutes from "./routes/postRoutes.js";
import visitorRoutes from "./routes/visitorRoutes.js";

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

const PORT = process.env.PORT || 5000;

// verify the DB connection on boot, then listen
prisma.$connect()
  .then(() => {
    console.log("✅ PostgreSQL (Neon) connected via Prisma");
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch((err: unknown) => {
    console.error("❌ Database connection failed:", (err as Error).message);
    process.exit(1);
  });