// backend/src/middleware/auth.ts
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma.js";
import type { User, Role } from "@prisma/client";

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

/**
 * Generic gate. Use it when a route suits more than one role.
 * Always mount it AFTER protect, since it reads req.user.
 *   router.use(protect, allowRoles("admin", "employee"));
 */
export const allowRoles =
  (...roles: Role[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ message: "You do not have access to this" });
    }
    next();
  };

/**
 * Site content gate: the operations employee who designs and uploads
 * hero banners, the offer strip and service cards. Admin passes too,
 * so the owner is never locked out of their own site content.
 */
export const operationOnly = allowRoles("admin", "operation");

/** Any signed-in staff member, for shared internal reads. */
export const staffOnly = allowRoles("admin", "operation", "employee");