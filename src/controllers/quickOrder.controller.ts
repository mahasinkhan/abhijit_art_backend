// backend/src/controllers/quickOrder.controller.ts
import type { Request, Response } from "express";
import { quickOrderService, type AuditInfo } from "../services/quickOrder.service.js";
import { logAudit } from "../utils/security.js";

function emit(req: Request, event: string, data: unknown) {
  const io = (req as any).io;
  if (io) io.emit(event, data);
}

function imagePaths(req: Request): string[] {
  const files = (req.files as Express.Multer.File[]) || [];
  return files.map((f) => `/uploads/tasks/${f.filename}`);
}

/* run a service WRITE: await { result, audit }, log it, emit socket, respond */
async function respondWrite(
  req: Request,
  res: Response,
  status: number,
  work: Promise<{ result: unknown; audit: AuditInfo }>,
  socketEvent?: string,
): Promise<void> {
  const { result, audit } = await work;
  await logAudit({ req, entity: "quickorder", ...audit });
  // emit socket event if specified — result is the updated QuickOrder with task
  if (socketEvent && result && (result as any).task) {
    emit(req, socketEvent, (result as any).task);
  }
  res.status(status).json(result);
}

export const quickOrderController = {

  /* ── reads (admin + employee) ── */
  listOrders: async (req: Request, res: Response) => {
    res.json(await quickOrderService.listOrders({
      date:       req.query.date       as string | undefined,
      customerId: req.query.customerId as string | undefined,
    }));
  },

  ledger: async (req: Request, res: Response) => {
    res.json(await quickOrderService.ledger({ date: req.query.date as string | undefined }));
  },

  searchCustomers: async (req: Request, res: Response) => {
    res.json(await quickOrderService.searchCustomers(String(req.query.q || ""), Number(req.query.take) || 8));
  },

  listEmployees: async (_req: Request, res: Response) => {
    res.json(await quickOrderService.listEmployees());
  },

  /* ── writes (admin only) ── */
  createOrder: async (req: Request, res: Response) => {
    const body = { ...req.body, images: imagePaths(req) };
    return respondWrite(req, res, 201, quickOrderService.createOrder(body, req.user!.id), "task:created");
  },

  updateOrder: async (req: Request, res: Response) => {
    const newImages = imagePaths(req);
    const existing  = req.body.existingImages ? JSON.parse(req.body.existingImages) : undefined;
    const images    = existing ? [...existing, ...newImages] : (newImages.length ? newImages : undefined);
    const body      = { ...req.body, ...(images ? { images } : {}) };
    return respondWrite(req, res, 200, quickOrderService.updateOrder(String(req.params.id), body));
  },

  deleteOrder: (req: Request, res: Response) =>
    respondWrite(req, res, 200,
      quickOrderService.deleteOrder(String(req.params.id))),

  assignOrder: (req: Request, res: Response) =>
    respondWrite(req, res, 200,
      quickOrderService.assignOrder(String(req.params.id), req.body, req.user!.id),
      "task:created"),

  unassignOrder: async (req: Request, res: Response) => {
    // need the task id before deletion for socket emit
    const { result, audit } = await quickOrderService.unassignOrder(String(req.params.id));
    await logAudit({ req, entity: "quickorder", ...audit });
    emit(req, "task:deleted", { id: String(req.params.id) });
    res.status(200).json(result);
  },

  convertToInvoice: (req: Request, res: Response) =>
    respondWrite(req, res, 201,
      quickOrderService.convertToInvoice(String(req.params.id), req.user!.id)),

  convertCombined: (req: Request, res: Response) =>
    respondWrite(req, res, 201,
      quickOrderService.convertCombined(req.body?.entryIds, req.user!.id)),

  recordPayment: (req: Request, res: Response) =>
    respondWrite(req, res, 201,
      quickOrderService.recordPayment(String(req.params.id), req.body, req.user!.id)),

  /* ── claim (employee) — emits task:created so admin sees it immediately ── */
  claimOrder: (req: Request, res: Response) =>
    respondWrite(req, res, 200,
      quickOrderService.claimOrder(String(req.params.id), req.user!.id),
      "task:created"),
};