// backend/src/services/employee.service.ts
import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";

const str = (v: unknown) => String(v ?? "").trim();
// keep only digits, last 10 — same rule the Customer model uses, so phone
// identity is consistent across the app.
const cleanPhone = (v: unknown) => str(v).replace(/\D/g, "").slice(-10);
// synthetic email so the required + unique `email` column never breaks now
// that employees have no email field. Username is unique (case-insensitive),
// so this address is unique too. It's internal only — never shown or used.
const staffEmail = (username: string) => `${username.toLowerCase()}@staff.abhijitart`;

const err = (message: string, status: number) => Object.assign(new Error(message), { status });

const employeeSelect = {
  id: true, name: true, phone: true, username: true,
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
    name?: unknown; username?: unknown; phone?: unknown; password?: unknown;
  }) {
    const name     = str(body.name);
    const username = str(body.username);
    const phone    = cleanPhone(body.phone);
    const password = str(body.password);

    if (!name)     throw err("Full name is required.", 400);
    if (!phone)    throw err("Phone number is required.", 400);
    if (!username) throw err("Username is required.", 400);
    if (!password) throw err("Password is required.", 400);
    if (password.length < 6) throw err("Password must be at least 6 characters.", 400);

    // phone unique across ALL users (it's an identity field now)
    const phoneClash = await prisma.user.findFirst({ where: { phone } });
    if (phoneClash) throw err("A user with this phone number already exists.", 409);

    // username unique, case-insensitive (so EMP001 and emp001 are the same)
    const userClash = await prisma.user.findFirst({
      where: { username: { equals: username, mode: "insensitive" } },
    });
    if (userClash) throw err("That username is already taken.", 409);

    const hashed = await bcrypt.hash(password, 10);

    return prisma.user.create({
      data: {
        name,
        username,
        email:    staffEmail(username),
        phone,
        password: hashed,
        role:     "employee",
        source:   "offline" as any,
      },
      select: employeeSelect,
    });
  },

  async update(id: string, body: {
    name?: unknown; username?: unknown; phone?: unknown; password?: unknown;
  }) {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing || existing.role !== "employee")
      throw err("Employee not found.", 404);

    const data: Prisma.UserUpdateInput = {};

    if (body.name !== undefined) {
      const name = str(body.name);
      if (!name) throw err("Full name is required.", 400);
      data.name = name;
    }

    if (body.phone !== undefined) {
      const phone = cleanPhone(body.phone);
      if (!phone) throw err("Phone number is required.", 400);
      const clash = await prisma.user.findFirst({ where: { phone, NOT: { id } } });
      if (clash) throw err("A user with this phone number already exists.", 409);
      data.phone = phone;
    }

    if (body.username !== undefined) {
      const username = str(body.username);
      if (!username) throw err("Username is required.", 400);
      const clash = await prisma.user.findFirst({
        where: { username: { equals: username, mode: "insensitive" }, NOT: { id } },
      });
      if (clash) throw err("That username is already taken.", 409);
      data.username = username;
      // keep the internal email in sync so it stays unique + tidy
      data.email = staffEmail(username);
    }

    if (body.password !== undefined && str(body.password)) {
      const pw = str(body.password);
      if (pw.length < 6) throw err("Password must be at least 6 characters.", 400);
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
      throw err("Employee not found.", 404);

    await prisma.task.deleteMany({ where: { assignedToId: id } });
    await prisma.user.delete({ where: { id } });

    return { success: true };
  },
};