// backend/src/routes/authRoutes.ts
import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../config/prisma.js";
import type { User } from "@prisma/client";

const router = Router();

const makeToken = (user: User) =>
  jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET as string, { expiresIn: "7d" });

const publicUser = (u: User) => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role,
});

router.post("/register", async (req: Request, res: Response) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ message: "Name, email and password are required" });

    const exists = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (exists) return res.status(400).json({ message: "Email already registered" });

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email: email.toLowerCase(), phone: phone || "", password: hashed, role: "client" },
    });
    res.status(201).json({ token: makeToken(user), user: publicUser(user) });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email: (email || "").toLowerCase() } });
    if (!user) return res.status(400).json({ message: "Invalid email or password" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ message: "Invalid email or password" });

    res.json({ token: makeToken(user), user: publicUser(user) });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

export default router;