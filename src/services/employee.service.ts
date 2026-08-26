// backend/src/services/employee.service.ts
import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const str     = (v: unknown) => String(v ?? "").trim();

const employeeSelect = {
  id: true, name: true, email: true, phone: true,
  role: true, createdAt: true,
  _count: { select: { tasksAssigned: true } },
} satisfies Prisma.UserSelect;

export const employeeService = {

  async list() {
    return prisma.user.findMany({
      where:   { role: "employee" },
      select:  employeeSelect,
      orderBy: { name: "asc" },
    });
  },

  async create(body: {
    name?: unknown; email?: unknown; phone?: unknown; password?: unknown;
  }) {
    const name     = str(body.name);
    const email    = str(body.email).toLowerCase();
    const phone    = str(body.phone);
    const password = str(body.password);

    if (!name || !email || !password)
      throw Object.assign(new Error("name, email and password are required"), { status: 400 });
    if (password.length < 6)
      throw Object.assign(new Error("Password must be at least 6 characters"), { status: 400 });
    if (!isEmail(email))
      throw Object.assign(new Error("That email doesn't look right."), { status: 400 });

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing)
      throw Object.assign(new Error("An account with this email already exists."), { status: 409 });

    const hashed = await bcrypt.hash(password, 10);

    return prisma.user.create({
      data: {
        name,
        email,
        phone:    phone || "",
        password: hashed,
        role:     "employee",
        source:   "offline" as any,
      },
      select: employeeSelect,
    });
  },

  async update(id: string, body: {
    name?: unknown; phone?: unknown; password?: unknown;
  }) {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing || existing.role !== "employee")
      throw Object.assign(new Error("Employee not found."), { status: 404 });

    const data: Prisma.UserUpdateInput = {};

    if (body.name  !== undefined) data.name  = str(body.name);
    if (body.phone !== undefined) data.phone = str(body.phone);

    if (body.password !== undefined && str(body.password)) {
      const pw = str(body.password);
      if (pw.length < 6)
        throw Object.assign(new Error("Password must be at least 6 characters"), { status: 400 });
      data.password = await bcrypt.hash(pw, 10);
    }

    return prisma.user.update({
      where:  { id },
      data,
      select: employeeSelect,
    });
  },

  async remove(id: string) {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing || existing.role !== "employee")
      throw Object.assign(new Error("Employee not found."), { status: 404 });

    await prisma.task.deleteMany({ where: { assignedToId: id } });
    await prisma.user.delete({ where: { id } });

    return { success: true };
  },
};