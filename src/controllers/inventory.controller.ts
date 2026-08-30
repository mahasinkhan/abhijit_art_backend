// backend/src/controllers/inventory.controller.ts
/**
 * Inventory controller — the thin layer between the routes and the service.
 *
 * Each handler does three things and no more:
 *   1. pull what it needs off req (params / query / body / user),
 *   2. call the matching inventoryService function,
 *   3. respond — and, for writes, log the audit trail.
 *
 * There is no try/catch and no business logic here. Anything the service
 * throws (ApiError) propagates out and is caught by asyncHandler in the routes,
 * which forwards it to the central errorHandler. The audit log lives here,
 * not in the service, because it needs the request (actor + ip); the service
 * hands back an `audit` descriptor and respondWrite records it.
 */
import type { Request, Response } from "express";
import { inventoryService, type AuditInfo } from "../services/inventory.service.js";
import { logAudit } from "../utils/security.js";

/* run a service WRITE: await { result, audit }, log it, respond with `status` */
async function respondWrite(
  req: Request,
  res: Response,
  status: number,
  work: Promise<{ result: unknown; audit: AuditInfo }>,
): Promise<void> {
  const { result, audit } = await work;
  await logAudit({ req, entity: "inventory", ...audit });
  res.status(status).json(result);
}

export const inventoryController = {
  /* ── items ── */
  listItems: async (req: Request, res: Response) => {
    const active = req.query.active;
    res.json(
      await inventoryService.listItems({
        q: String(req.query.q || ""),
        category: String(req.query.category || ""),
        low: String(req.query.low || "") === "1",
        active: active === "true" ? true : active === "false" ? false : undefined,
      }),
    );
  },

  getItem: async (req: Request, res: Response) => {
    res.json(await inventoryService.getItem(String(req.params.id)));
  },

  createItem: (req: Request, res: Response) =>
    respondWrite(req, res, 201, inventoryService.createItem(req.body, req.user!.id)),

  updateItem: (req: Request, res: Response) =>
    respondWrite(req, res, 200, inventoryService.updateItem(String(req.params.id), req.body)),

  deleteItem: (req: Request, res: Response) =>
    respondWrite(req, res, 200, inventoryService.deleteItem(String(req.params.id))),

  moveStock: (req: Request, res: Response) =>
    respondWrite(req, res, 201, inventoryService.moveStock(String(req.params.id), req.body, req.user!.id)),

  /* ── meta / reporting ── */
  summary: async (_req: Request, res: Response) => {
    res.json(await inventoryService.summary());
  },

  dashboard: async (req: Request, res: Response) => {
    res.json(
      await inventoryService.dashboard({
        granularity: (req.query.granularity ?? req.query.gran) as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
      }),
    );
  },

  categories: async (_req: Request, res: Response) => {
    res.json(await inventoryService.categories());
  },

  renameCategory: async (req: Request, res: Response) => {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) {
      res.status(400).json({ error: "oldName and newName are required" });
      return;
    }
    const result = await inventoryService.renameCategory(String(oldName), String(newName));
    await logAudit({ req, entity: "inventory", action: "rename_category", summary: `Renamed category "${oldName}" → "${newName}"`, detail: `${oldName} → ${newName}` });
    res.json(result);
  },

  movements: async (req: Request, res: Response) => {
    res.json(await inventoryService.movements(Number(req.query.limit) || 50));
  },

  /* ── item prices (multi-supplier) ── */
  listItemPrices: async (req: Request, res: Response) => {
    res.json(await inventoryService.listItemPrices(String(req.params.id)));
  },

  setItemPrice: (req: Request, res: Response) =>
    respondWrite(req, res, 201, inventoryService.setItemPrice(String(req.params.id), req.body)),

  deleteItemPrice: (req: Request, res: Response) =>
    respondWrite(req, res, 200, inventoryService.deleteItemPrice(String(req.params.id), String(req.params.priceId))),

  /* ── suppliers ── */
  listSuppliers: async (_req: Request, res: Response) => {
    res.json(await inventoryService.listSuppliers());
  },

  createSupplier: (req: Request, res: Response) =>
    respondWrite(req, res, 201, inventoryService.createSupplier(req.body)),

  updateSupplier: (req: Request, res: Response) =>
    respondWrite(req, res, 200, inventoryService.updateSupplier(String(req.params.id), req.body)),

  deleteSupplier: (req: Request, res: Response) =>
    respondWrite(req, res, 200, inventoryService.deleteSupplier(String(req.params.id))),

  statement: async (req: Request, res: Response) => {
    res.json(await inventoryService.statement(String(req.params.id), Number(req.query.limit) || 200));
  },

  recordPayment: (req: Request, res: Response) =>
    respondWrite(req, res, 201, inventoryService.recordPayment(String(req.params.id), req.body, req.user!.id)),

  deletePayment: (req: Request, res: Response) =>
    respondWrite(req, res, 200, inventoryService.deletePayment(String(req.params.id), String(req.params.paymentId))),

  /* ── purchases ── */
  createPurchase: (req: Request, res: Response) =>
    respondWrite(req, res, 201, inventoryService.createPurchase(req.body, req.user!.id)),

  getPurchase: async (req: Request, res: Response) => {
    res.json(await inventoryService.getPurchase(String(req.params.id)));
  },
};