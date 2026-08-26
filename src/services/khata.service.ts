// backend/src/services/khata.service.ts
/**
 * Quick Orders (Khata) service — business logic + Prisma access.
 *
 * Mirrors the inventory service shape: pure async functions, no Express.
 * Writes return { result, audit } so the controller can log the audit trail
 * (which needs req for actor/ip). Reads return plain payloads.
 *
 * Key feature: order items may carry an optional `itemId` linking them to an
 * InventoryItem. When an order is converted to an invoice, that itemId flows
 * into the invoice's items JSON, and inventoryService.applyInvoiceStock()
 * consumes the linked stock automatically (best-effort, non-fatal).
 */
import type { Prisma } from "@prisma/client";
import crypto from "node:crypto";
import { prisma } from "../config/prisma.js";
import { ApiError } from "../middleware/error.js";
import { inventoryService, type InvoiceStockSync } from "./inventory.service.js";

/* audit descriptor a write returns for the controller to log */
export interface AuditInfo {
  action: string;
  entityId?: string;
  entityRef?: string;
  summary: string;
  detail?: unknown;
}
interface Write<T> { result: T; audit: AuditInfo; }

/* ── input shapes ── */
export interface OrderItemInput { itemId?: string | null; desc?: string; qty?: unknown; rate?: unknown; unit?: string; }
export interface EntriesFilter { date?: string; customerId?: string; }
export interface CreateEntryBody {
  customerId?: string | null; customerName?: string; customerPhone?: string; customerEmail?: string;
  items?: OrderItemInput[]; description?: string; amount?: unknown; advancePaid?: unknown;
  paymentMethod?: string; entryDate?: string;
}
export interface UpdateEntryBody extends CreateEntryBody {}

/* ── pure helpers ── */
const toDecimal = (v: unknown) => {
  const n = parseFloat(String(v ?? "0"));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const normPhone = (v: unknown) =>
  String(v ?? "").replace(/[\s\-()]/g, "").replace(/^\+91/, "").replace(/^0+/, "");

/* normalise an item line: keep itemId link if present, coerce numbers */
const cleanItem = (raw: OrderItemInput) => {
  const desc = String(raw?.desc ?? "").trim();
  const qty  = toDecimal(raw?.qty);
  const rate = toDecimal(raw?.rate);
  const itemId = raw?.itemId ? String(raw.itemId).trim() : null;
  const unit = raw?.unit ? String(raw.unit).trim() : undefined;
  return { itemId, desc, qty, rate, ...(unit ? { unit } : {}) };
};

const TX_OPTS = { maxWait: 15_000, timeout: 30_000 } as const;

/* Ensure a customer (User role "client") exists; create if missing. Never throws. */
async function ensureCustomer(client: { name?: unknown; phone?: unknown; email?: unknown }) {
  try {
    const name = String(client.name ?? "").trim();
    const phone = String(client.phone ?? "").trim();
    const email = String(client.email ?? "").trim().toLowerCase();
    const np = normPhone(phone);
    if (!name && !np && !email) return;

    let existing: null | { id: string } = null;
    if (email && isEmail(email)) existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!existing && np) {
      const clients = await prisma.user.findMany({ where: { role: "client" }, select: { id: true, phone: true } });
      const hit = clients.find((c) => normPhone(c.phone) && normPhone(c.phone) === np);
      if (hit) existing = { id: hit.id };
    }
    if (existing) return;

    const safeEmail = email && isEmail(email) ? email : `cust-${np || crypto.randomBytes(5).toString("hex")}@noemail.abhijitart`;
    const clash = await prisma.user.findUnique({ where: { email: safeEmail }, select: { id: true } });
    if (clash) return;

    await prisma.user.create({
      data: {
        name: name || "Walk-in customer",
        email: safeEmail,
        phone: phone || "",
        source: "offline" as any,
        notes: "Auto-added from Quick Orders",
        password: `nologin:${crypto.randomBytes(24).toString("hex")}`,
      },
    });
  } catch (e) { console.error("ensureCustomer (khata) failed:", e); }
}

