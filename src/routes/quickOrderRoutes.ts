// backend/src/routes/quickOrderRoutes.ts
import { Router } from "express";
import { protect, adminOnly } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { quickOrderController as ctrl } from "../controllers/quickOrder.controller.js";
import { taskUpload } from "../middleware/upload.js";

const router = Router();

router.use(protect);

// ── Employee + Admin accessible ──────────────────────────────────────────────
router.get("/",          asyncHandler(ctrl.listOrders));
router.get("/ledger",    asyncHandler(ctrl.ledger));
router.get("/customers", asyncHandler(ctrl.searchCustomers));
router.get("/employees", asyncHandler(ctrl.listEmployees));

router.post("/:id/claim",    asyncHandler(ctrl.claimOrder));
router.post("/:id/payment",  asyncHandler(ctrl.recordPayment)); // employee can record payment on delivery

// ── Admin only ───────────────────────────────────────────────────────────────
router.use(adminOnly);

router.post("/",                 taskUpload.array("images", 8), asyncHandler(ctrl.createOrder));
router.post("/convert-combined", asyncHandler(ctrl.convertCombined));
router.patch("/:id",             taskUpload.array("images", 8), asyncHandler(ctrl.updateOrder));
router.delete("/:id",            asyncHandler(ctrl.deleteOrder));
router.post("/:id/assign",       asyncHandler(ctrl.assignOrder));
router.post("/:id/unassign",     asyncHandler(ctrl.unassignOrder));
router.post("/:id/convert",      asyncHandler(ctrl.convertToInvoice));

export default router;