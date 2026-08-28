// backend/src/services/quickOrder.service.ts
import type { Prisma } from "@prisma/client";
import crypto from "node:crypto";
import { prisma } from "../config/prisma.js";
import { ApiError } from "../middleware/error.js";
import { inventoryService, type InvoiceStockSync } from "./inventory.service.js";

export interface AuditInfo {
  action: string; entityId?: string; entityRef?: string; summary: string; detail?: unknown;
}
interface Write<T> { result: T; audit: AuditInfo; }

export interface OrderItemInput {
  itemId?: string | null; desc?: string; qty?: unknown; rate?: unknown; unit?: string;
}
export interface OrdersFilter { date?: string; customerId?: string; }
export interface CreateOrderBody {
  customerId?:    string | null;
  customerName?:  string;
  customerPhone?: string;
  customerEmail?: string;
  whatsapp?:      string;   // NEW
  title?:         string;   // NEW
  workDetails?:   string;
  items?:         OrderItemInput[];
  description?:   string;
  amount?:        unknown;
  advancePaid?:   unknown;
  paymentMethod?: string;
  entryDate?:     string;
  assignToId?:    string;
  priority?:      string;
  deadline?:      string;
  images?:        string[];  // uploaded file paths
}
export interface UpdateOrderBody extends CreateOrderBody {}
export interface AssignBody {
  assignToId: string; priority?: string; deadline?: string; notes?: string;
}