/* Business settings block used on every generated invoice */
async function businessBlock() {
  const settings = await prisma.setting.findMany({
    where: { key: { in: ["businessName","businessPhone","businessAddress","businessEmail","businessGstin","businessPan"] } },
  });
  const s: Record<string, string> = {};
  settings.forEach((st) => { s[st.key] = st.value; });
  return {
    name:    s.businessName    || "Abhijit Art",
    phone:   s.businessPhone   || "7405179066",
    address: s.businessAddress || "Rabindra Sadan, Shakti Mandir Club, SS Sen Road Berhampore, West Bengal - 742101",
    email:   s.businessEmail   || "abhijitart85@gmail.com",
    gstin:   s.businessGstin   || "19AQFPD8346K1ZH",
    pan:     s.businessPan     || "AQFPD8346K",
  };
}

/* Sequential invoice number AA-YYMMDD-NNN (count-based, inside caller's flow) */
async function nextInvoiceNo(): Promise<string> {
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, "0");
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const yy = String(today.getFullYear()).slice(-2);
  const count = await prisma.invoice.count();
  return `AA-${yy}${mm}${dd}-${String(count + 1).padStart(3, "0")}`;
}

/* status from paid vs total */
const deriveStatus = (paid: number, total: number) =>
  paid >= total && total > 0 ? "paid" : paid > 0 ? "partial" : "unpaid";

/* ═══════════════════════════════ service ═══════════════════════════════ */

