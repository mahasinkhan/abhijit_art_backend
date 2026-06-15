// backend/src/middleware/auth.ts
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma.js";
import type { User } from "@prisma/client";

type SafeUser = Omit<User, "password">;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SafeUser | null;
    }
  }
}

export const protect = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.split(" ")[1] : null;
    if (!token) return res.status(401).json({ message: "Not logged in" });

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is not set in .env");

    const decoded = jwt.verify(token, secret) as JwtPayload & { id: string };
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      omit: { password: true },
    });
    if (!user) return res.status(401).json({ message: "User not found" });

    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
};

export const adminOnly = (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Admins only" });
  }
  next();
};