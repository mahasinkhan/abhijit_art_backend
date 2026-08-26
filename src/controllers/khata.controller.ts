// backend/src/controllers/khata.controller.ts
/**
 * Quick Orders (Khata) controller — thin layer between routes and service.
 *
 * Each handler: pull from req → call khataService → respond (and log audit
 * for writes). No try/catch, no business logic. Anything the service throws
 * (ApiError) propagates to asyncHandler in the routes → central errorHandler.
 * Audit lives here (needs req for actor + ip); the service hands back an
 * `audit` descriptor and respondWrite records it.
 */
import type { Request, Response } from "express";
import { khataService, type AuditInfo } from "../services/khata.service.js";
import { logAudit } from "../utils/security.js";

/* run a service WRITE: await { result, audit }, log it, respond with `status` */
async function respondWrite(
  req: Request,
  res: Response,
  status: number,
  work: Promise<{ result: unknown; audit: AuditInfo }>,
): Promise<void> {
  const { result, audit } = await work;
  await logAudit({ req, entity: "khata", ...audit });
  res.status(status).json(result);
}

export const khataController = {
  /* ── reads ── */
  listEntries: async (req: Request, res: Response) => {
    res.json(
      await khataService.listEntries({
        date: req.query.date as string | undefined,
        customerId: req.query.customerId as string | undefined,
      }),
    );
  },

  ledger: async (req: Request, res: Response) => {
    res.json(
      await khataService.ledger({
        date: req.query.date as string | undefined,
      }),
    );
  },

  searchCustomers: async (req: Request, res: Response) => {
    res.json(
      await khataService.searchCustomers(
        String(req.query.q || ""),
        Number(req.query.take) || 8,
      ),
    );
  },

  /* ── writes ── */
  createEntry: (req: Request, res: Response) =>
    respondWrite(req, res, 201, khataService.createEntry(req.body, req.user!.id)),

  updateEntry: (req: Request, res: Response) =>
    respondWrite(req, res, 200, khataService.updateEntry(String(req.params.id), req.body)),

  deleteEntry: (req: Request, res: Response) =>
    respondWrite(req, res, 200, khataService.deleteEntry(String(req.params.id))),

  convertToInvoice: (req: Request, res: Response) =>
    respondWrite(req, res, 201, khataService.convertToInvoice(String(req.params.id), req.user!.id)),

  convertCombined: (req: Request, res: Response) =>
    respondWrite(req, res, 201, khataService.convertCombined(req.body?.entryIds, req.user!.id)),
};