export const khataService = {

  /* ── entries (date-scoped, naturally bounded) ── */
  async listEntries(filter: EntriesFilter) {
    const where: Prisma.KhataEntryWhereInput = {};
    if (filter.date) {
      const d = new Date(String(filter.date));
      const start = new Date(d); start.setHours(0, 0, 0, 0);
      const end   = new Date(d); end.setHours(23, 59, 59, 999);
      where.entryDate = { gte: start, lte: end };
    }
    if (filter.customerId) where.customerId = String(filter.customerId);
    return prisma.khataEntry.findMany({ where, orderBy: { entryDate: "desc" } });
  },

  /* ── ledger (per-customer rollups; bounded by customer count) ── */
  async ledger(filter: EntriesFilter) {
    const where: Prisma.KhataEntryWhereInput = {};
    if (filter.date) {
      const d = new Date(String(filter.date));
      const start = new Date(d); start.setHours(0, 0, 0, 0);
      const end   = new Date(d); end.setHours(23, 59, 59, 999);
      where.entryDate = { gte: start, lte: end };
    }

    const rows = await prisma.khataEntry.groupBy({
      by: ["customerId", "customerName", "customerPhone"],
      where,
      _sum: { amount: true, advancePaid: true },
      _count: { id: true },
      orderBy: { _sum: { amount: "desc" } },
    });

    const unbilled = await prisma.khataEntry.groupBy({
      by: ["customerId", "customerName", "customerPhone"],
      where: { ...where, status: { not: "billed" } },
      _count: { id: true },
    });
    const keyOf = (cid: string | null, name: string, phone: string) => `${cid || ""}|${name}|${phone || ""}`;
    const unbilledMap = new Map<string, number>();
    unbilled.forEach((u) => unbilledMap.set(keyOf(u.customerId, u.customerName, u.customerPhone), u._count.id));

    return rows.map((r) => ({
      customerId:    r.customerId,
      customerName:  r.customerName,
      customerPhone: r.customerPhone,
      totalOrders:   r._count.id,
      unbilledCount: unbilledMap.get(keyOf(r.customerId, r.customerName, r.customerPhone)) || 0,
      totalAmount:   Number(r._sum.amount ?? 0),
      totalAdvance:  Number(r._sum.advancePaid ?? 0),
      totalDue:      Math.max(0, Number(r._sum.amount ?? 0) - Number(r._sum.advancePaid ?? 0)),
    }));
  },

  /* ── scalable customer search for the entry picker ── */
  async searchCustomers(q: string, take = 8) {
    const query = q.trim();
    const where: Prisma.UserWhereInput = { role: "client" };
    if (query) {
      where.OR = [
        { name:  { contains: query, mode: "insensitive" } },
        { phone: { contains: query } },
        { email: { contains: query, mode: "insensitive" } },
      ];
    }
    const users = await prisma.user.findMany({
      where,
      select: { id: true, name: true, phone: true, email: true },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(take, 1), 20),
    });
    return users.map((u) => ({ id: u.id, name: u.name, phone: u.phone || "", email: u.email || "" }));
  },

  /* ── create ── */
  async createEntry(body: CreateEntryBody, userId: string): Promise<Write<unknown>> {
    if (!String(body.customerName || "").trim()) throw ApiError.badRequest("Customer name is required.");
    const items = Array.isArray(body.items) ? body.items.map(cleanItem).filter((it) => it.desc) : [];
    if (items.length === 0) throw ApiError.badRequest("Add at least one item.");

    const amount = toDecimal(body.amount) || items.reduce((s, it) => s + it.qty * it.rate, 0);

    const entry = await prisma.khataEntry.create({
      data: {
        customerId:    body.customerId?.trim() || null,
        customerName:  String(body.customerName).trim(),
        customerPhone: body.customerPhone?.trim() || "",
        customerEmail: body.customerEmail?.trim() || "",
        items:         items as any,
        description:   body.description?.trim() || "",
        amount:        amount,
        advancePaid:   toDecimal(body.advancePaid),
        paymentMethod: body.paymentMethod === "online" ? "online" : "cash",
        entryDate:     body.entryDate ? new Date(body.entryDate) : new Date(),
        createdById:   userId,
      },
    });

    return {
      result: entry,
      audit: {
        action: "khata.entry.create",
        entityId: entry.id,
        entityRef: entry.customerName,
        summary: `New order for ${entry.customerName} · ₹${amount.toFixed(2)} · ${items.length} item${items.length === 1 ? "" : "s"}`,
        detail: { amount, itemCount: items.length, linked: items.filter((i) => i.itemId).length },
      },
    };
  },

  /* ── update (unbilled only) ── */
  async updateEntry(id: string, body: UpdateEntryBody): Promise<Write<unknown>> {
    const existing = await prisma.khataEntry.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Order not found.");
    if (existing.status === "billed") throw ApiError.badRequest("Cannot edit a billed order.");

    const data: Prisma.KhataEntryUpdateInput = {};
    if (body.customerName  !== undefined) data.customerName  = String(body.customerName).trim();
    if (body.customerPhone !== undefined) data.customerPhone = body.customerPhone?.trim() || "";
    if (body.customerEmail !== undefined) data.customerEmail = body.customerEmail?.trim() || "";
    if (body.description   !== undefined) data.description   = body.description?.trim() || "";
    if (body.advancePaid   !== undefined) data.advancePaid   = toDecimal(body.advancePaid);
    if (body.paymentMethod !== undefined) data.paymentMethod = body.paymentMethod === "online" ? "online" : "cash";
    if (body.entryDate     !== undefined) data.entryDate     = new Date(body.entryDate);
    if (body.items !== undefined) {
      const items = Array.isArray(body.items) ? body.items.map(cleanItem).filter((it) => it.desc) : [];
      data.items  = items as any;
      data.amount = toDecimal(body.amount) || items.reduce((s, it) => s + it.qty * it.rate, 0);
    } else if (body.amount !== undefined) {
      data.amount = toDecimal(body.amount);
    }

    const updated = await prisma.khataEntry.update({ where: { id }, data });
    return {
      result: updated,
      audit: {
        action: "khata.entry.update",
        entityId: updated.id,
        entityRef: updated.customerName,
        summary: `Edited order for ${updated.customerName}`,
      },
    };
  },

  /* ── delete (unbilled only) ── */
  async deleteEntry(id: string): Promise<Write<{ ok: true }>> {
    const existing = await prisma.khataEntry.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Order not found.");
    if (existing.status === "billed") throw ApiError.badRequest("Cannot delete a billed order.");
    await prisma.khataEntry.delete({ where: { id } });
    return {
      result: { ok: true },
      audit: {
        action: "khata.entry.delete",
        entityId: existing.id,
        entityRef: existing.customerName,
        summary: `Deleted order for ${existing.customerName}`,
      },
    };
  },

  /* ── convert ONE order → invoice (+ auto stock consume) ── */
  async convertToInvoice(id: string, userId: string): Promise<Write<{ invoice: unknown; invoiceNo: string; stock: InvoiceStockSync }>> {
    const entry = await prisma.khataEntry.findUnique({ where: { id } });
    if (!entry) throw ApiError.notFound("Order not found.");
    if (entry.status === "billed") throw ApiError.badRequest("Already converted to an invoice.");

    const business = await businessBlock();
    const items = (entry.items ?? []) as any[];               // carry itemId for stock consumption
    const subtotal = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0);
    const advance = Number(entry.advancePaid);

    const { invoice, invoiceNo } = await prisma.$transaction(async (tx) => {
      const invoiceNo = await (async () => {
        const count = await tx.invoice.count();
        const today = new Date();
        const dd = String(today.getDate()).padStart(2, "0");
        const mm = String(today.getMonth() + 1).padStart(2, "0");
        const yy = String(today.getFullYear()).slice(-2);
        return `AA-${yy}${mm}${dd}-${String(count + 1).padStart(3, "0")}`;
      })();

      const invoice = await tx.invoice.create({
        data: {
          invoiceNo,
          date:        entry.entryDate,
          clientName:  entry.customerName,
          clientPhone: entry.customerPhone || null,
          clientEmail: entry.customerEmail || null,
          source:      "offline",
          business,
          items:       items as any,
          discType:    "amount",
          discVal:     0,
          taxPct:      0,
          subtotal,
          discountAmt: 0,
          taxAmt:      0,
          total:       subtotal,
          paidAmount:  advance,
          status:      deriveStatus(advance, subtotal),
          notes:       "Keep the invoices for Future References",
          createdById: userId,
        },
      });

      if (advance > 0) {
        await tx.payment.create({
          data: { invoiceId: invoice.id, amount: entry.advancePaid, method: entry.paymentMethod, note: "Advance from Quick Orders", createdById: userId },
        });
      }

      await tx.khataEntry.update({ where: { id: entry.id }, data: { status: "billed", invoiceId: invoice.id, invoiceNo } });
      return { invoice, invoiceNo };
    }, TX_OPTS);

    // Auto-add customer + consume linked stock — best-effort, outside the tx (non-fatal)
    await ensureCustomer({ name: entry.customerName, phone: entry.customerPhone, email: entry.customerEmail });
    let stock: InvoiceStockSync = { changed: false, movementCount: 0, items: [], warnings: [] };
    try { stock = await inventoryService.applyInvoiceStock(invoice.id, userId); }
    catch (e) { console.error("applyInvoiceStock (khata convert) failed:", e); }

    return {
      result: { invoice, invoiceNo, stock },
      audit: {
        action: "khata.convert",
        entityId: entry.id,
        entityRef: entry.customerName,
        summary: `Order → invoice ${invoiceNo} for ${entry.customerName} · ₹${subtotal.toFixed(2)}${stock.movementCount ? ` · ${stock.movementCount} item(s) consumed` : ""}`,
        detail: { invoiceNo, subtotal, stockConsumed: stock.movementCount, warnings: stock.warnings.length },
      },
    };
  },

  /* ── convert MANY unbilled orders (same customer) → ONE invoice ── */
  async convertCombined(entryIds: string[], userId: string): Promise<Write<{ invoice: unknown; invoiceNo: string; mergedCount: number; stock: InvoiceStockSync }>> {
    if (!Array.isArray(entryIds) || entryIds.length === 0) throw ApiError.badRequest("No orders selected.");

    const entries = await prisma.khataEntry.findMany({ where: { id: { in: entryIds } } });
    const unbilled = entries.filter((e) => e.status !== "billed");
    if (unbilled.length === 0) throw ApiError.badRequest("All selected orders are already invoiced.");

    const first = unbilled[0];
    const sameCustomer = unbilled.every((e) => e.customerName === first.customerName && (e.customerPhone || "") === (first.customerPhone || ""));
    if (!sameCustomer) throw ApiError.badRequest("Orders belong to different customers.");

    const business = await businessBlock();

    // merge items across entries — PRESERVE itemId so stock consumption works
    const mergedItems: any[] = [];
    let totalAdvance = 0;
    for (const e of unbilled) {
      const its = (e.items ?? []) as any[];
      for (const it of its) mergedItems.push({ itemId: it.itemId ?? null, desc: it.desc, qty: Number(it.qty) || 0, rate: Number(it.rate) || 0, ...(it.unit ? { unit: it.unit } : {}) });
      totalAdvance += Number(e.advancePaid) || 0;
    }
    const subtotal = mergedItems.reduce((s, it) => s + it.qty * it.rate, 0);
    const latest = unbilled.reduce((a, b) => (a.entryDate > b.entryDate ? a : b));

    const { invoice, invoiceNo } = await prisma.$transaction(async (tx) => {
      const invoiceNo = await (async () => {
        const count = await tx.invoice.count();
        const today = new Date();
        const dd = String(today.getDate()).padStart(2, "0");
        const mm = String(today.getMonth() + 1).padStart(2, "0");
        const yy = String(today.getFullYear()).slice(-2);
        return `AA-${yy}${mm}${dd}-${String(count + 1).padStart(3, "0")}`;
      })();

      const invoice = await tx.invoice.create({
        data: {
          invoiceNo,
          date:        latest.entryDate,
          clientName:  first.customerName,
          clientPhone: first.customerPhone || null,
          clientEmail: first.customerEmail || null,
          source:      "offline",
          business,
          items:       mergedItems as any,
          discType:    "amount",
          discVal:     0,
          taxPct:      0,
          subtotal,
          discountAmt: 0,
          taxAmt:      0,
          total:       subtotal,
          paidAmount:  totalAdvance,
          status:      deriveStatus(totalAdvance, subtotal),
          notes:       "Keep the invoices for Future References",
          createdById: userId,
        },
      });

      if (totalAdvance > 0) {
        await tx.payment.create({
          data: { invoiceId: invoice.id, amount: totalAdvance, method: latest.paymentMethod, note: `Combined advance from ${unbilled.length} orders`, createdById: userId },
        });
      }

      await tx.khataEntry.updateMany({ where: { id: { in: unbilled.map((e) => e.id) } }, data: { status: "billed", invoiceId: invoice.id, invoiceNo } });
      return { invoice, invoiceNo };
    }, TX_OPTS);

    await ensureCustomer({ name: first.customerName, phone: first.customerPhone, email: first.customerEmail });
    let stock: InvoiceStockSync = { changed: false, movementCount: 0, items: [], warnings: [] };
    try { stock = await inventoryService.applyInvoiceStock(invoice.id, userId); }
    catch (e) { console.error("applyInvoiceStock (khata combined) failed:", e); }

    return {
      result: { invoice, invoiceNo, mergedCount: unbilled.length, stock },
      audit: {
        action: "khata.convert.combined",
        entityId: invoice.id,
        entityRef: first.customerName,
        summary: `${unbilled.length} orders → invoice ${invoiceNo} for ${first.customerName} · ₹${subtotal.toFixed(2)}${stock.movementCount ? ` · ${stock.movementCount} item(s) consumed` : ""}`,
        detail: { invoiceNo, mergedCount: unbilled.length, subtotal, stockConsumed: stock.movementCount },
      },
    };
  },
};

export type KhataService = typeof khataService;