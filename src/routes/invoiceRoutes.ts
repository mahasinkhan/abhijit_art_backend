// backend/src/routes/invoiceRoutes.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pure route wiring. Every handler lives in ../controllers/invoice.controller.ts;
// the domain logic those handlers call lives in ../services/invoice.service.ts.
//   routes  →  controller  →  service
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { protect, adminOnly } from "../middleware/auth.js";
import * as invoice from "../controllers/invoice.controller.js";

const router = Router();

// ── PUBLIC — signed PDF link, no auth ──
router.get("/:id/pdf", invoice.getPublicPdf);

// ── everything below requires an admin session ──
router.use(protect, adminOnly);

router.post("/email", invoice.emailInvoice);
router.post("/", invoice.saveInvoice);
router.get("/", invoice.listInvoices);
router.get("/:id", invoice.getInvoice);
router.post("/:id/stock-retry", invoice.retryStock);
router.post("/:id/remind", invoice.remindInvoice);
router.patch("/:id/edit", invoice.editInvoice);
router.post("/:id/payments", invoice.recordPayment);
router.delete("/:id/payments/:paymentId", invoice.deletePayment);
router.patch("/:id/status", invoice.setInvoiceStatus);
router.delete("/:id", invoice.deleteInvoice);

export default router;
