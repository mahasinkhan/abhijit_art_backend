// backend/src/controllers/employee.controller.ts
import type { Request, Response } from "express";
import { employeeService } from "../services/employee.service.js";

const send = (res: Response, status: number, data: unknown) => res.status(status).json(data);

const fail = (res: Response, e: any) =>
  send(res, e?.status || 500, {
    error:   e?.message || "Internal server error",
    message: e?.message || "Internal server error",
  });

export const employeeController = {

  list: async (_req: Request, res: Response) => {
    try { send(res, 200, await employeeService.list()); }
    catch (e) { fail(res, e); }
  },

  create: async (req: Request, res: Response) => {
    try { send(res, 201, await employeeService.create(req.body)); }
    catch (e) { fail(res, e); }
  },

  update: async (req: Request, res: Response) => {
    try { send(res, 200, await employeeService.update(String(req.params.id), req.body)); }
    catch (e) { fail(res, e); }
  },

  remove: async (req: Request, res: Response) => {
    try { send(res, 200, await employeeService.remove(String(req.params.id))); }
    catch (e) { fail(res, e); }
  },
};