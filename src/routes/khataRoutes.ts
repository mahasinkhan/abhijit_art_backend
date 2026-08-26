// backend/src/routes/khataRoutes.ts
/**
 * Quick Orders (Khata) routes — thin. Maps each path to its controller with
 * the cross-cutting concerns as middleware:
 *   • protect + adminOnly  → whole module is admin-only (applied once)
 *   • asyncHandler         → forwards any thrown ApiError to the central handler
 *
 * Logic lives in khata.controller.ts (parse/respond) and khata.service.ts
 * (business logic + Prisma). This file just wires them.
 *
 * NOTE: not PIN-gated — orders are day-to-day intake, not money mutations.
 * (Deletes/edits are already blocked on billed orders in the service.)
 */
import { Router } from "express";
import { protect, adminOnly } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { khataController as ctrl } from "../controllers/khata.controller.js";

const router = Router();

/* every route is admin-only */
router.use(protect, adminOnly);

/* ── reads ── */
router.get("/",          asyncHandler(ctrl.listEntries));
router.get("/ledger",    asyncHandler(ctrl.ledger));
router.get("/customers", asyncHandler(ctrl.searchCustomers));

/* ── writes ── */
router.post("/",                 asyncHandler(ctrl.createEntry));
router.post("/convert-combined", asyncHandler(ctrl.convertCombined));   // before "/:id" routes
router.patch("/:id",             asyncHandler(ctrl.updateEntry));
router.delete("/:id",            asyncHandler(ctrl.deleteEntry));
router.post("/:id/convert",      asyncHandler(ctrl.convertToInvoice));

export default router;