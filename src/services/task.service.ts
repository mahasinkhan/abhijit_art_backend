// backend/src/services/task.service.ts
import path from "path";
import fs from "fs";
import type { Prisma, TaskStatus, TaskPriority } from "@prisma/client";
import { prisma } from "../config/prisma.js";

export const taskInclude = {
  assignedTo:  { select: { id: true, name: true, email: true } },
  createdBy:   { select: { id: true, name: true } },
  deliveredBy: { select: { id: true, name: true } },
};

const toInt = (v: unknown) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

export function timelineStamps(
  status: string,
  existing: { startedAt: Date | null; completedAt: Date | null }
) {
  const now = new Date();
  const data: { startedAt?: Date | null; completedAt?: Date | null } = {};
  if (status === "in_progress") {
    if (!existing.startedAt) data.startedAt = now;
    data.completedAt = null;
  } else if (status === "completed") {
    if (!existing.startedAt) data.startedAt = now;
    data.completedAt = now;
  } else if (status === "pending" || status === "cancelled") {
    data.completedAt = null;
  }
  return data;
}

export const taskService = {

  async getAll(filters: { status?: string; priority?: string; assignedToId?: string }) {
    const where: Prisma.TaskWhereInput = {};
    if (filters.status)       where.status       = filters.status as TaskStatus;
    if (filters.priority)     where.priority     = filters.priority as TaskPriority;
    if (filters.assignedToId) where.assignedToId = filters.assignedToId;
    return prisma.task.findMany({ where, include: taskInclude, orderBy: { createdAt: "desc" } });
  },

  async getMine(userId: string) {
    return prisma.task.findMany({
      where: { assignedToId: userId },
      include: {
        createdBy:   { select: { id: true, name: true } },
        deliveredBy: { select: { id: true, name: true } },
      },
      orderBy: [{ status: "asc" }, { deadline: "asc" }, { createdAt: "desc" }],
    });
  },

  async getTeam() {
    return prisma.task.findMany({
      where: { status: { in: ["pending", "in_progress"] } },
      select: {
        id: true, title: true, status: true, priority: true, deadline: true,
        assignedTo: { select: { id: true, name: true } },
      },
      orderBy: [{ status: "asc" }, { deadline: "asc" }],
    });
  },

  async getOne(id: string) {
    const task = await prisma.task.findUnique({ where: { id }, include: taskInclude });
    if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });
    return task;
  },

  async create(body: any, imagePaths: string[], userId: string) {
    const {
      title, description, assignedToId, priority, deadline, links,
      customerName, customerPhone, customerEmail, orderDate,
      amount, advancePaid, invoiceId, invoiceNo,
    } = body;

    if (!title || !assignedToId)
      throw Object.assign(new Error("title and assignedToId are required"), { status: 400 });

    const assignee = await prisma.user.findUnique({ where: { id: assignedToId } });
    if (!assignee || assignee.role !== "employee")
      throw Object.assign(new Error("Assignee must be an employee"), { status: 400 });

    let parsedLinks: string[] = [];
    if (links) {
      try { parsedLinks = JSON.parse(links); }
      catch { parsedLinks = links.split(",").map((l: string) => l.trim()).filter(Boolean); }
    }

    return prisma.task.create({
      data: {
        title,
        description:   description   || null,
        images:        imagePaths,
        links:         parsedLinks,
        priority:      (priority || "medium") as TaskPriority,
        deadline:      deadline      ? new Date(deadline)   : null,
        customerName:  customerName?.trim()  || null,
        customerPhone: customerPhone?.trim() || null,
        customerEmail: customerEmail?.trim() || null,
        orderDate:     orderDate     ? new Date(orderDate)  : null,
        amount:        toInt(amount),
        advancePaid:   toInt(advancePaid),
        invoiceId:     invoiceId?.trim()  || null,
        invoiceNo:     invoiceNo?.trim()   || null,
        assignedToId,
        createdById: userId,
      },
      include: taskInclude,
    });
  },

  async update(id: string, body: any, newImagePaths: string[]) {
    const existing = await prisma.task.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error("Task not found"), { status: 404 });

    const {
      title, description, priority, deadline, links, status, removeImages,
      customerName, customerPhone, customerEmail, orderDate,
      amount, advancePaid, invoiceId, invoiceNo, assignedToId,
    } = body;

    if (assignedToId !== undefined) {
      const a = await prisma.user.findUnique({ where: { id: assignedToId } });
      if (!a || a.role !== "employee")
        throw Object.assign(new Error("Assignee must be an employee"), { status: 400 });
    }

    let images = [...existing.images];
    if (removeImages) {
      const toRemove: string[] = JSON.parse(removeImages);
      images = images.filter((img) => !toRemove.includes(img));
      toRemove.forEach((imgPath) => {
        const fullPath = path.join(process.cwd(), "public", imgPath);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      });
    }
    images = [...images, ...newImagePaths];

    let parsedLinks: string[] = existing.links;
    if (links !== undefined) {
      try { parsedLinks = JSON.parse(links); }
      catch { parsedLinks = links.split(",").map((l: string) => l.trim()).filter(Boolean); }
    }

    const stamps = status !== undefined
      ? timelineStamps(status, { startedAt: existing.startedAt, completedAt: existing.completedAt })
      : {};

    return prisma.task.update({
      where: { id },
      data: {
        ...(title         !== undefined && { title }),
        ...(description   !== undefined && { description }),
        ...(priority      !== undefined && { priority: priority as TaskPriority }),
        ...(status        !== undefined && { status: status as TaskStatus }),
        ...(deadline      !== undefined && { deadline: deadline ? new Date(deadline) : null }),
        ...(customerName  !== undefined && { customerName:  customerName?.trim()  || null }),
        ...(customerPhone !== undefined && { customerPhone: customerPhone?.trim() || null }),
        ...(customerEmail !== undefined && { customerEmail: customerEmail?.trim() || null }),
        ...(orderDate     !== undefined && { orderDate: orderDate ? new Date(orderDate) : null }),
        ...(amount        !== undefined && { amount:      toInt(amount) }),
        ...(advancePaid   !== undefined && { advancePaid: toInt(advancePaid) }),
        ...(invoiceId     !== undefined && { invoiceId: invoiceId?.trim() || null }),
        ...(invoiceNo     !== undefined && { invoiceNo: invoiceNo?.trim() || null }),
        ...(assignedToId  !== undefined && { assignedToId }),
        ...(status !== undefined && status !== "completed" && { deliveredAt: null, deliveredById: null }),
        ...stamps,
        images,
        links: parsedLinks,
      },
      include: taskInclude,
    });
  },

  async updateStatus(id: string, status: string, notes: string | undefined, userId: string, role: string) {
    const task = await prisma.task.findUnique({ where: { id } });
    if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });
    if (role === "employee" && task.assignedToId !== userId)
      throw Object.assign(new Error("Access denied"), { status: 403 });

    const allowed = ["pending", "in_progress", "completed", "cancelled"];
    if (!allowed.includes(status))
      throw Object.assign(new Error("Invalid status"), { status: 400 });

    const stamps = timelineStamps(status, { startedAt: task.startedAt, completedAt: task.completedAt });

    return prisma.task.update({
      where: { id },
      data: {
        status: status as TaskStatus,
        ...(notes !== undefined && { notes }),
        ...(status !== "completed" && { deliveredAt: null, deliveredById: null }),
        ...stamps,
      },
      include: taskInclude,
    });
  },

  async deliver(id: string, undo: boolean, userId: string, role: string) {
    const task = await prisma.task.findUnique({ where: { id } });
    if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });
    if (role === "employee" && task.assignedToId !== userId)
      throw Object.assign(new Error("Access denied"), { status: 403 });
    if (!undo && task.status !== "completed")
      throw Object.assign(new Error("Mark the task completed before delivering it"), { status: 400 });

    return prisma.task.update({
      where: { id },
      data: undo
        ? { deliveredAt: null, deliveredById: null }
        : { deliveredAt: new Date(), deliveredById: userId },
      include: taskInclude,
    });
  },

  async remove(id: string) {
    const task = await prisma.task.findUnique({ where: { id } });
    if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });

    task.images.forEach((imgPath) => {
      const fullPath = path.join(process.cwd(), "public", imgPath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    });

    await prisma.task.delete({ where: { id } });
    return { id };
  },
};