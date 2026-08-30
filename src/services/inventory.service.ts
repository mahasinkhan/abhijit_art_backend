// backend/src/services/inventory.service.ts
import type { Prisma, MovementType } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { ApiError } from "../middleware/error.js";

export interface AuditInfo {
  action: string; entityId?: string; entityRef?: string; summary: string; detail?: unknown;
}
interface Write<T> { result: T; audit: AuditInfo; }

export interface ItemsFilter { q?: string; category?: string; low?: boolean; active?: boolean; }
export interface CreateItemBody {
  sku?: string; name?: string; description?: string; category?: string; unit?: string;
  openingQty?: unknown; reorderLevel?: unknown; costPrice?: unknown; sellPrice?: unknown;
  location?: string; imageUrl?: string; supplierId?: string | null;
}
export interface UpdateItemBody extends CreateItemBody { active?: boolean; }
export interface MoveBody {
  type?: string; quantity?: unknown; newQuantity?: unknown; delta?: unknown;
  unitCost?: unknown; reference?: string; note?: string; supplierId?: string | null; bookingId?: string | null;
}
export interface DashboardFilter { granularity?: string; from?: string; to?: string; }
export interface SetPriceBody { supplierId?: string; price?: unknown; supplierSku?: string; note?: string; preferred?: boolean; }
export interface SupplierBody { name?: string; phone?: string; email?: string; gstin?: string; address?: string; notes?: string; active?: boolean; }
export interface PaymentBody { amount?: unknown; method?: string; note?: string; paidAt?: string; }
export interface PurchaseBody {
  supplierId?: string; billNo?: string; billDate?: string;
  discType?: string; discVal?: unknown; taxPct?: unknown; notes?: string; items?: unknown[];
}
export interface StockWarning { id: string; name: string; sku: string; unit: string; quantity: number; kind: "out" | "low"; }
export interface UnresolvedLine { itemId: string; quantity: number; }
export interface InvoiceStockSync {
  changed: boolean; movementCount: number;
  items: { id: string; name: string; sku: string; unit: string; quantity: number }[];
  warnings: StockWarning[]; unresolved: UnresolvedLine[]; error?: string;
}
interface AffectedItem { id: string; name: string; sku: string; unit: string; quantity: number; reorderLevel: number; }

const userPublic = { select: { name: true, email: true } };
const MOVEMENT_TYPES = ["opening", "purchase", "consumption", "wastage", "returned", "adjustment"] as const;
const ADDS = new Set(["opening", "purchase", "returned"]);
const SUBTRACTS = new Set(["consumption", "wastage"]);
const MOVE_LABEL: Record<string, string> = {
  opening: "Opening", purchase: "Purchase", consumption: "Consumption",
  wastage: "Wastage", returned: "Return", adjustment: "Adjustment",
};
const STOCK_UNITS = ["piece", "sqft", "Square Inch", "inch", "feet", "metre", "roll", "sheet", "box"];
const TX_OPTS = { maxWait: 15_000, timeout: 30_000 } as const;

const toNum = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const round3 = (x: number) => Math.round((x + Number.EPSILON) * 1000) / 1000;

const supplierView = <T extends { totalPurchased: unknown; totalPaid: unknown }>(sp: T) => ({
  ...sp,
  totalPurchased: Number(sp.totalPurchased),
  totalPaid: Number(sp.totalPaid),
  balance: round2(Number(sp.totalPurchased) - Number(sp.totalPaid)),
});

type Gran = "day" | "week" | "month" | "year";
const asGran = (v: unknown): Gran => {
  const g = String(v || "").toLowerCase();
  if (g === "day" || g === "daily") return "day";
  if (g === "week" || g === "weekly") return "week";
  if (g === "year" || g === "yearly") return "year";
  return "month";
};
const pad = (n: number) => String(n).padStart(2, "0");
const startOfDay   = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek  = (d: Date) => { const dow = (d.getDay() + 6) % 7; return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow); };
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const startOfYear  = (d: Date) => new Date(d.getFullYear(), 0, 1);
const bucketStart  = (d: Date, g: Gran) =>
  g === "day" ? startOfDay(d) : g === "week" ? startOfWeek(d) : g === "month" ? startOfMonth(d) : startOfYear(d);
const nextBucket = (d: Date, g: Gran) =>
  g === "day"   ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  : g === "week"  ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)
  : g === "month" ? new Date(d.getFullYear(), d.getMonth() + 1, 1)
  : new Date(d.getFullYear() + 1, 0, 1);
const bucketKey = (d: Date, g: Gran) => {
  const b = bucketStart(d, g);
  if (g === "year")  return `${b.getFullYear()}`;
  if (g === "month") return `${b.getFullYear()}-${pad(b.getMonth() + 1)}`;
  return `${b.getFullYear()}-${pad(b.getMonth() + 1)}-${pad(b.getDate())}`;
};
const bucketLabel = (b: Date, g: Gran) =>
  g === "year"  ? `${b.getFullYear()}`
  : g === "month" ? b.toLocaleDateString("en-IN", { month: "short" })
  : b.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const parseDate = (v: unknown): Date | null => {
  const s = String(v || "").trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};
