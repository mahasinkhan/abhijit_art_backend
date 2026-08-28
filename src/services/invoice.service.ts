// backend/src/services/invoice.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Invoice domain logic — pure helpers, totals, status, stock sync, PDF build and
// signed-URL generation. NO Express req/res, NO route wiring lives here (that
// stays in the controller/routes). Everything below was lifted verbatim out of
// invoiceRoutes.ts so behaviour is identical — this is a reorganisation only.
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Request } from "express";
import { siteUrl } from "../config/mailer.js";
import { buildInvoicePdf, invoiceLogoPath } from "../utils/invoicePdf.js";
import { prisma } from "../config/prisma.js";
import { inventoryService, type InvoiceStockSync } from "./inventory.service.js";

export type { InvoiceStockSync };

// ── primitives ───────────────────────────────────────────────────────────────
export const str = (v: unknown) => String(v ?? "").trim();
export const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

export const escapeHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export const escapeLines = (s: unknown) => escapeHtml(s).replace(/\r?\n/g, "<br/>");

export const rupee = (n: number) =>
  "₹" + num(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtDate = (d: string) => {
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return str(d);
  return dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

// ── types ────────────────────────────────────────────────────────────────────
export type Party = { name?: string; address?: string; phone?: string; email?: string; gstin?: string; pan?: string };
export type Line = { desc?: string; qty?: unknown; rate?: unknown; itemId?: unknown };

export const asSource = (v: unknown, fallback: "online" | "offline"): "online" | "offline" =>
  v === "online" ? "online" : v === "offline" ? "offline" : fallback;

export const asMethod = (v: unknown, fallback: "cash" | "online"): "cash" | "online" =>
  v === "cash" ? "cash" : v === "online" ? "online" : fallback;

/* normalise a line for storage — keeps an optional itemId (links the line to an
   InventoryItem so billing can auto-deduct that stock). Lines with no itemId
   are pure services and never touch inventory. Persisted on create AND edit so
   the link survives a later cancel/delete restock. */
export const mapLine = (it: Line) => {
  const line: { desc: string; qty: number; rate: number; itemId?: string } = {
    desc: str(it.desc), qty: num(it.qty), rate: num(it.rate),
  };
  const itemId = str(it.itemId);
  if (itemId) line.itemId = itemId;
  return line;
};

export const countLinked = (lines: Line[]) => lines.filter((it) => str(it.itemId)).length;

export function computeTotals(lines: Line[], discType: string | undefined, discValRaw: unknown, taxPctRaw: unknown) {
  const subtotal = lines.reduce((s, it) => s + num(it.qty) * num(it.rate), 0);
  const discVal = num(discValRaw);
  const discountAmt = discType === "percent" ? (subtotal * discVal) / 100 : Math.min(discVal, subtotal);
  const taxable = Math.max(subtotal - discountAmt, 0);
  const taxPct = num(taxPctRaw);
  const taxAmt = (taxable * taxPct) / 100;
  const total = taxable + taxAmt;
  return { subtotal, discVal, discountAmt, taxable, taxPct, taxAmt, total };
}

function deriveStatus(paid: number, total: number): "unpaid" | "partial" | "paid" {
  if (paid <= 0.005) return "unpaid";
  if (paid + 0.005 >= total) return "paid";
  return "partial";
}

const firstNameOf = (full: string) => str(full).split(/\s+/)[0] || "there";

export function defaultReminderNote(invoice: { clientName: string; business: unknown }) {
  const biz = (invoice.business || {}) as Party;
  const bizName = str(biz.name) || "Abhijit Art";
  const name = firstNameOf(invoice.clientName);
  return `Hi ${name}, this is a gentle reminder from ${bizName} about the invoice below. Whenever it's convenient, we'd appreciate it if you could clear the outstanding balance. Thank you for your business!`;
}

// ── logo resolution (shared by email + reminder) ─────────────────────────────
function resolveLogoPath(): string | null {
  if (invoiceLogoPath) return invoiceLogoPath;
  const candidates = [
    process.env.EMAIL_LOGO_FILE,
    path.resolve(process.cwd(), "assets/abhijit_art_logo.png"),
    path.resolve(process.cwd(), "../frontend/public/images/abhijit_art_logo.png"),
    path.resolve(process.cwd(), "public/images/abhijit_art_logo.png"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}
export const reminderLogoPath = resolveLogoPath();

// ── invoice recompute (paidAmount + status from its payments) ────────────────
export const withPayments = { payments: { orderBy: { createdAt: "asc" as const } } };

export async function recomputeInvoice(invoiceId: string, opts: { reactivate?: boolean } = {}) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: withPayments });
  if (!inv) return null;
  const total = Number(inv.total);
  const sum = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  const paidAmount = clamp(round2(sum), 0, total);
  const status =
    !opts.reactivate && inv.status === "cancelled" ? "cancelled" : deriveStatus(paidAmount, total);
  return prisma.invoice.update({
    where: { id: invoiceId },
    data: { paidAmount, status: status as "unpaid" | "partial" | "paid" | "cancelled" },
    include: withPayments,
  });
}

/* ── stock auto-deduct (billing) — best-effort wrappers ──
   A stock hiccup must NEVER fail or roll back the bill. But it must never be
   INVISIBLE either: a throw is returned as a stock object carrying `error`, so
   the route can hand it to the client and the Billing tab can show a warning.
   applyInvoiceStock/reverseInvoiceStock are idempotent (guarded by
   invoice.stockApplied), so calling them again is always safe. */
const stockFailure = (message: string): InvoiceStockSync => ({
  changed: false, movementCount: 0, items: [], warnings: [], unresolved: [], error: message,
});

export async function applyStockSafely(invoiceId: string, userId: string | null): Promise<InvoiceStockSync | undefined> {
  try {
    return await inventoryService.applyInvoiceStock(invoiceId, userId);
  } catch (e) {
    const msg = (e as Error).message || "Unknown stock error";
    console.error("❌ Invoice stock deduct FAILED:", msg, e);
    return stockFailure(msg);
  }
}
export async function reverseStockSafely(invoiceId: string, reason: string, userId: string | null): Promise<InvoiceStockSync | undefined> {
  try {
    return await inventoryService.reverseInvoiceStock(invoiceId, reason, userId);
  } catch (e) {
    const msg = (e as Error).message || "Unknown stock error";
    console.error("❌ Invoice stock restock FAILED:", msg, e);
    return stockFailure(msg);
  }
}

// ── PDF from a stored invoice record ─────────────────────────────────────────
type InvoiceRecord = {
  invoiceNo: string; date: Date; business: unknown;
  clientName: string; clientAddr: string | null; clientPhone: string | null;
  clientEmail: string | null; clientGstin: string | null;
  items: unknown; subtotal: unknown; discType: string; discVal: unknown;
  discountAmt: unknown; taxPct: unknown; taxAmt: unknown; total: unknown;
  paidAmount: unknown; notes: string | null; warranty: string | null;
};
export async function buildInvoicePdfFromRecord(invoice: InvoiceRecord): Promise<Buffer> {
  const biz = (invoice.business || {}) as Party;
  const items = Array.isArray(invoice.items) ? (invoice.items as Line[]) : [];
  return buildInvoicePdf({
    invNo: invoice.invoiceNo,
    date: fmtDate(invoice.date.toISOString()),
    biz,
    client: {
      name: invoice.clientName,
      address: invoice.clientAddr || "",
      phone: invoice.clientPhone || "",
      email: invoice.clientEmail || "",
      gstin: invoice.clientGstin || "",
    },
    lines: items.map((it) => ({ desc: str(it.desc), qty: num(it.qty), rate: num(it.rate) })),
    subtotal: Number(invoice.subtotal),
    discountAmt: Number(invoice.discountAmt),
    discountLabel: `Discount${invoice.discType === "percent" ? ` (${Number(invoice.discVal)}%)` : ""}`,
    taxAmt: Number(invoice.taxAmt),
    taxLabel: `GST (${Number(invoice.taxPct)}%)`,
    total: Number(invoice.total),
    paidAmount: Number(invoice.paidAmount),
    notes: invoice.notes || "",
    warranty: invoice.warranty || "",
    siteUrl: siteUrl(),
  });
}

// ── signed public-PDF link ───────────────────────────────────────────────────
const PDF_SECRET = process.env.PDF_SIGNING_SECRET || process.env.JWT_SECRET || "";

function pdfSig(invoiceId: string): string {
  return crypto.createHmac("sha256", PDF_SECRET).update(invoiceId).digest("hex").slice(0, 32);
}
export function pdfSigValid(invoiceId: string, sig: string): boolean {
  if (!PDF_SECRET || !sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(pdfSig(invoiceId));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function resolveApiBase(req: Request): string {
  const override = (process.env.PUBLIC_API_URL || process.env.API_URL || "").replace(/\/+$/, "");
  if (override) return override;
  const host = str(req.headers["x-forwarded-host"]) || str(req.headers.host);
  if (!host) return "";
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const fwdProto = str(req.headers["x-forwarded-proto"]).split(",")[0].trim();
  const proto = fwdProto || (isLocal ? "http" : "https");
  return `${proto}://${host}`;
}

export function invoicePdfUrl(req: Request, invoiceId: string): string | null {
  if (!PDF_SECRET) return null;
  const base = resolveApiBase(req);
  if (!base) return null;
  return `${base}/api/invoices/${invoiceId}/pdf?sig=${pdfSig(invoiceId)}`;
}