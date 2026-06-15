// backend/src/app.ts
import express, { type Request, type Response } from "express";
import cors from "cors";
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

// behind a host/proxy (Hostinger, Railway, etc.) this makes req IPs accurate
app.set("trust proxy", true);

app.get("/", (_req: Request, res: Response) => res.send("Avijit Art API is running 🎨"));
app.use("/api/auth", authRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/visitors", visitorRoutes);

export default app;