const defaultRange = (g: Gran, now: Date): { from: Date; to: Date } => {
  const to = startOfDay(now);
  if (g === "day")  return { from: new Date(to.getFullYear(), to.getMonth(), to.getDate() - 13), to };
  if (g === "week") { const ws = startOfWeek(now); return { from: new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() - 7 * 11), to }; }
  if (g === "year") return { from: new Date(now.getFullYear() - 4, 0, 1), to };
  return { from: new Date(now.getFullYear(), now.getMonth() - 5, 1), to };
};

const linkedLineTotals = (itemsJson: unknown): Map<string, number> => {
  const out = new Map<string, number>();
  const arr = Array.isArray(itemsJson) ? itemsJson : [];
  for (const raw of arr as any[]) {
    const itemId = String(raw?.itemId || "").trim();
    if (!itemId) continue;
    const qty = toNum(raw?.qty);
    if (qty === null || qty <= 0) continue;
    out.set(itemId, round3((out.get(itemId) ?? 0) + qty));
  }
  return out;
};

const emptyStockSync = (): InvoiceStockSync => ({
  changed: false, movementCount: 0, items: [], warnings: [], unresolved: [],
});

const summarizeStockSync = (affected: AffectedItem[], flagLow: boolean, unresolved: UnresolvedLine[] = []): InvoiceStockSync => {
  const warnings: StockWarning[] = [];
  if (flagLow) {
    for (const it of affected) {
      if (it.quantity <= 0) warnings.push({ id: it.id, name: it.name, sku: it.sku, unit: it.unit, quantity: it.quantity, kind: "out" });
      else if (it.quantity <= it.reorderLevel) warnings.push({ id: it.id, name: it.name, sku: it.sku, unit: it.unit, quantity: it.quantity, kind: "low" });
    }
  }
  return {
    changed: affected.length > 0, movementCount: affected.length,
    items: affected.map((it) => ({ id: it.id, name: it.name, sku: it.sku, unit: it.unit, quantity: it.quantity })),
    warnings, unresolved,
  };
};

