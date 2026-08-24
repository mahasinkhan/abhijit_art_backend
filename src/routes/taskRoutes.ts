import { Router, Request, Response } from "express";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = Router();
router.use(protect);

// Multer config for task images
const taskImageDir = path.join(process.cwd(), "public", "uploads", "tasks");
if (!fs.existsSync(taskImageDir)) fs.mkdirSync(taskImageDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, taskImageDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `task-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files allowed"));
  },
});

const taskInclude = {
  assignedTo: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true } },
  deliveredBy: { select: { id: true, name: true } },
};

// FormData sends everything as strings — coerce money fields safely to int ₹.
const toInt = (v: unknown) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

function emitTaskUpdate(req: Request, event: string, data: unknown) {
  const io = (req as any).io;
  if (io) io.emit(event, data);
}

function timelineStamps(
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

// ============================================================================
// IMPORTANT: specific/static routes (/mine, /employees/list) MUST be declared
// BEFORE the dynamic "/:id" route, or Express could match them as an :id.
// ============================================================================

// -- Admin: Create task ------------------------------------------------------
router.post(
  "/",
  adminOnly,
  upload.array("images", 10),
  async (req: Request, res: Response) => {
    try {
      const {
        title, description, assignedToId, priority, deadline, links,
        customerName, customerPhone, customerEmail, orderDate, amount, advancePaid,
        invoiceId, invoiceNo,
      } = req.body;

      if (!title || !assignedToId) {
        return res.status(400).json({ error: "title and assignedToId are required" });
      }

      const assignee = await prisma.user.findUnique({ where: { id: assignedToId } });
      if (!assignee || assignee.role !== "employee") {
        return res.status(400).json({ error: "Assignee must be an employee" });
      }

      const files = (req.files as Express.Multer.File[]) || [];
      const imagePaths = files.map((f) => `/uploads/tasks/${f.filename}`);

      let parsedLinks: string[] = [];
      if (links) {
        try { parsedLinks = JSON.parse(links); }
        catch { parsedLinks = links.split(",").map((l: string) => l.trim()).filter(Boolean); }
      }

      const task = await prisma.task.create({
        data: {
          title,
          description: description || null,
          images: imagePaths,
          links: parsedLinks,
          priority: priority || "medium",
          deadline: deadline ? new Date(deadline) : null,
          customerName: customerName?.trim() || null,
          customerPhone: customerPhone?.trim() || null,
          customerEmail: customerEmail?.trim() || null,
          orderDate: orderDate ? new Date(orderDate) : null,
          amount: toInt(amount),
          advancePaid: toInt(advancePaid),
          invoiceId: invoiceId?.trim() || null,
          invoiceNo: invoiceNo?.trim() || null,
          assignedToId,
          createdById: req.user!.id,
        },
        include: taskInclude,
      });

      emitTaskUpdate(req, "task:created", task);
      res.status(201).json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

// -- Admin: Get all tasks ----------------------------------------------------
router.get("/", adminOnly, async (req: Request, res: Response) => {
  try {
    const { status, priority, assignedToId } = req.query;
    const where: any = {};
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (assignedToId) where.assignedToId = assignedToId;

    const tasks = await prisma.task.findMany({
      where,
      include: taskInclude,
      orderBy: { createdAt: "desc" },
    });
    res.json(tasks);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -- Employee: Get my tasks (STATIC — before /:id) ---------------------------
router.get("/mine", async (req: Request, res: Response) => {
  try {
    const tasks = await prisma.task.findMany({
      where: { assignedToId: req.user!.id },
      include: {
        createdBy: { select: { id: true, name: true } },
        deliveredBy: { select: { id: true, name: true } },
      },
      orderBy: [{ status: "asc" }, { deadline: "asc" }, { createdAt: "desc" }],
    });
    res.json(tasks);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -- Admin: Get all employees (STATIC — before /:id) -------------------------
router.get("/employees/list", adminOnly, async (_req: Request, res: Response) => {
  try {
    const employees = await prisma.user.findMany({
      where: { role: "employee" },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
        _count: { select: { tasksAssigned: true } },
      },
      orderBy: { name: "asc" },
    });
    res.json(employees);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -- Get single task (DYNAMIC — must come AFTER the static routes) ------------
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const task = await prisma.task.findUnique({
      where: { id: String(req.params.id) },
      include: taskInclude,
    });
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (req.user!.role === "employee" && task.assignedToId !== req.user!.id) {
      return res.status(403).json({ error: "Access denied" });
    }
    res.json(task);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -- Admin: Update task (full edit) ------------------------------------------
router.patch(
  "/:id",
  adminOnly,
  upload.array("newImages", 10),
  async (req: Request, res: Response) => {
    try {
      const {
        title, description, priority, deadline, links, status, removeImages,
        customerName, customerPhone, customerEmail, orderDate, amount, advancePaid,
        invoiceId, invoiceNo, assignedToId,
      } = req.body;

      const existing = await prisma.task.findUnique({ where: { id: String(req.params.id) } });
      if (!existing) return res.status(404).json({ error: "Task not found" });

      if (assignedToId !== undefined) {
        const a = await prisma.user.findUnique({ where: { id: assignedToId } });
        if (!a || a.role !== "employee") {
          return res.status(400).json({ error: "Assignee must be an employee" });
        }
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

      const files = (req.files as Express.Multer.File[]) || [];
      const newImagePaths = files.map((f) => `/uploads/tasks/${f.filename}`);
      images = [...images, ...newImagePaths];

      let parsedLinks: string[] = existing.links;
      if (links !== undefined) {
        try { parsedLinks = JSON.parse(links); }
        catch { parsedLinks = links.split(",").map((l: string) => l.trim()).filter(Boolean); }
      }

      const stamps =
        status !== undefined
          ? timelineStamps(status, { startedAt: existing.startedAt, completedAt: existing.completedAt })
          : {};

      const task = await prisma.task.update({
        where: { id: String(req.params.id) },
        data: {
          ...(title !== undefined && { title }),
          ...(description !== undefined && { description }),
          ...(priority !== undefined && { priority }),
          ...(status !== undefined && { status }),
          ...(deadline !== undefined && { deadline: deadline ? new Date(deadline) : null }),
          ...(customerName !== undefined && { customerName: customerName?.trim() || null }),
          ...(customerPhone !== undefined && { customerPhone: customerPhone?.trim() || null }),
          ...(customerEmail !== undefined && { customerEmail: customerEmail?.trim() || null }),
          ...(orderDate !== undefined && { orderDate: orderDate ? new Date(orderDate) : null }),
          ...(amount !== undefined && { amount: toInt(amount) }),
          ...(advancePaid !== undefined && { advancePaid: toInt(advancePaid) }),
          ...(invoiceId !== undefined && { invoiceId: invoiceId?.trim() || null }),
          ...(invoiceNo !== undefined && { invoiceNo: invoiceNo?.trim() || null }),
          ...(assignedToId !== undefined && { assignedToId }),
          // moving a task back out of "completed" un-delivers it — a task that
          // isn't finished can't have been delivered.
          ...(status !== undefined && status !== "completed" && { deliveredAt: null, deliveredById: null }),
          ...stamps,
          images,
          links: parsedLinks,
        },
        include: taskInclude,
      });

      emitTaskUpdate(req, "task:updated", task);
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

// -- Employee (or admin): Update task status + notes -------------------------
router.patch("/:id/status", async (req: Request, res: Response) => {
  try {
    const { status, notes } = req.body;

    const task = await prisma.task.findUnique({ where: { id: String(req.params.id) } });
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (req.user!.role === "employee" && task.assignedToId !== req.user!.id) {
      return res.status(403).json({ error: "Access denied" });
    }

    const allowedStatuses = ["pending", "in_progress", "completed", "cancelled"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const stamps = timelineStamps(status, {
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    });

    const updated = await prisma.task.update({
      where: { id: String(req.params.id) },
      data: {
        status,
        ...(notes !== undefined && { notes }),
        // leaving "completed" clears the delivery record (see PATCH /:id note)
        ...(status !== "completed" && { deliveredAt: null, deliveredById: null }),
        ...stamps,
      },
      include: taskInclude,
    });

    emitTaskUpdate(req, "task:updated", updated);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -- Employee (or admin): Mark a COMPLETED task delivered --------------------
// Records who physically handed the order to the customer + when. Pass
// { delivered: false } to undo an accidental mark. The assigned employee can
// deliver their own task; admin can deliver any. A task must be completed
// first (delivery is the step after completion).
router.patch("/:id/deliver", async (req: Request, res: Response) => {
  try {
    const task = await prisma.task.findUnique({ where: { id: String(req.params.id) } });
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (req.user!.role === "employee" && task.assignedToId !== req.user!.id) {
      return res.status(403).json({ error: "Access denied" });
    }

    const undo = req.body?.delivered === false;

    if (!undo && task.status !== "completed") {
      return res.status(400).json({ error: "Mark the task completed before delivering it" });
    }

    const updated = await prisma.task.update({
      where: { id: String(req.params.id) },
      data: undo
        ? { deliveredAt: null, deliveredById: null }
        : { deliveredAt: new Date(), deliveredById: req.user!.id },
      include: taskInclude,
    });

    emitTaskUpdate(req, "task:updated", updated);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -- Admin: Delete task ------------------------------------------------------
router.delete("/:id", adminOnly, async (req: Request, res: Response) => {
  try {
    const task = await prisma.task.findUnique({ where: { id: String(req.params.id) } });
    if (!task) return res.status(404).json({ error: "Task not found" });

    task.images.forEach((imgPath) => {
      const fullPath = path.join(process.cwd(), "public", imgPath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    });

    await prisma.task.delete({ where: { id: String(req.params.id) } });
    emitTaskUpdate(req, "task:deleted", { id: req.params.id });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;