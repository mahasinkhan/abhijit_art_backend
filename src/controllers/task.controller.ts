// backend/src/controllers/task.controller.ts
import type { Request, Response } from "express";
import { taskService } from "../services/task.service.js";

const handle = (status: number, res: Response, data: unknown) => res.status(status).json(data);
const err = (res: Response, e: any) =>
  handle(e?.status || 500, res, { error: e?.message || "Internal server error" });

function emit(req: Request, event: string, data: unknown) {
  const io = (req as any).io;
  if (io) io.emit(event, data);
}

function imagePaths(req: Request): string[] {
  const files = (req.files as Express.Multer.File[]) || [];
  return files.map((f) => `/uploads/tasks/${f.filename}`);
}

export const taskController = {

  getAll: async (req: Request, res: Response) => {
    try {
      const { status, priority, assignedToId } = req.query as any;
      handle(200, res, await taskService.getAll({ status, priority, assignedToId }));
    } catch (e) { err(res, e); }
  },

  getMine: async (req: Request, res: Response) => {
    try { handle(200, res, await taskService.getMine(req.user!.id)); }
    catch (e) { err(res, e); }
  },

  getTeam: async (_req: Request, res: Response) => {
    try { handle(200, res, await taskService.getTeam()); }
    catch (e) { err(res, e); }
  },

  getOne: async (req: Request, res: Response) => {
    try {
      const task = await taskService.getOne(String(req.params.id));
      if (req.user!.role === "employee" && task.assignedToId !== req.user!.id)
        return handle(403, res, { error: "Access denied" });
      handle(200, res, task);
    } catch (e) { err(res, e); }
  },

  create: async (req: Request, res: Response) => {
    try {
      const task = await taskService.create(req.body, imagePaths(req), req.user!.id);
      emit(req, "task:created", task);
      handle(201, res, task);
    } catch (e) { err(res, e); }
  },

  update: async (req: Request, res: Response) => {
    try {
      const task = await taskService.update(String(req.params.id), req.body, imagePaths(req));
      emit(req, "task:updated", task);
      handle(200, res, task);
    } catch (e) { err(res, e); }
  },

  updateStatus: async (req: Request, res: Response) => {
    try {
      const { status, notes } = req.body;
      const task = await taskService.updateStatus(
        String(req.params.id), status, notes, req.user!.id, req.user!.role
      );
      emit(req, "task:updated", task);
      handle(200, res, task);
    } catch (e) { err(res, e); }
  },

  deliver: async (req: Request, res: Response) => {
    try {
      const undo = req.body?.delivered === false;
      const task = await taskService.deliver(String(req.params.id), undo, req.user!.id, req.user!.role);
      emit(req, "task:updated", task);
      handle(200, res, task);
    } catch (e) { err(res, e); }
  },

  remove: async (req: Request, res: Response) => {
    try {
      const result = await taskService.remove(String(req.params.id));
      emit(req, "task:deleted", result);
      handle(200, res, { success: true });
    } catch (e) { err(res, e); }
  },
};