export const inventoryService = {

  async listItems(filter: ItemsFilter) {
    const q = (filter.q || "").trim();
    const category = (filter.category || "").trim();
    const where: Prisma.InventoryItemWhereInput = {};
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { sku: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
      ];
    }
    if (category) where.category = { equals: category, mode: "insensitive" };
    if (filter.active === true)  where.active = true;
    if (filter.active === false) where.active = false;
    const items = await prisma.inventoryItem.findMany({
      where,
      include: { supplier: { select: { name: true } }, _count: { select: { supplierPrices: true } } },
      orderBy: { name: "asc" },
    });
    const withFlags = items.map((it) => ({ ...it, low: Number(it.quantity) <= Number(it.reorderLevel) }));
    return filter.low ? withFlags.filter((i) => i.low) : withFlags;
  },

  async getItem(id: string) {
    const item = await prisma.inventoryItem.findUnique({
      where: { id },
      include: {
        supplier: { select: { name: true } },
        supplierPrices: {
          include: { supplier: { select: { id: true, name: true, phone: true, active: true } } },
          orderBy: [{ preferred: "desc" }, { price: "asc" }],
        },
        movements: {
          orderBy: { createdAt: "desc" },
          include: {
            supplier: { select: { name: true } },
            user: userPublic,
            booking: { select: { id: true, serviceName: true } },
          },
        },
      },
    });
    if (!item) throw ApiError.notFound("Item not found.");
    return { ...item, low: Number(item.quantity) <= Number(item.reorderLevel) };
  },

  async createItem(body: CreateItemBody, userId: string): Promise<Write<unknown>> {
    if (!String(body.sku  || "").trim()) throw ApiError.badRequest("SKU is required.");
    if (!String(body.name || "").trim()) throw ApiError.badRequest("Name is required.");
    const unitVal = STOCK_UNITS.includes(String(body.unit)) ? String(body.unit) : "piece";
    const clash = await prisma.inventoryItem.findUnique({ where: { sku: String(body.sku).trim() } });
    if (clash) throw ApiError.conflict("An item with this SKU already exists.");
    const opening = toNum(body.openingQty) ?? 0;
    const cost    = toNum(body.costPrice)   ?? 0;

    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.inventoryItem.create({
        data: {
          sku: String(body.sku).trim(), name: String(body.name).trim(), description: body.description || "",
          category: (body.category || "").trim(), unit: unitVal as any, quantity: opening,
          reorderLevel: toNum(body.reorderLevel) ?? 0, costPrice: cost, sellPrice: toNum(body.sellPrice),
          location: body.location || "", imageUrl: body.imageUrl || "", supplierId: body.supplierId || null,
        },
      });
      if (opening > 0) {
        const movType = (body.supplierId ? "purchase" : "opening") as MovementType;
        await tx.stockMovement.create({
          data: {
            itemId: created.id, type: movType, quantity: opening, delta: opening, balance: opening,
            unitCost: cost || null, note: body.supplierId ? "Initial purchase" : "Opening balance",
            supplierId: body.supplierId || null, userId,
          },
        });
        if (body.supplierId && cost > 0) {
          const purchaseTotal = round2(opening * cost);
          const purchase = await tx.supplierPurchase.create({
            data: {
              supplierId: body.supplierId, billNo: "", billDate: new Date(), discType: "amount" as any,
              discVal: 0, taxPct: 0, subtotal: purchaseTotal, discountAmt: 0, taxAmt: 0, total: purchaseTotal,
              notes: "Initial stock purchase", createdById: userId,
            },
          });
          await tx.supplierPurchaseItem.create({
            data: { purchaseId: purchase.id, itemId: created.id, name: created.name, unit: created.unit, quantity: opening, rate: cost, amount: purchaseTotal },
          });
          await tx.supplier.update({ where: { id: body.supplierId }, data: { totalPurchased: { increment: purchaseTotal }, lastPurchaseAt: new Date() } });
        }
      }
      return created;
    }, TX_OPTS);

    return {
      result: item,
      audit: {
        action: "inventory.item.create", entityId: item.id, entityRef: item.sku,
        summary: `Added item ${item.name} (${item.sku})${opening > 0 ? ` · opening ${opening} ${item.unit}` : ""}`,
        detail:  { sku: item.sku, name: item.name, opening, costPrice: cost },
      },
    };
  },

  async updateItem(id: string, body: UpdateItemBody): Promise<Write<unknown>> {
    const existing = await prisma.inventoryItem.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Item not found.");
    if (body.sku && String(body.sku).trim() !== existing.sku) {
      const clash = await prisma.inventoryItem.findUnique({ where: { sku: String(body.sku).trim() } });
      if (clash) throw ApiError.conflict("An item with this SKU already exists.");
    }
    const data: Prisma.InventoryItemUpdateInput = {};
    if (body.sku         !== undefined) data.sku         = String(body.sku).trim();
    if (body.name        !== undefined) data.name        = String(body.name).trim();
    if (body.description !== undefined) data.description = body.description || "";
    if (body.category    !== undefined) data.category    = (body.category || "").trim();
    if (body.unit !== undefined && STOCK_UNITS.includes(String(body.unit))) data.unit = String(body.unit) as any;
    if (body.reorderLevel !== undefined) data.reorderLevel = toNum(body.reorderLevel) ?? 0;
    if (body.costPrice    !== undefined) data.costPrice    = toNum(body.costPrice)    ?? 0;
    if (body.sellPrice    !== undefined) data.sellPrice    = toNum(body.sellPrice);
    if (body.location     !== undefined) data.location     = body.location || "";
    if (body.imageUrl     !== undefined) data.imageUrl     = body.imageUrl || "";
    if (body.active       !== undefined) data.active       = !!body.active;
    if (body.supplierId   !== undefined) {
      data.supplier = body.supplierId ? { connect: { id: body.supplierId } } : { disconnect: true };
    }
    const item = await prisma.inventoryItem.update({ where: { id }, data });
    return {
      result: item,
      audit: { action: "inventory.item.update", entityId: item.id, entityRef: item.sku, summary: `Edited item ${item.name} (${item.sku})` },
    };
  },

  async deleteItem(id: string): Promise<Write<{ ok: true }>> {
    const existing = await prisma.inventoryItem.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Item not found.");
    await prisma.inventoryItem.delete({ where: { id } });
    return {
      result: { ok: true },
      audit: { action: "inventory.item.delete", entityId: existing.id, entityRef: existing.sku, summary: `Deleted item ${existing.name} (${existing.sku})` },
    };
  },

  async moveStock(itemId: string, body: MoveBody, userId: string): Promise<Write<unknown>> {
    const type = String(body.type || "").toLowerCase() as MovementType;
    if (!MOVEMENT_TYPES.includes(type as any)) throw ApiError.badRequest("Invalid movement type.");
    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) throw ApiError.notFound("Item not found.");
    const current = Number(item.quantity);
    let delta: number;
    if (type === "adjustment") {
      const dRaw   = toNum(body.delta);
      const target = toNum(body.newQuantity);
      if (dRaw !== null) delta = dRaw;
      else if (target !== null) delta = target - current;
      else throw ApiError.badRequest("Adjustment needs a delta or a new quantity.");
      if (delta === 0) throw ApiError.badRequest("Adjustment must change the quantity.");
    } else {
      const qty = toNum(body.quantity);
      if (qty === null || qty <= 0) throw ApiError.badRequest("Quantity must be a positive number.");
      if (ADDS.has(type)) delta = qty;
      else if (SUBTRACTS.has(type)) delta = -qty;
      else delta = qty;
    }
    const newBalance = current + delta;
    if (newBalance < 0) throw ApiError.badRequest(`Not enough stock. Available: ${current} ${item.unit}, tried to remove ${Math.abs(delta)}.`);
    const cost = toNum(body.unitCost);
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.inventoryItem.update({
        where: { id: itemId },
        data: { quantity: newBalance, ...(type === "purchase" && cost !== null ? { costPrice: cost } : {}) },
      });
      const created = await tx.stockMovement.create({
        data: {
          itemId, type, quantity: Math.abs(delta), delta, balance: newBalance,
          unitCost: type === "purchase" ? cost : null, reference: body.reference || "", note: body.note || "",
          supplierId: body.supplierId || null, bookingId: body.bookingId || null, userId,
        },
      });
      return { item: updated, movementId: created.id };
    }, TX_OPTS);
    const movement = await prisma.stockMovement.findUnique({
      where: { id: result.movementId },
      include: { supplier: { select: { name: true } }, user: userPublic, booking: { select: { id: true, serviceName: true } } },
    });
    return {
      result: { item: result.item, movement },
      audit: {
        action: "inventory.move", entityId: itemId, entityRef: item.sku,
        summary: `${MOVE_LABEL[type] || type} ${Math.abs(delta)} ${item.unit} · ${item.name} → balance ${newBalance} ${item.unit}`,
        detail:  { type, delta, newBalance, unitCost: cost, reference: body.reference || "", supplierId: body.supplierId || null },
      },
    };
  },

  async summary() {
    const items = await prisma.inventoryItem.findMany({
      where: { active: true },
      select: { quantity: true, reorderLevel: true, costPrice: true },
    });
    let stockValue = 0, lowCount = 0, outCount = 0;
    for (const it of items) {
      const qty = Number(it.quantity);
      stockValue += qty * Number(it.costPrice);
      if (qty <= 0) outCount += 1;
      else if (qty <= Number(it.reorderLevel)) lowCount += 1;
    }
    return { totalItems: items.length, lowCount, outCount, stockValue: Math.round(stockValue) };
  },

  async categories() {
    const rows = await prisma.inventoryItem.findMany({
      where: { category: { not: "" } }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" },
    });
    return rows.map((r) => r.category);
  },

  async movements(limit: number) {
    const take = Math.min(limit || 50, 200);
    return prisma.stockMovement.findMany({
      take, orderBy: { createdAt: "desc" },
      include: {
        item: { select: { id: true, name: true, sku: true, unit: true } },
        supplier: { select: { name: true } }, user: userPublic, booking: { select: { id: true, serviceName: true } },
      },
    });
  },
    async dashboard(filter: DashboardFilter) {
    const now  = new Date();
    const gran = asGran(filter.granularity);
    const def  = defaultRange(gran, now);
    let from     = bucketStart(parseDate(filter.from) ?? def.from, gran);
    let toBucket = bucketStart(parseDate(filter.to)   ?? def.to,   gran);
    if (toBucket < from) { const t = from; from = toBucket; toBucket = t; }
    const rangeEnd = nextBucket(toBucket, gran);
    const MAX_BUCKETS = 400;
    const buckets: { key: string; label: string; start: Date }[] = [];
    for (let cur = new Date(from); cur < rangeEnd && buckets.length < MAX_BUCKETS; cur = nextBucket(cur, gran)) {
      buckets.push({ key: bucketKey(cur, gran), label: bucketLabel(cur, gran), start: new Date(cur) });
    }
    const effectiveFrom = buckets.length ? buckets[0].start : from;
    const items = await prisma.inventoryItem.findMany({
      where: { active: true },
      select: { id: true, name: true, sku: true, unit: true, category: true, quantity: true, reorderLevel: true, costPrice: true },
    });
    let stockValue = 0, lowCount = 0, outCount = 0;
    const catMap = new Map<string, { value: number; count: number }>();
    const valued = items.map((it) => {
      const qty = Number(it.quantity), cost = Number(it.costPrice), reorder = Number(it.reorderLevel);
      const value = qty * cost, out = qty <= 0;
      stockValue += value;
      if (out) outCount += 1;
      else if (qty <= reorder) lowCount += 1;
      const cat = (it.category || "").trim() || "Uncategorised";
      const c = catMap.get(cat) || { value: 0, count: 0 };
      c.value += value; c.count += 1; catMap.set(cat, c);
      return { ...it, qty, cost, reorder, value, out };
    });
    const categories = [...catMap.entries()]
      .map(([name, v]) => ({ name, value: Math.round(v.value), count: v.count }))
      .filter((c) => c.value > 0).sort((a, b) => b.value - a.value);
    const topByValue = valued.filter((it) => it.value > 0).sort((a, b) => b.value - a.value).slice(0, 8)
      .map((it) => ({ id: it.id, name: it.name, sku: it.sku, unit: it.unit, quantity: it.qty, value: Math.round(it.value) }));
    const lowItems = valued.filter((it) => it.out || it.qty <= it.reorder)
      .sort((a, b) => Number(b.out) - Number(a.out) || a.qty - b.qty)
      .map((it) => ({ id: it.id, name: it.name, sku: it.sku, unit: it.unit, quantity: it.qty, reorderLevel: it.reorder, out: it.out }));
    const periodMoves = await prisma.stockMovement.findMany({
      where: { createdAt: { gte: effectiveFrom, lt: rangeEnd } },
      select: { type: true, quantity: true, unitCost: true, createdAt: true, item: { select: { costPrice: true } } },
    });
    const trendMap = new Map(buckets.map((b) => [b.key, { key: b.key, label: b.label, purchase: 0, consumption: 0, wastage: 0 }]));
    let purchaseValue = 0, consumptionValue = 0, wastageValue = 0;
    for (const m of periodMoves) {
      const qty = Number(m.quantity), unit = m.unitCost != null ? Number(m.unitCost) : Number(m.item?.costPrice ?? 0);
      const value = qty * unit, b = trendMap.get(bucketKey(m.createdAt, gran));
      if (m.type === "purchase")         { purchaseValue    += value; if (b) b.purchase    += value; }
      else if (m.type === "consumption") { consumptionValue += value; if (b) b.consumption += value; }
      else if (m.type === "wastage")     { wastageValue     += value; if (b) b.wastage     += value; }
    }
    const trend = buckets.map((b) => {
      const t = trendMap.get(b.key)!;
      return { key: b.key, label: b.label, purchase: Math.round(t.purchase), consumption: Math.round(t.consumption), wastage: Math.round(t.wastage) };
    });
    const recentRaw = await prisma.stockMovement.findMany({
      take: 12, orderBy: { createdAt: "desc" },
      include: {
        item: { select: { name: true, sku: true, unit: true } },
        supplier: { select: { name: true } }, user: userPublic, booking: { select: { serviceName: true } },
      },
    });
    const recent = recentRaw.map((m) => ({
      id: m.id, type: m.type, quantity: Number(m.quantity), delta: Number(m.delta), balance: Number(m.balance),
      unitCost: m.unitCost != null ? Number(m.unitCost) : null, reference: m.reference, createdAt: m.createdAt,
      item: m.item, supplier: m.supplier, user: m.user, booking: m.booking,
    }));
    return {
      range: { from: effectiveFrom.toISOString(), to: toBucket.toISOString(), granularity: gran },
      kpis: {
        totalItems: items.length, stockValue: Math.round(stockValue), lowCount, outCount,
        purchaseValue: Math.round(purchaseValue), consumptionValue: Math.round(consumptionValue),
        wastageValue: Math.round(wastageValue), movementCount: periodMoves.length,
      },
      trend, categories, topByValue, lowItems, recent,
    };
  },

  async listItemPrices(itemId: string) {
    return prisma.itemSupplier.findMany({
      where: { itemId },
      include: { supplier: { select: { id: true, name: true, phone: true, active: true } } },
      orderBy: [{ preferred: "desc" }, { price: "asc" }],
    });
  },

  async setItemPrice(itemId: string, body: SetPriceBody): Promise<Write<unknown>> {
    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) throw ApiError.notFound("Item not found.");
    const supplierId = String(body.supplierId || "");
    const supplier   = await prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw ApiError.badRequest("Select a supplier for this price.");
    const priceNum = toNum(body.price);
    if (priceNum === null || priceNum < 0) throw ApiError.badRequest("Enter a valid price.");
    const price = round2(priceNum), supplierSku = String(body.supplierSku || ""), note = String(body.note || ""), preferred = !!body.preferred;
    const row = await prisma.$transaction(async (tx) => {
      if (preferred) await tx.itemSupplier.updateMany({ where: { itemId, NOT: { supplierId } }, data: { preferred: false } });
      return tx.itemSupplier.upsert({
        where:   { itemId_supplierId: { itemId, supplierId } },
        create:  { itemId, supplierId, price, supplierSku, note, preferred },
        update:  { price, supplierSku, note, preferred },
        include: { supplier: { select: { id: true, name: true, phone: true, active: true } } },
      });
    }, TX_OPTS);
    return {
      result: row,
      audit: {
        action: "inventory.item.price.set", entityId: itemId, entityRef: item.sku,
        summary: `Set ${supplier.name} price ₹${price.toFixed(2)} for ${item.name}`,
        detail:  { itemId, supplierId, price, preferred },
      },
    };
  },

  async deleteItemPrice(itemId: string, priceId: string): Promise<Write<{ ok: true }>> {
    const existing = await prisma.itemSupplier.findUnique({
      where: { id: priceId },
      include: { supplier: { select: { name: true } }, item: { select: { sku: true, name: true } } },
    });
    if (!existing || existing.itemId !== itemId) throw ApiError.notFound("Price not found.");
    await prisma.itemSupplier.delete({ where: { id: priceId } });
    return {
      result: { ok: true },
      audit: {
        action: "inventory.item.price.delete", entityId: itemId, entityRef: existing.item?.sku || "",
        summary: `Removed ${existing.supplier?.name || "a supplier"}'s price from ${existing.item?.name || "item"}`,
        detail: { itemId, priceId },
      },
    };
  },

  async listSuppliers() {
    const suppliers = await prisma.supplier.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { items: true, purchases: true } } },
    });
    return suppliers.map(supplierView);
  },

  async createSupplier(body: SupplierBody): Promise<Write<unknown>> {
    if (!String(body.name || "").trim()) throw ApiError.badRequest("Supplier name is required.");
    const supplier = await prisma.supplier.create({
      data: { name: String(body.name).trim(), phone: body.phone || "", email: body.email || "", gstin: body.gstin || "", address: body.address || "", notes: body.notes || "" },
    });
    return {
      result: supplierView(supplier),
      audit: { action: "inventory.supplier.create", entityId: supplier.id, entityRef: supplier.name, summary: `Added supplier ${supplier.name}` },
    };
  },

  async updateSupplier(id: string, body: SupplierBody): Promise<Write<unknown>> {
    const existing = await prisma.supplier.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Supplier not found.");
    const data: Prisma.SupplierUpdateInput = {};
    if (body.name    !== undefined) data.name    = String(body.name).trim();
    if (body.phone   !== undefined) data.phone   = body.phone   || "";
    if (body.email   !== undefined) data.email   = body.email   || "";
    if (body.gstin   !== undefined) data.gstin   = body.gstin   || "";
    if (body.address !== undefined) data.address = body.address || "";
    if (body.notes   !== undefined) data.notes   = body.notes   || "";
    if (body.active  !== undefined) data.active  = !!body.active;
    const supplier = await prisma.supplier.update({ where: { id }, data });
    return {
      result: supplierView(supplier),
      audit: { action: "inventory.supplier.update", entityId: supplier.id, entityRef: supplier.name, summary: `Edited supplier ${supplier.name}` },
    };
  },

  async deleteSupplier(id: string): Promise<Write<{ ok: true }>> {
    const existing = await prisma.supplier.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Supplier not found.");
    await prisma.supplier.delete({ where: { id } });
    return {
      result: { ok: true },
      audit: { action: "inventory.supplier.delete", entityId: existing.id, entityRef: existing.name, summary: `Deleted supplier ${existing.name}` },
    };
  },

  async statement(id: string, limit: number) {
    const lim = Math.min(Math.max(limit || 200, 1), 1000);
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw ApiError.notFound("Supplier not found.");

    const [purchases, payments, purchaseCount, paymentCount] = await Promise.all([
      prisma.supplierPurchase.findMany({
        where: { supplierId: id }, orderBy: [{ billDate: "desc" }, { createdAt: "desc" }], take: lim,
        select: { id: true, billNo: true, billDate: true, total: true, notes: true, createdAt: true, _count: { select: { items: true } } },
      }),
      prisma.supplierPayment.findMany({
        where: { supplierId: id }, orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }], take: lim,
        select: { id: true, amount: true, method: true, note: true, paidAt: true, createdAt: true },
      }),
      prisma.supplierPurchase.count({ where: { supplierId: id } }),
      prisma.supplierPayment.count({ where: { supplierId: id } }),
    ]);

    type Entry = {
      kind: "purchase" | "payment"; id: string; date: Date; createdAt: Date;
      debit: number; credit: number; ref?: string; note?: string; method?: string; itemCount?: number; balance?: number;
    };

    const entries: Entry[] = [
      ...purchases.map((p): Entry => ({
        kind: "purchase", id: p.id, date: p.billDate, createdAt: p.createdAt,
        debit: round2(Number(p.total)), credit: 0, ref: p.billNo, note: p.notes, itemCount: p._count.items,
      })),
      ...payments.map((p): Entry => ({
        kind: "payment", id: p.id, date: p.paidAt, createdAt: p.createdAt,
        debit: 0, credit: round2(Number(p.amount)), method: p.method, note: p.note,
      })),
    ]
      .sort((a, b) => {
        const t = new Date(b.date).getTime() - new Date(a.date).getTime();
        return t !== 0 ? t : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      })
      .slice(0, lim);

    const entriesAsc = [...entries].reverse();
    let runBal = 0;
    for (const e of entriesAsc) {
      runBal = round2(runBal + e.debit - e.credit);
      e.balance = round2(runBal);
    }

    const currentBalance = round2(Number(supplier.totalPurchased) - Number(supplier.totalPaid));
    const totalEntries = purchaseCount + paymentCount;
    return {
      supplier: supplierView(supplier),
      summary: { totalPurchased: Number(supplier.totalPurchased), totalPaid: Number(supplier.totalPaid), balance: currentBalance, purchaseCount, paymentCount },
      entries, shown: entries.length, totalEntries, truncated: totalEntries > entries.length,
    };
  },

  async recordPayment(id: string, body: PaymentBody, userId: string): Promise<Write<unknown>> {
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw ApiError.notFound("Supplier not found.");
    const amountRaw = toNum(body.amount);
    if (amountRaw === null || amountRaw <= 0) throw ApiError.badRequest("Enter a payment amount greater than 0.");
    const amount = round2(amountRaw), method = body.method === "online" ? "online" : "cash";
    const note = String(body.note || ""), paidAt = parseDate(body.paidAt) ?? new Date();
    const result = await prisma.$transaction(async (tx) => {
      const payment = await tx.supplierPayment.create({ data: { supplierId: id, amount, method, note, paidAt, createdById: userId } });
      const updated = await tx.supplier.update({ where: { id }, data: { totalPaid: { increment: amount } } });
      return { payment, supplier: updated };
    }, TX_OPTS);
    return {
      result: { payment: result.payment, supplier: supplierView(result.supplier) },
      audit: {
        action: "inventory.supplier.payment", entityId: id, entityRef: supplier.name,
        summary: `Paid ₹${amount.toFixed(2)} (${method}) to ${supplier.name}`,
        detail:  { amount, method, note, paymentId: result.payment.id },
      },
    };
  },

  async deletePayment(id: string, paymentId: string): Promise<Write<unknown>> {
    const payment = await prisma.supplierPayment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.supplierId !== id) throw ApiError.notFound("Payment not found.");
    const amount = round2(Number(payment.amount));
    const supplier = await prisma.$transaction(async (tx) => {
      await tx.supplierPayment.delete({ where: { id: paymentId } });
      return tx.supplier.update({ where: { id }, data: { totalPaid: { decrement: amount } } });
    }, TX_OPTS);
    return {
      result: { ok: true, supplier: supplierView(supplier) },
      audit: {
        action: "inventory.supplier.payment.delete", entityId: id, entityRef: supplier.name,
        summary: `Removed a ₹${amount.toFixed(2)} ${payment.method} payment from ${supplier.name}`,
        detail:  { amount, method: payment.method, paymentId },
      },
    };
  },

  async createPurchase(body: PurchaseBody, userId: string): Promise<Write<unknown>> {
    const supplier = await prisma.supplier.findUnique({ where: { id: String(body.supplierId || "") } });
    if (!supplier) throw ApiError.notFound("Select a supplier for this purchase.");
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const lines: { itemId: string; qty: number; rate: number }[] = [];
    for (const r of rawItems as any[]) {
      const itemId = String(r?.itemId || "").trim(), qty = toNum(r?.quantity), rate = toNum(r?.rate);
      if (!itemId || qty === null || qty <= 0 || rate === null || rate < 0) continue;
      lines.push({ itemId, qty: round3(qty), rate: round2(rate) });
    }
    if (!lines.length) throw ApiError.badRequest("Add at least one item with a quantity and rate.");
    const ids = [...new Set(lines.map((l) => l.itemId))];
    const items = await prisma.inventoryItem.findMany({ where: { id: { in: ids } } });
    const itemMap = new Map(items.map((it) => [it.id, it]));
    if (ids.some((id) => !itemMap.has(id))) throw ApiError.badRequest("One or more selected items no longer exist.");
    const dType = body.discType === "percent" ? "percent" : "amount";
    const dVal  = round2(toNum(body.discVal) ?? 0);
    const tPct  = toNum(body.taxPct) ?? 0;
    let subtotal = 0;
    const lineData = lines.map((l) => { const amount = round2(l.qty * l.rate); subtotal += amount; return { ...l, amount }; });
    subtotal = round2(subtotal);
    let discountAmt = dType === "percent" ? round2((subtotal * dVal) / 100) : dVal;
    if (discountAmt > subtotal) discountAmt = subtotal;
    if (discountAmt < 0) discountAmt = 0;
    const taxable = round2(subtotal - discountAmt), taxAmt = round2((taxable * tPct) / 100), total = round2(taxable + taxAmt);
    const bd = parseDate(body.billDate) ?? new Date();
    const runBal = new Map<string, number>(), lastRate = new Map<string, number>();
    for (const id of ids) runBal.set(id, Number(itemMap.get(id)!.quantity));

    const result = await prisma.$transaction(async (tx) => {
      const purchase = await tx.supplierPurchase.create({
        data: {
          supplierId: supplier.id, billNo: String(body.billNo || "").trim(), billDate: bd,
          discType: dType as any, discVal: dVal, taxPct: tPct, subtotal, discountAmt, taxAmt, total,
          notes: body.notes || "", createdById: userId,
        },
      });
      await tx.supplierPurchaseItem.createMany({
        data: lineData.map((l): Prisma.SupplierPurchaseItemCreateManyInput => {
          const it = itemMap.get(l.itemId)!;
          return { purchaseId: purchase.id, itemId: l.itemId, name: it.name, unit: it.unit, quantity: l.qty, rate: l.rate, amount: l.amount };
        }),
      });
      const moveData: Prisma.StockMovementCreateManyInput[] = lineData.map((l) => {
        const before = runBal.get(l.itemId)!, after = round3(before + l.qty);
        runBal.set(l.itemId, after); lastRate.set(l.itemId, l.rate);
        return { itemId: l.itemId, type: "purchase", quantity: l.qty, delta: l.qty, balance: after, unitCost: l.rate, reference: String(body.billNo || "").trim(), supplierId: supplier.id, purchaseId: purchase.id, userId };
      });
      await tx.stockMovement.createMany({ data: moveData });
      for (const id of ids) await tx.inventoryItem.update({ where: { id }, data: { quantity: runBal.get(id)!, costPrice: lastRate.get(id)! } });
      for (const id of ids) {
        const rate = lastRate.get(id)!;
        await tx.itemSupplier.upsert({
          where:  { itemId_supplierId: { itemId: id, supplierId: supplier.id } },
          create: { itemId: id, supplierId: supplier.id, price: rate, lastRate: rate, lastPurchaseAt: bd },
          update: { lastRate: rate, lastPurchaseAt: bd },
        });
      }
      const updatedSupplier = await tx.supplier.update({ where: { id: supplier.id }, data: { totalPurchased: { increment: total }, lastPurchaseAt: bd } });
      return { purchase, supplier: updatedSupplier };
    }, TX_OPTS);

    return {
      result: { purchase: result.purchase, supplier: supplierView(result.supplier) },
      audit: {
        action: "inventory.purchase.create", entityId: result.purchase.id, entityRef: supplier.name,
        summary: `Purchase from ${supplier.name} · ₹${total.toFixed(2)} · ${lineData.length} item${lineData.length === 1 ? "" : "s"}${body.billNo ? ` · bill ${String(body.billNo).trim()}` : ""}`,
        detail:  { supplierId: supplier.id, billNo: String(body.billNo || "").trim(), subtotal, discountAmt, taxAmt, total, lines: lineData.length },
      },
    };
  },

  async getPurchase(id: string) {
    const purchase = await prisma.supplierPurchase.findUnique({
      where: { id },
      include: {
        supplier:  { select: { id: true, name: true, phone: true, email: true, gstin: true, address: true } },
        items:     { orderBy: { createdAt: "asc" } },
        createdBy: { select: { name: true } },
      },
    });
    if (!purchase) throw ApiError.notFound("Purchase not found.");
    return purchase;
  },

  async applyInvoiceStock(invoiceId: string, userId: string | null): Promise<InvoiceStockSync> {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId }, select: { id: true, invoiceNo: true, items: true, stockApplied: true },
    });
    if (!invoice) { console.warn(`[stock] apply skipped — invoice ${invoiceId} not found`); return emptyStockSync(); }
    if (invoice.stockApplied) { console.log(`[stock] apply skipped — ${invoice.invoiceNo} already applied`); return emptyStockSync(); }
    const totals = linkedLineTotals(invoice.items);
    if (totals.size === 0) {
      console.log(`[stock] ${invoice.invoiceNo}: no stock-linked lines`);
      await prisma.invoice.update({ where: { id: invoiceId }, data: { stockApplied: true } });
      return emptyStockSync();
    }
    const ids = [...totals.keys()];
    const items = await prisma.inventoryItem.findMany({ where: { id: { in: ids } } });
    const itemMap = new Map(items.map((it) => [it.id, it]));
    const note = `Billed on ${invoice.invoiceNo}`;
    const unresolved: UnresolvedLine[] = ids.filter((id) => !itemMap.has(id)).map((id) => ({ itemId: id, quantity: totals.get(id)! }));
    if (unresolved.length) console.warn(`[stock] ${invoice.invoiceNo}: ${unresolved.length} line(s) point at items that no longer exist`);
    console.log(`[stock] ${invoice.invoiceNo}: applying ${itemMap.size} of ${ids.length} linked line(s)`);
    const affected = await prisma.$transaction(async (tx) => {
      const moves: Prisma.StockMovementCreateManyInput[] = [];
      const rows: AffectedItem[] = [];
      for (const id of ids) {
        const it = itemMap.get(id); if (!it) continue;
        const qty = totals.get(id)!, before = Number(it.quantity), after = round3(before - qty);
        moves.push({ itemId: id, type: "consumption", quantity: qty, delta: round3(-qty), balance: after, unitCost: null, reference: invoice.invoiceNo, note, invoiceId, userId: userId ?? null });
        await tx.inventoryItem.update({ where: { id }, data: { quantity: after } });
        rows.push({ id, name: it.name, sku: it.sku, unit: it.unit, quantity: after, reorderLevel: Number(it.reorderLevel) });
      }
      if (moves.length) await tx.stockMovement.createMany({ data: moves });
      if (!unresolved.length) await tx.invoice.update({ where: { id: invoiceId }, data: { stockApplied: true } });
      return rows;
    }, TX_OPTS);
    for (const r of affected) console.log(`[stock]   ${r.name} (${r.sku}) → ${r.quantity} ${r.unit}`);
    return summarizeStockSync(affected, true, unresolved);
  },

  async reverseInvoiceStock(invoiceId: string, reason: string, userId: string | null): Promise<InvoiceStockSync> {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { id: true, invoiceNo: true, stockApplied: true } });
    if (!invoice || !invoice.stockApplied) return emptyStockSync();
    const note = `Restocked (${reason}) ${invoice.invoiceNo}`;
    const unresolved: UnresolvedLine[] = [];
    const affected = await prisma.$transaction(async (tx) => {
      const moves = await tx.stockMovement.findMany({ where: { invoiceId }, select: { itemId: true, delta: true } });
      const net = new Map<string, number>();
      for (const m of moves) net.set(m.itemId, round3((net.get(m.itemId) ?? 0) + Number(m.delta)));
      const held: [string, number][] = [];
      for (const [id, d] of net) { const h = round3(-d); if (h > 0.0005) held.push([id, h]); }
      if (!held.length) { await tx.invoice.update({ where: { id: invoiceId }, data: { stockApplied: false } }); return [] as AffectedItem[]; }
      const ids = held.map(([id]) => id);
      const items = await tx.inventoryItem.findMany({ where: { id: { in: ids } } });
      const itemMap = new Map(items.map((it) => [it.id, it]));
      const moveData: Prisma.StockMovementCreateManyInput[] = [];
      const rows: AffectedItem[] = [];
      for (const [id, qty] of held) {
        const it = itemMap.get(id);
        if (!it) { unresolved.push({ itemId: id, quantity: qty }); continue; }
        const before = Number(it.quantity), after = round3(before + qty);
        moveData.push({ itemId: id, type: "returned", quantity: qty, delta: qty, balance: after, unitCost: null, reference: invoice.invoiceNo, note, invoiceId, userId: userId ?? null });
        await tx.inventoryItem.update({ where: { id }, data: { quantity: after } });
        rows.push({ id, name: it.name, sku: it.sku, unit: it.unit, quantity: after, reorderLevel: Number(it.reorderLevel) });
      }
      if (moveData.length) await tx.stockMovement.createMany({ data: moveData });
      await tx.invoice.update({ where: { id: invoiceId }, data: { stockApplied: false } });
      return rows;
    }, TX_OPTS);
    if (unresolved.length) console.warn(`[stock] ${invoice.invoiceNo}: ${unresolved.length} item(s) could not be restocked`);
    return summarizeStockSync(affected, false, unresolved);
  },

  async renameCategory(oldName: string, newName: string): Promise<{ ok: true; updated: number }> {
    if (!oldName.trim() || !newName.trim()) throw ApiError.badRequest("Both oldName and newName are required.");
    if (oldName.trim() === newName.trim()) throw ApiError.badRequest("New name is the same as the old name.");
    const existing = await prisma.inventoryItem.count({
      where: { category: { equals: newName.trim(), mode: "insensitive" } },
    });
    if (existing > 0) throw ApiError.conflict(`Category "${newName.trim()}" already exists.`);
    const result = await prisma.inventoryItem.updateMany({
      where: { category: { equals: oldName.trim(), mode: "insensitive" } },
      data:  { category: newName.trim() },
    });
    return { ok: true, updated: result.count };
  },

};

export type InventoryService = typeof inventoryService;