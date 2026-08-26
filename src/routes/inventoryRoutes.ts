// backend/src/routes/inventoryRoutes.ts
/**
 * Inventory routes — thin. Each line maps a path to its controller, with the
 * cross-cutting concerns as middleware:
 *   • protect + adminOnly  → the whole module is admin-only (applied once)
 *   • requirePin           → on every state-changing (write) route
 *   • asyncHandler         → forwards any thrown ApiError to the central handler
 *
 * All the logic lives in inventory.controller.ts (parse/respond) and
 * inventory.service.ts (business logic + Prisma). This file just wires them.
 */
import { Router } from "express";
import { protect, adminOnly } from "../middleware/auth.js";
import { requirePin } from "../middleware/requirePin.js";
import { asyncHandler } from "../middleware/error.js";
import { inventoryController as ctrl } from "../controllers/inventory.controller.js";

const router = Router();

/* every inventory route is admin-only */
router.use(protect, adminOnly);

/* ── items ── */
router.get("/items", asyncHandler(ctrl.listItems));
router.post("/items", requirePin, asyncHandler(ctrl.createItem));
router.get("/items/:id", asyncHandler(ctrl.getItem));
router.patch("/items/:id", requirePin, asyncHandler(ctrl.updateItem));
router.delete("/items/:id", requirePin, asyncHandler(ctrl.deleteItem));
router.post("/items/:id/move", requirePin, asyncHandler(ctrl.moveStock));

/* ── meta / reporting ── */
router.get("/summary", asyncHandler(ctrl.summary));
router.get("/dashboard", asyncHandler(ctrl.dashboard));
router.get("/categories", asyncHandler(ctrl.categories));
router.get("/movements", asyncHandler(ctrl.movements));

/* ── item prices (multi-supplier) ── */
router.get("/items/:id/prices", asyncHandler(ctrl.listItemPrices));
router.post("/items/:id/prices", requirePin, asyncHandler(ctrl.setItemPrice));
router.delete("/items/:id/prices/:priceId", requirePin, asyncHandler(ctrl.deleteItemPrice));

/* ── suppliers ── */
router.get("/suppliers", asyncHandler(ctrl.listSuppliers));
router.post("/suppliers", requirePin, asyncHandler(ctrl.createSupplier));
router.patch("/suppliers/:id", requirePin, asyncHandler(ctrl.updateSupplier));
router.delete("/suppliers/:id", requirePin, asyncHandler(ctrl.deleteSupplier));
router.get("/suppliers/:id/statement", asyncHandler(ctrl.statement));
router.post("/suppliers/:id/payments", requirePin, asyncHandler(ctrl.recordPayment));
router.delete("/suppliers/:id/payments/:paymentId", requirePin, asyncHandler(ctrl.deletePayment));

/* ── purchases ── */
router.post("/purchases", requirePin, asyncHandler(ctrl.createPurchase));
router.get("/purchases/:id", asyncHandler(ctrl.getPurchase));

export default router;