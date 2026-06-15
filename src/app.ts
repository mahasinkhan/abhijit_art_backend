// backend/src/app.ts
import express, { type Request, type Response } from "express";
import cors from "cors";
import authRoutes from "./routes/authRoutes.js";
import serviceRoutes from "./routes/serviceRoutes.js";
import bookingRoutes from "./routes/bookingRoutes.js";
import postRoutes from "./routes/postRoutes.js";
import visitorRoutes from "./routes/visitorRoutes.js";

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL || "*" }));
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