const toDecimal = (v: unknown) => {
  const n = parseFloat(String(v ?? "0"));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const normPhone = (v: unknown) =>
  String(v ?? "").replace(/[\s\-()]/g, "").replace(/^\+91/, "").replace(/^0+/, "");
const cleanItem = (raw: OrderItemInput) => {
  const desc   = String(raw?.desc ?? "").trim();
  const qty    = toDecimal(raw?.qty);
  const rate   = toDecimal(raw?.rate);
  const itemId = raw?.itemId ? String(raw.itemId).trim() : null;
  const unit   = raw?.unit ? String(raw.unit).trim() : undefined;
  return { itemId, desc, qty, rate, ...(unit ? { unit } : {}) };
};
const asTaskPriority = (v: unknown): "low" | "medium" | "high" | "urgent" => {
  const s = String(v || "").toLowerCase();
  if (s === "low" || s === "high" || s === "urgent") return s;
  return "medium";
};
const TX_OPTS = { maxWait: 15_000, timeout: 30_000 } as const;
const withTask = {
  task: { include: { assignedTo: { select: { id: true, name: true, role: true } }, createdBy: { select: { id: true, name: true } }, deliveredBy: { select: { id: true, name: true } } } },
  payments: { orderBy: { createdAt: "asc" as const }, include: { createdBy: { select: { id: true, name: true } } } },
} as const;

async function ensureCustomer(client: { name?: unknown; phone?: unknown; email?: unknown }) {
  try {
    const name  = String(client.name  ?? "").trim();
    const phone = String(client.phone ?? "").trim();
    const email = String(client.email ?? "").trim().toLowerCase();
    const np    = normPhone(phone);
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
    await prisma.user.create({ data: { name: name || "Walk-in customer", email: safeEmail, phone: phone || "", source: "offline" as any, notes: "Auto-added from Quick Orders", password: `nologin:${crypto.randomBytes(24).toString("hex")}` } });
  } catch (e) { console.error("ensureCustomer failed:", e); }
}

async function businessBlock() {
  const settings = await prisma.setting.findMany({ where: { key: { in: ["businessName","businessPhone","businessAddress","businessEmail","businessGstin","businessPan"] } } });
  const s: Record<string, string> = {};
  settings.forEach((st) => { s[st.key] = st.value; });
  return { name: s.businessName || "Abhijit Art", phone: s.businessPhone || "7405179066", address: s.businessAddress || "Rabindra Sadan, Shakti Mandir Club, SS Sen Road Berhampore, West Bengal - 742101", email: s.businessEmail || "abhijitart85@gmail.com", gstin: s.businessGstin || "19AQFPD8346K1ZH", pan: s.businessPan || "AQFPD8346K" };
}

const deriveStatus = (paid: number, total: number) => paid >= total && total > 0 ? "paid" : paid > 0 ? "partial" : "unpaid";

const taskTitle = (order: { customerName: string; workDetails: string; title?: string | null }) => {
  if (order.title) return `${order.customerName} — ${order.title}`;
  const work = order.workDetails.slice(0, 60);
  return `${order.customerName} — ${work}${order.workDetails.length > 60 ? "…" : ""}`;
};

export const quickOrderService = {

  async listOrders(filter: OrdersFilter) {
    const where: Prisma.QuickOrderWhereInput = {};
    if (filter.date) {
      const d = new Date(String(filter.date));
      const start = new Date(d); start.setHours(0, 0, 0, 0);
      const end   = new Date(d); end.setHours(23, 59, 59, 999);
      where.entryDate = { gte: start, lte: end };
    }
    if (filter.customerId) where.customerId = String(filter.customerId);
    return prisma.quickOrder.findMany({ where, orderBy: { entryDate: "desc" }, include: withTask });
  },

  async ledger(filter: OrdersFilter) {
    const where: Prisma.QuickOrderWhereInput = {};
    if (filter.date) {
      const d = new Date(String(filter.date));
      const start = new Date(d); start.setHours(0, 0, 0, 0);
      const end   = new Date(d); end.setHours(23, 59, 59, 999);
      where.entryDate = { gte: start, lte: end };
    }
    const rows = await prisma.quickOrder.groupBy({ by: ["customerId", "customerName", "customerPhone"], where, _sum: { amount: true, advancePaid: true }, _count: { id: true }, orderBy: { _sum: { amount: "desc" } } });
    const unbilled = await prisma.quickOrder.groupBy({ by: ["customerId", "customerName", "customerPhone"], where: { ...where, status: { not: "billed" } }, _count: { id: true } });
    const keyOf = (cid: string | null, name: string, phone: string) => `${cid || ""}|${name}|${phone || ""}`;
    const unbilledMap = new Map<string, number>();
    unbilled.forEach((u) => unbilledMap.set(keyOf(u.customerId, u.customerName, u.customerPhone), u._count.id));
    return rows.map((r) => ({ customerId: r.customerId, customerName: r.customerName, customerPhone: r.customerPhone, totalOrders: r._count.id, unbilledCount: unbilledMap.get(keyOf(r.customerId, r.customerName, r.customerPhone)) || 0, totalAmount: Number(r._sum.amount ?? 0), totalAdvance: Number(r._sum.advancePaid ?? 0), totalDue: Math.max(0, Number(r._sum.amount ?? 0) - Number(r._sum.advancePaid ?? 0)) }));
  },

  async searchCustomers(q: string, take = 8) {
    const query = q.trim();
    const where: Prisma.UserWhereInput = { role: "client" };
    if (query) where.OR = [{ name: { contains: query, mode: "insensitive" } }, { phone: { contains: query } }, { email: { contains: query, mode: "insensitive" } }];
    const users = await prisma.user.findMany({ where, select: { id: true, name: true, phone: true, email: true }, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(take, 1), 20) });
    return users.map((u) => ({ id: u.id, name: u.name, phone: u.phone || "", email: u.email || "" }));
  },

  async listEmployees() {
    return prisma.user.findMany({ where: { role: "employee" }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } });
  },

  async createOrder(body: CreateOrderBody, userId: string): Promise<Write<unknown>> {
    const customerName = String(body.customerName || "").trim();
    if (!customerName) throw ApiError.badRequest("Customer name is required.");
    const workDetails = String(body.workDetails || "").trim();
    if (!workDetails) throw ApiError.badRequest("Work details are required.");
    const amount = toDecimal(body.amount);
    if (amount <= 0) throw ApiError.badRequest("Enter the total order amount.");
    const rawItems = typeof body.items === 'string' ? JSON.parse(body.items) : body.items;
    const items = Array.isArray(rawItems) ? rawItems.map(cleanItem).filter((it) => it.desc) : [];

    const order = await prisma.quickOrder.create({
      data: {
        customerId:    body.customerId?.trim() || null,
        customerName,
        customerPhone: body.customerPhone?.trim() || "",
        customerEmail: body.customerEmail?.trim() || "",
        whatsapp:      body.whatsapp?.trim()      || null,
        title:         body.title?.trim()         || null,
        workDetails,
        items:         items as any,
        description:   body.description?.trim() || "",
        amount,
        advancePaid:   toDecimal(body.advancePaid),
        paymentMethod: body.paymentMethod === "online" ? "online" : "cash",
        entryDate:     body.entryDate ? new Date(body.entryDate) : new Date(),
        images:        body.images || [],
        createdById:   userId,
      },
      include: withTask,
    });

    // Save advance as first payment entry so it shows in Payment History
    const advance = toDecimal(body.advancePaid);
    if (advance > 0) {
      await prisma.quickOrderPayment.create({
        data: {
          orderId:     order.id,
          amount:      advance,
          method:      body.paymentMethod === "online" ? "online" : "cash",
          note:        "Advance",
          createdById: userId,
        },
      });
    }

    let taskCreated = false;
    if (body.assignToId) {
      try {
        await prisma.task.create({ data: { title: taskTitle(order), description: workDetails, images: order.images || [], links: [], priority: asTaskPriority(body.priority), deadline: body.deadline ? new Date(body.deadline) : null, customerName: order.customerName, customerPhone: order.customerPhone || null, orderDate: order.entryDate, amount: Math.round(amount), advancePaid: Math.round(toDecimal(body.advancePaid)), quickOrderId: order.id, assignedToId: body.assignToId, createdById: userId } });
        taskCreated = true;
      } catch (e) { console.error("task creation failed:", e); }
    }

    const fresh = await prisma.quickOrder.findUnique({ where: { id: order.id }, include: withTask });
    return { result: fresh, audit: { action: "quickorder.create", entityId: order.id, entityRef: order.customerName, summary: `New order for ${order.customerName} \u00b7 \u20b9${amount.toFixed(2)}${taskCreated ? " \u00b7 assigned" : ""}`, detail: { amount, itemCount: items.length, assigned: !!body.assignToId } } };
  },

  async updateOrder(id: string, body: UpdateOrderBody): Promise<Write<unknown>> {
    const existing = await prisma.quickOrder.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Order not found.");
    if (existing.status === "billed") throw ApiError.badRequest("Cannot edit a billed order.");

    const data: Prisma.QuickOrderUpdateInput = {};
    if (body.customerName  !== undefined) data.customerName  = String(body.customerName).trim();
    if (body.customerPhone !== undefined) data.customerPhone = body.customerPhone?.trim() || "";
    if (body.customerEmail !== undefined) data.customerEmail = body.customerEmail?.trim() || "";
    if (body.whatsapp      !== undefined) data.whatsapp      = body.whatsapp?.trim()      || null;
    if (body.title         !== undefined) data.title         = body.title?.trim()         || null;
    if (body.workDetails   !== undefined) { const wd = String(body.workDetails).trim(); if (!wd) throw ApiError.badRequest("Work details cannot be empty."); data.workDetails = wd; }
    if (body.description   !== undefined) data.description   = body.description?.trim() || "";
    if (body.advancePaid   !== undefined) data.advancePaid   = toDecimal(body.advancePaid);
    if (body.paymentMethod !== undefined) data.paymentMethod = body.paymentMethod === "online" ? "online" : "cash";
    if (body.entryDate     !== undefined) data.entryDate     = new Date(body.entryDate);
    if (body.items !== undefined) { const items = Array.isArray(body.items) ? body.items.map(cleanItem).filter((it) => it.desc) : []; data.items = items as any; }
    if (body.amount !== undefined) data.amount = toDecimal(body.amount);
    if (body.images !== undefined) data.images = body.images;

    const updated = await prisma.quickOrder.update({ where: { id }, data, include: withTask });
    // Sync images to linked task if it exists
    if (updated.task && data.images) {
      await prisma.task.update({ where: { id: updated.task.id }, data: { images: updated.images } });
    }
    return { result: updated, audit: { action: "quickorder.update", entityId: updated.id, entityRef: updated.customerName, summary: `Edited order for ${updated.customerName}` } };
  },

  async assignOrder(id: string, body: AssignBody, adminId: string): Promise<Write<unknown>> {
    const order = await prisma.quickOrder.findUnique({ where: { id }, include: withTask });
    if (!order) throw ApiError.notFound("Order not found.");
    const employee = await prisma.user.findUnique({ where: { id: body.assignToId }, select: { id: true, name: true, role: true } });
    if (!employee) throw ApiError.badRequest("Employee not found.");
    if (employee.role !== "employee" && employee.role !== "admin") throw ApiError.badRequest("Can only assign to an employee.");

    if (order.task) {
      await prisma.task.update({ where: { id: order.task.id }, data: { assignedToId: body.assignToId, priority: body.priority ? asTaskPriority(body.priority) : undefined, deadline: body.deadline ? new Date(body.deadline) : undefined, notes: body.notes || undefined, title: taskTitle(order), description: order.workDetails || undefined, images: order.images?.length ? order.images : undefined, customerName: order.customerName, customerPhone: order.customerPhone || null, amount: Math.round(Number(order.amount)), advancePaid: Math.round(Number(order.advancePaid)) } });
    } else {
      await prisma.task.create({ data: { title: taskTitle(order), description: order.workDetails, images: order.images || [], links: [], priority: asTaskPriority(body.priority), deadline: body.deadline ? new Date(body.deadline) : null, notes: body.notes || null, customerName: order.customerName, customerPhone: order.customerPhone || null, orderDate: order.entryDate, amount: Math.round(Number(order.amount)), advancePaid: Math.round(Number(order.advancePaid)), quickOrderId: order.id, assignedToId: body.assignToId, createdById: adminId } });
    }

    const fresh = await prisma.quickOrder.findUnique({ where: { id }, include: withTask });
    return { result: fresh, audit: { action: "quickorder.assign", entityId: order.id, entityRef: order.customerName, summary: `Assigned order (${order.customerName}) to ${employee.name}`, detail: { assignedTo: employee.name, assignedToId: body.assignToId } } };
  },

  async claimOrder(id: string, employeeId: string): Promise<Write<unknown>> {
    const order = await prisma.quickOrder.findUnique({ where: { id }, include: withTask });
    if (!order) throw ApiError.notFound("Order not found.");
    if (order.task) throw ApiError.badRequest("This order is already assigned.");
    const employee = await prisma.user.findUnique({ where: { id: employeeId }, select: { id: true, name: true } });
    if (!employee) throw ApiError.badRequest("Employee not found.");
    await prisma.task.create({ data: { title: taskTitle(order), description: order.workDetails, images: order.images || [], links: [], priority: "medium", customerName: order.customerName, customerPhone: order.customerPhone || null, orderDate: order.entryDate, amount: Math.round(Number(order.amount)), advancePaid: Math.round(Number(order.advancePaid)), quickOrderId: order.id, assignedToId: employeeId, createdById: employeeId } });
    const fresh = await prisma.quickOrder.findUnique({ where: { id }, include: withTask });
    return { result: fresh, audit: { action: "quickorder.claim", entityId: order.id, entityRef: order.customerName, summary: `${employee.name} claimed order (${order.customerName})`, detail: { employeeId, employeeName: employee.name } } };
  },

  async unassignOrder(id: string): Promise<Write<unknown>> {
    const order = await prisma.quickOrder.findUnique({ where: { id }, include: withTask });
    if (!order) throw ApiError.notFound("Order not found.");
    if (!order.task) throw ApiError.badRequest("This order has no assignment to remove.");
    await prisma.task.delete({ where: { id: order.task.id } });
    const fresh = await prisma.quickOrder.findUnique({ where: { id }, include: withTask });
    return { result: fresh, audit: { action: "quickorder.unassign", entityId: order.id, entityRef: order.customerName, summary: `Unassigned order (${order.customerName})` } };
  },

  async deleteOrder(id: string): Promise<Write<{ ok: true }>> {
    const existing = await prisma.quickOrder.findUnique({ where: { id }, include: withTask });
    if (!existing) throw ApiError.notFound("Order not found.");
    if (existing.status === "billed") throw ApiError.badRequest("Cannot delete a billed order.");
    if (existing.task) await prisma.task.delete({ where: { id: existing.task.id } });
    await prisma.quickOrder.delete({ where: { id } });
    return { result: { ok: true }, audit: { action: "quickorder.delete", entityId: existing.id, entityRef: existing.customerName, summary: `Deleted order for ${existing.customerName}` } };
  },

  /* ── record a payment ── */
  async recordPayment(id: string, body: { amount: unknown; method?: string; note?: string }, userId: string): Promise<Write<unknown>> {
    const order = await prisma.quickOrder.findUnique({ where: { id } });
    if (!order) throw ApiError.notFound("Order not found.");
    const n = parseFloat(String(body.amount ?? "0"));
    if (!n || n <= 0) throw ApiError.badRequest("Enter a valid payment amount.");

    const [payment] = await prisma.$transaction([
      prisma.quickOrderPayment.create({
        data: {
          orderId:     id,
          amount:      n,
          method:      body.method === "online" ? "online" : "cash",
          note:        String(body.note || "").trim(),
          createdById: userId,
        },
        include: { createdBy: { select: { id: true, name: true } } },
      }),
      prisma.quickOrder.update({
        where: { id },
        data:  { advancePaid: { increment: n } },
      }),
    ]);

    const fresh = await prisma.quickOrder.findUnique({ where: { id }, include: withTask });
    return {
      result: fresh,
      audit: {
        action:    "quickorder.payment",
        entityId:  id,
        entityRef: order.customerName,
        summary:   `Payment of ₹${n.toFixed(2)} recorded for ${order.customerName}`,
        detail:    { amount: n, method: body.method },
      },
    };
  },

  async convertToInvoice(id: string, userId: string): Promise<Write<{ invoice: unknown; invoiceNo: string; stock: InvoiceStockSync }>> {
    const entry = await prisma.quickOrder.findUnique({ where: { id } });
    if (!entry) throw ApiError.notFound("Order not found.");
    if (entry.status === "billed") throw ApiError.badRequest("Already converted to an invoice.");
    const business = await businessBlock();
    const items = (entry.items ?? []) as any[];
    const subtotal = Number(entry.amount), advance = Number(entry.advancePaid);

    const { invoice, invoiceNo } = await prisma.$transaction(async (tx) => {
      const count = await tx.invoice.count();
      const today = new Date();
      const invoiceNo = `AA-${String(today.getFullYear()).slice(-2)}${String(today.getMonth()+1).padStart(2,"0")}${String(today.getDate()).padStart(2,"0")}-${String(count+1).padStart(3,"0")}`;
      const invoice = await tx.invoice.create({ data: { invoiceNo, date: entry.entryDate, clientName: entry.customerName, clientPhone: entry.customerPhone || null, clientEmail: entry.customerEmail || null, source: "offline", business, items: items as any, discType: "amount", discVal: 0, taxPct: 0, subtotal, discountAmt: 0, taxAmt: 0, total: subtotal, paidAmount: advance, status: deriveStatus(advance, subtotal), notes: entry.workDetails || "Keep the invoices for Future References", createdById: userId } });
      if (advance > 0) await tx.payment.create({ data: { invoiceId: invoice.id, amount: entry.advancePaid, method: entry.paymentMethod, note: "Advance from Quick Orders", createdById: userId } });
      await tx.quickOrder.update({ where: { id: entry.id }, data: { status: "billed", invoiceId: invoice.id, invoiceNo } });
      return { invoice, invoiceNo };
    }, TX_OPTS);

    await ensureCustomer({ name: entry.customerName, phone: entry.customerPhone, email: entry.customerEmail });
    let stock: InvoiceStockSync = { changed: false, movementCount: 0, items: [], warnings: [], unresolved: [] };
    try { stock = await inventoryService.applyInvoiceStock(invoice.id, userId); } catch (e) { console.error("applyInvoiceStock failed:", e); }

    return { result: { invoice, invoiceNo, stock }, audit: { action: "quickorder.convert", entityId: entry.id, entityRef: entry.customerName, summary: `Order to invoice ${invoiceNo} for ${entry.customerName}`, detail: { invoiceNo, subtotal, stockConsumed: stock.movementCount } } };
  },

  async convertCombined(entryIds: string[], userId: string): Promise<Write<{ invoice: unknown; invoiceNo: string; mergedCount: number; stock: InvoiceStockSync }>> {
    if (!Array.isArray(entryIds) || entryIds.length === 0) throw ApiError.badRequest("No orders selected.");
    const entries = await prisma.quickOrder.findMany({ where: { id: { in: entryIds } } });
    const unbilled = entries.filter((e) => e.status !== "billed");
    if (unbilled.length === 0) throw ApiError.badRequest("All selected orders are already invoiced.");
    const first = unbilled[0];
    if (!unbilled.every((e) => e.customerName === first.customerName && (e.customerPhone || "") === (first.customerPhone || ""))) throw ApiError.badRequest("Orders belong to different customers.");

    const business = await businessBlock();
    const mergedItems: any[] = [];
    let totalAdvance = 0, totalAmount = 0;
    for (const e of unbilled) {
      const its = (e.items ?? []) as any[];
      for (const it of its) mergedItems.push({ itemId: it.itemId ?? null, desc: it.desc, qty: Number(it.qty) || 0, rate: Number(it.rate) || 0, ...(it.unit ? { unit: it.unit } : {}) });
      totalAdvance += Number(e.advancePaid) || 0;
      totalAmount  += Number(e.amount)      || 0;
    }
    const latest = unbilled.reduce((a, b) => (a.entryDate > b.entryDate ? a : b));

    const { invoice, invoiceNo } = await prisma.$transaction(async (tx) => {
      const count = await tx.invoice.count();
      const today = new Date();
      const invoiceNo = `AA-${String(today.getFullYear()).slice(-2)}${String(today.getMonth()+1).padStart(2,"0")}${String(today.getDate()).padStart(2,"0")}-${String(count+1).padStart(3,"0")}`;
      const invoice = await tx.invoice.create({ data: { invoiceNo, date: latest.entryDate, clientName: first.customerName, clientPhone: first.customerPhone || null, clientEmail: first.customerEmail || null, source: "offline", business, items: mergedItems as any, discType: "amount", discVal: 0, taxPct: 0, subtotal: totalAmount, discountAmt: 0, taxAmt: 0, total: totalAmount, paidAmount: totalAdvance, status: deriveStatus(totalAdvance, totalAmount), notes: "Keep the invoices for Future References", createdById: userId } });
      if (totalAdvance > 0) await tx.payment.create({ data: { invoiceId: invoice.id, amount: totalAdvance, method: latest.paymentMethod, note: `Combined advance from ${unbilled.length} orders`, createdById: userId } });
      await tx.quickOrder.updateMany({ where: { id: { in: unbilled.map((e) => e.id) } }, data: { status: "billed", invoiceId: invoice.id, invoiceNo } });
      return { invoice, invoiceNo };
    }, TX_OPTS);

    await ensureCustomer({ name: first.customerName, phone: first.customerPhone, email: first.customerEmail });
    let stock: InvoiceStockSync = { changed: false, movementCount: 0, items: [], warnings: [], unresolved: [] };
    try { stock = await inventoryService.applyInvoiceStock(invoice.id, userId); } catch (e) { console.error("applyInvoiceStock combined failed:", e); }

    return { result: { invoice, invoiceNo, mergedCount: unbilled.length, stock }, audit: { action: "quickorder.convert.combined", entityId: invoice.id, entityRef: first.customerName, summary: `${unbilled.length} orders to invoice ${invoiceNo} for ${first.customerName}`, detail: { invoiceNo, mergedCount: unbilled.length, subtotal: totalAmount, stockConsumed: stock.movementCount } } };
  },
};

export type QuickOrderService = typeof quickOrderService;