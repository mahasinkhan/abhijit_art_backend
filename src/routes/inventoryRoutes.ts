// backend/src/routes/inventoryRoutes.ts
import { Router, type Request, type Response } from "express";
import type { MovementType, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";
import { isPinSet, verifyPin, logAudit } from "../utils/security.js";

const router = Router();

/* every route here is admin-only */
router.use(protect, adminOnly);

const userPublic = { select: { name: true, email: true } };

/* ── security gate ──────────────────────────────────────────────
   Every state-changing inventory action requires the same billing PIN,
   entered per action and verified server-side, and is written to the audit
   log. Reads (list, dashboard, history, CSV) stay open. Returns true if it
   has already sent an error response — the caller must then stop. */
async function requirePin(req: Request, res: Response): Promise<boolean> {
  const pin = String(req.body?.pin ?? "").trim();
  if (!(await isPinSet())) {
    res.status(409).json({ message: "Set a security PIN in Settings before making inventory changes." });
    return true;
  }
  if (!(await verifyPin(pin))) {
    res.status(403).json({ message: "Incorrect PIN." });
    return true;
  }
  return false;
}

/* movement types and how each one moves the balance */
const MOVEMENT_TYPES = [
  "opening",
  "purchase",
  "consumption",
  "wastage",
  "returned",
  "adjustment",
] as const;
const ADDS = new Set(["opening", "purchase", "returned"]); // push balance up
const SUBTRACTS = new Set(["consumption", "wastage"]); // push balance down
// "adjustment" is neither — the client sends a signed delta directly

/* human labels for the audit summary */
const MOVE_LABEL: Record<string, string> = {
  opening: "Opening",
  purchase: "Purchase",
  consumption: "Consumption",
  wastage: "Wastage",
  returned: "Return",
  adjustment: "Adjustment",
};

const STOCK_UNITS = ["piece", "sqft", "metre", "roll", "sheet", "litre", "kg", "box", "set"];

/* Interactive-transaction limits. Prisma defaults (maxWait 2s / timeout 5s)
   are too tight for a serverless Postgres like Neon: each statement is a
   network round trip and an idle/cold connection can spend seconds waking up,
   which surfaces as P2028 "Transaction not found". */
const TX_OPTS = { maxWait: 15_000, timeout: 30_000 } as const;

/* numbers arrive from the client as strings — coerce and guard */
const toNum = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ═══════════════ date/bucket helpers for the dashboard filter ═══════════════ */
type Gran = "day" | "week" | "month" | "year";

const asGran = (v: unknown): Gran => {
  const g = String(v || "").toLowerCase();
  if (g === "day" || g === "daily") return "day";
  if (g === "week" || g === "weekly") return "week";
  if (g === "year" || g === "yearly") return "year";
  return "month";
};

const pad = (n: number) => String(n).padStart(2, "0");
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek = (d: Date) => {
  const dow = (d.getDay() + 6) % 7; // Monday = 0 … Sunday = 6
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
};
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const startOfYear = (d: Date) => new Date(d.getFullYear(), 0, 1);

/* first instant of the bucket a date falls into */
const bucketStart = (d: Date, g: Gran) =>
  g === "day" ? startOfDay(d)
  : g === "week" ? startOfWeek(d)
  : g === "month" ? startOfMonth(d)
  : startOfYear(d);

/* first instant of the NEXT bucket (used for stepping + the exclusive upper bound) */
const nextBucket = (d: Date, g: Gran) =>
  g === "day" ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  : g === "week" ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)
  : g === "month" ? new Date(d.getFullYear(), d.getMonth() + 1, 1)
  : new Date(d.getFullYear() + 1, 0, 1);

/* stable key for a bucket (week keyed by its Monday's date) */
const bucketKey = (d: Date, g: Gran) => {
  const b = bucketStart(d, g);
  if (g === "year") return `${b.getFullYear()}`;
  if (g === "month") return `${b.getFullYear()}-${pad(b.getMonth() + 1)}`;
  return `${b.getFullYear()}-${pad(b.getMonth() + 1)}-${pad(b.getDate())}`; // day + week
};

/* short human label for the x-axis */
const bucketLabel = (b: Date, g: Gran) =>
  g === "year" ? `${b.getFullYear()}`
  : g === "month" ? b.toLocaleDateString("en-IN", { month: "short" })
  : b.toLocaleDateString("en-IN", { day: "numeric", month: "short" }); // day + week

const parseDate = (v: unknown): Date | null => {
  const s = String(v || "").trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};

/* sensible default window per granularity when no dates are supplied */
const defaultRange = (g: Gran, now: Date): { from: Date; to: Date } => {
  const to = startOfDay(now);
  if (g === "day") return { from: new Date(to.getFullYear(), to.getMonth(), to.getDate() - 13), to }; // 14 days
  if (g === "week") {
    const ws = startOfWeek(now);
    return { from: new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() - 7 * 11), to }; // 12 weeks
  }
  if (g === "year") return { from: new Date(now.getFullYear() - 4, 0, 1), to }; // 5 years
  return { from: new Date(now.getFullYear(), now.getMonth() - 5, 1), to }; // 6 months
};

/* ═══════════════════════════════ ITEMS ═══════════════════════════════ */

/* list — with optional ?q= search, ?category=, ?low=1, ?active= */
router.get("/items", async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || "").trim();
    const category = String(req.query.category || "").trim();
    const activeParam = String(req.query.active ?? "");

    const where: Prisma.InventoryItemWhereInput = {};
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { sku: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
      ];
    }
    if (category) where.category = { equals: category, mode: "insensitive" };
    if (activeParam === "true") where.active = true;
    if (activeParam === "false") where.active = false;

    const items = await prisma.inventoryItem.findMany({
      where,
      include: { supplier: { select: { name: true } } },
      orderBy: { name: "asc" },
    });

    // low-stock is a computed flag, easiest to add here than in SQL
    const withFlags = items.map((it) => ({
      ...it,
      low: Number(it.quantity) <= Number(it.reorderLevel),
    }));

    // optional ?low=1 filter, applied after the computed flag
    const lowOnly = String(req.query.low || "") === "1";
    res.json(lowOnly ? withFlags.filter((i) => i.low) : withFlags);
  } catch (err) {
    console.error("Inventory list error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* dashboard summary — totals, valuation, low-stock count */
router.get("/summary", async (_req: Request, res: Response) => {
  try {
    const items = await prisma.inventoryItem.findMany({
      where: { active: true },
      select: { quantity: true, reorderLevel: true, costPrice: true },
    });

    let stockValue = 0;
    let lowCount = 0;
    let outCount = 0;
    for (const it of items) {
      const qty = Number(it.quantity);
      stockValue += qty * Number(it.costPrice);
      if (qty <= 0) outCount += 1;
      else if (qty <= Number(it.reorderLevel)) lowCount += 1;
    }

    res.json({
      totalItems: items.length,
      lowCount,
      outCount,
      stockValue: Math.round(stockValue),
    });
  } catch (err) {
    console.error("Inventory summary error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ═══════════════════════════ OVERVIEW DASHBOARD ═══════════════════════════
   Powers InventoryDashboard.tsx. Accepts an optional period filter:
     ?granularity=day|week|month|year   (default month)
     ?from=YYYY-MM-DD & ?to=YYYY-MM-DD   (default: sensible window per granularity)

   The FLOW section (purchase / consumption / wastage KPIs, the trend, net
   investment) is scoped to [from, to] and bucketed by granularity. The on-hand
   SNAPSHOT (stock value, categories, top items, low list) is always current —
   an as-of-date valuation would need full balance reconstruction. `recent` is
   always the latest 12 movements.

   Numbers are computed in JS after fetch because quantities and prices are
   Decimals (Prisma serialises them as strings), so every numeric field is
   coerced with Number() before it leaves here.
   ────────────────────────────────────────────────────────────────────── */
router.get("/dashboard", async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const gran = asGran(req.query.granularity ?? req.query.gran);
    const def = defaultRange(gran, now);

    // align requested range to bucket edges; keep from ≤ to
    let from = bucketStart(parseDate(req.query.from) ?? def.from, gran);
    let toBucket = bucketStart(parseDate(req.query.to) ?? def.to, gran);
    if (toBucket < from) { const t = from; from = toBucket; toBucket = t; }
    const rangeEnd = nextBucket(toBucket, gran); // exclusive upper bound

    // pre-build ordered buckets so the trend always spans the full range,
    // empty months/days included. Cap protects the payload from silly ranges.
    const MAX_BUCKETS = 400;
    const buckets: { key: string; label: string; start: Date }[] = [];
    for (let cur = new Date(from); cur < rangeEnd && buckets.length < MAX_BUCKETS; cur = nextBucket(cur, gran)) {
      buckets.push({ key: bucketKey(cur, gran), label: bucketLabel(cur, gran), start: new Date(cur) });
    }
    const effectiveFrom = buckets.length ? buckets[0].start : from;

    // active items → KPIs, categories, top-by-value, low list (all "as of now")
    const items = await prisma.inventoryItem.findMany({
      where: { active: true },
      select: {
        id: true, name: true, sku: true, unit: true, category: true,
        quantity: true, reorderLevel: true, costPrice: true,
      },
    });

    let stockValue = 0;
    let lowCount = 0;
    let outCount = 0;
    const catMap = new Map<string, { value: number; count: number }>();

    const valued = items.map((it) => {
      const qty = Number(it.quantity);
      const cost = Number(it.costPrice);
      const reorder = Number(it.reorderLevel);
      const value = qty * cost;
      const out = qty <= 0;

      stockValue += value;
      if (out) outCount += 1;
      else if (qty <= reorder) lowCount += 1;

      const cat = (it.category || "").trim() || "Uncategorised";
      const c = catMap.get(cat) || { value: 0, count: 0 };
      c.value += value;
      c.count += 1;
      catMap.set(cat, c);

      return { ...it, qty, cost, reorder, value, out };
    });

    const categories = [...catMap.entries()]
      .map(([name, v]) => ({ name, value: Math.round(v.value), count: v.count }))
      .filter((c) => c.value > 0)
      .sort((a, b) => b.value - a.value);

    const topByValue = valued
      .filter((it) => it.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map((it) => ({ id: it.id, name: it.name, sku: it.sku, unit: it.unit, quantity: it.qty, value: Math.round(it.value) }));

    const lowItems = valued
      .filter((it) => it.out || it.qty <= it.reorder)
      .sort((a, b) => Number(b.out) - Number(a.out) || a.qty - b.qty)
      .map((it) => ({ id: it.id, name: it.name, sku: it.sku, unit: it.unit, quantity: it.qty, reorderLevel: it.reorder, out: it.out }));

    // movements inside the window — trend + the money KPIs.
    // pull the item cost so consumption/wastage (no unitCost of their own)
    // can still be valued at the item's current cost.
    const periodMoves = await prisma.stockMovement.findMany({
      where: { createdAt: { gte: effectiveFrom, lt: rangeEnd } },
      select: {
        type: true, quantity: true, unitCost: true, createdAt: true,
        item: { select: { costPrice: true } },
      },
    });

    const trendMap = new Map(
      buckets.map((b) => [b.key, { key: b.key, label: b.label, purchase: 0, consumption: 0, wastage: 0 }]),
    );
    let purchaseValue = 0;
    let consumptionValue = 0;
    let wastageValue = 0;

    for (const m of periodMoves) {
      const qty = Number(m.quantity);
      const unit = m.unitCost != null ? Number(m.unitCost) : Number(m.item?.costPrice ?? 0);
      const value = qty * unit;
      const b = trendMap.get(bucketKey(m.createdAt, gran));

      if (m.type === "purchase") {
        purchaseValue += value;
        if (b) b.purchase += value;
      } else if (m.type === "consumption") {
        consumptionValue += value;
        if (b) b.consumption += value;
      } else if (m.type === "wastage") {
        wastageValue += value;
        if (b) b.wastage += value;
      }
    }

    const trend = buckets.map((b) => {
      const t = trendMap.get(b.key)!;
      return {
        key: b.key,
        label: b.label,
        purchase: Math.round(t.purchase),
        consumption: Math.round(t.consumption),
        wastage: Math.round(t.wastage),
      };
    });

    // recent activity feed — always latest 12, Decimals coerced to numbers
    const recentRaw = await prisma.stockMovement.findMany({
      take: 12,
      orderBy: { createdAt: "desc" },
      include: {
        item: { select: { name: true, sku: true, unit: true } },
        supplier: { select: { name: true } },
        user: userPublic,
        booking: { select: { serviceName: true } },
      },
    });
    const recent = recentRaw.map((m) => ({
      id: m.id,
      type: m.type,
      quantity: Number(m.quantity),
      delta: Number(m.delta),
      balance: Number(m.balance),
      unitCost: m.unitCost != null ? Number(m.unitCost) : null,
      reference: m.reference,
      createdAt: m.createdAt,
      item: m.item,
      supplier: m.supplier,
      user: m.user,
      booking: m.booking,
    }));

    res.json({
      range: { from: effectiveFrom.toISOString(), to: toBucket.toISOString(), granularity: gran },
      kpis: {
        totalItems: items.length,
        stockValue: Math.round(stockValue),
        lowCount,
        outCount,
        purchaseValue: Math.round(purchaseValue),
        consumptionValue: Math.round(consumptionValue),
        wastageValue: Math.round(wastageValue),
        movementCount: periodMoves.length,
      },
      trend,
      categories,
      topByValue,
      lowItems,
      recent,
    });
  } catch (err) {
    console.error("Inventory dashboard error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* distinct category list for the filter dropdown */
router.get("/categories", async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.inventoryItem.findMany({
      where: { category: { not: "" } },
      distinct: ["category"],
      select: { category: true },
      orderBy: { category: "asc" },
    });
    res.json(rows.map((r) => r.category));
  } catch (err) {
    console.error("Inventory categories error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* single item + its full movement ledger */
router.get("/items/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const item = await prisma.inventoryItem.findUnique({
      where: { id },
      include: {
        supplier: { select: { name: true } },
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
    if (!item) return res.status(404).json({ message: "Item not found." });
    res.json({ ...item, low: Number(item.quantity) <= Number(item.reorderLevel) });
  } catch (err) {
    console.error("Inventory item error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* create an item — opening stock, if given, is recorded as a movement */
router.post("/items", async (req: Request, res: Response) => {
  try {
    if (await requirePin(req, res)) return;

    const {
      sku,
      name,
      description,
      category,
      unit,
      openingQty,
      reorderLevel,
      costPrice,
      sellPrice,
      location,
      imageUrl,
      supplierId,
    } = req.body;

    if (!String(sku || "").trim()) return res.status(400).json({ message: "SKU is required." });
    if (!String(name || "").trim()) return res.status(400).json({ message: "Name is required." });

    const unitVal = STOCK_UNITS.includes(String(unit)) ? String(unit) : "piece";

    // SKU is unique — give a clean message instead of a Prisma P2002 dump
    const clash = await prisma.inventoryItem.findUnique({ where: { sku: String(sku).trim() } });
    if (clash) return res.status(409).json({ message: "An item with this SKU already exists." });

    const opening = toNum(openingQty) ?? 0;
    const cost = toNum(costPrice) ?? 0;

    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.inventoryItem.create({
        data: {
          sku: String(sku).trim(),
          name: String(name).trim(),
          description: description || "",
          category: (category || "").trim(),
          unit: unitVal as any,
          quantity: opening,
          reorderLevel: toNum(reorderLevel) ?? 0,
          costPrice: cost,
          sellPrice: toNum(sellPrice), // null-safe
          location: location || "",
          imageUrl: imageUrl || "",
          supplierId: supplierId || null,
        },
      });

      if (opening > 0) {
        await tx.stockMovement.create({
          data: {
            itemId: created.id,
            type: "opening",
            quantity: opening,
            delta: opening,
            balance: opening,
            unitCost: cost || null,
            note: "Opening balance",
            userId: req.user!.id,
          },
        });
      }
      return created;
    }, TX_OPTS);

    await logAudit({
      req,
      entity: "inventory",
      action: "inventory.item.create",
      entityId: item.id,
      entityRef: item.sku,
      summary: `Added item ${item.name} (${item.sku})${opening > 0 ? ` · opening ${opening} ${item.unit}` : ""}`,
      detail: { sku: item.sku, name: item.name, opening, costPrice: cost },
    });

    res.status(201).json(item);
  } catch (err) {
    console.error("Inventory create error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* update item DETAILS only — never touches quantity (that goes via /move) */
router.patch("/items/:id", async (req: Request, res: Response) => {
  try {
    if (await requirePin(req, res)) return;

    const id = String(req.params.id);
    const existing = await prisma.inventoryItem.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Item not found." });

    const { sku, name, description, category, unit, reorderLevel, costPrice, sellPrice, location, imageUrl, supplierId, active } =
      req.body;

    // if SKU is changing, keep it unique
    if (sku && String(sku).trim() !== existing.sku) {
      const clash = await prisma.inventoryItem.findUnique({ where: { sku: String(sku).trim() } });
      if (clash) return res.status(409).json({ message: "An item with this SKU already exists." });
    }

    const data: Prisma.InventoryItemUpdateInput = {};
    if (sku !== undefined) data.sku = String(sku).trim();
    if (name !== undefined) data.name = String(name).trim();
    if (description !== undefined) data.description = description || "";
    if (category !== undefined) data.category = (category || "").trim();
    if (unit !== undefined && STOCK_UNITS.includes(String(unit))) data.unit = String(unit) as any;
    if (reorderLevel !== undefined) data.reorderLevel = toNum(reorderLevel) ?? 0;
    if (costPrice !== undefined) data.costPrice = toNum(costPrice) ?? 0;
    if (sellPrice !== undefined) data.sellPrice = toNum(sellPrice);
    if (location !== undefined) data.location = location || "";
    if (imageUrl !== undefined) data.imageUrl = imageUrl || "";
    if (active !== undefined) data.active = !!active;
    if (supplierId !== undefined) {
      data.supplier = supplierId ? { connect: { id: supplierId } } : { disconnect: true };
    }

    const item = await prisma.inventoryItem.update({ where: { id }, data });

    await logAudit({
      req,
      entity: "inventory",
      action: "inventory.item.update",
      entityId: item.id,
      entityRef: item.sku,
      summary: `Edited item ${item.name} (${item.sku})`,
    });

    res.json(item);
  } catch (err) {
    console.error("Inventory update error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* delete an item (cascades its movements) */
router.delete("/items/:id", async (req: Request, res: Response) => {
  try {
    if (await requirePin(req, res)) return;

    const id = String(req.params.id);
    const existing = await prisma.inventoryItem.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Item not found." });
    await prisma.inventoryItem.delete({ where: { id } });

    await logAudit({
      req,
      entity: "inventory",
      action: "inventory.item.delete",
      entityId: existing.id,
      entityRef: existing.sku,
      summary: `Deleted item ${existing.name} (${existing.sku})`,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Inventory delete error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ═══════════════════════════ STOCK MOVEMENT ═══════════════════════════
   The ONE place stock quantity ever changes. Item balance and the
   ledger row are written together in a transaction, so they can never
   disagree. Everything else (dashboard, valuation, history) reads from
   the result of this.
   ────────────────────────────────────────────────────────────────── */
router.post("/items/:id/move", async (req: Request, res: Response) => {
  try {
    if (await requirePin(req, res)) return;

    const id = String(req.params.id);
    const type = String(req.body.type || "").toLowerCase() as MovementType;
    if (!MOVEMENT_TYPES.includes(type as any)) {
      return res.status(400).json({ message: "Invalid movement type." });
    }

    const { reference, note, supplierId, bookingId, unitCost } = req.body;

    const item = await prisma.inventoryItem.findUnique({ where: { id } });
    if (!item) return res.status(404).json({ message: "Item not found." });

    const current = Number(item.quantity);

    // work out the signed delta this movement applies
    let delta: number;
    if (type === "adjustment") {
      // client sends either a signed `delta`, or a target `newQuantity`
      const dRaw = toNum(req.body.delta);
      const target = toNum(req.body.newQuantity);
      if (dRaw !== null) delta = dRaw;
      else if (target !== null) delta = target - current;
      else return res.status(400).json({ message: "Adjustment needs a delta or a new quantity." });
      if (delta === 0) return res.status(400).json({ message: "Adjustment must change the quantity." });
    } else {
      const qty = toNum(req.body.quantity);
      if (qty === null || qty <= 0) {
        return res.status(400).json({ message: "Quantity must be a positive number." });
      }
      if (ADDS.has(type)) delta = qty;
      else if (SUBTRACTS.has(type)) delta = -qty;
      else delta = qty; // defensive; every type is covered above
    }

    const newBalance = current + delta;
    if (newBalance < 0) {
      return res.status(400).json({
        message: `Not enough stock. Available: ${current} ${item.unit}, tried to remove ${Math.abs(delta)}.`,
      });
    }

    const cost = toNum(unitCost);

    /* Keep the transaction as small as possible: just the balance update and
       the ledger insert, no joins. Neon is a network hop per query, so any
       extra work in here eats the transaction budget and risks P2028
       ("Transaction not found") on a cold or slow connection. */
    const result = await prisma.$transaction(
      async (tx) => {
        const updated = await tx.inventoryItem.update({
          where: { id },
          data: {
            quantity: newBalance,
            // remember the latest purchase cost so valuation stays current
            ...(type === "purchase" && cost !== null ? { costPrice: cost } : {}),
          },
        });

        const created = await tx.stockMovement.create({
          data: {
            itemId: id,
            type,
            quantity: Math.abs(delta),
            delta,
            balance: newBalance,
            unitCost: type === "purchase" ? cost : null,
            reference: reference || "",
            note: note || "",
            supplierId: supplierId || null,
            bookingId: bookingId || null,
            userId: req.user!.id,
          },
        });

        return { item: updated, movementId: created.id };
      },
      TX_OPTS,
    );

    await logAudit({
      req,
      entity: "inventory",
      action: "inventory.move",
      entityId: id,
      entityRef: item.sku,
      summary: `${MOVE_LABEL[type] || type} ${Math.abs(delta)} ${item.unit} · ${item.name} → balance ${newBalance} ${item.unit}`,
      detail: { type, delta, newBalance, unitCost: cost, reference: reference || "", supplierId: supplierId || null },
    });

    // hydrate the ledger row for the client AFTER the commit — the balance is
    // already durable at this point, so a slow join can't roll anything back
    const movement = await prisma.stockMovement.findUnique({
      where: { id: result.movementId },
      include: {
        supplier: { select: { name: true } },
        user: userPublic,
        booking: { select: { id: true, serviceName: true } },
      },
    });

    res.status(201).json({ item: result.item, movement });
  } catch (err) {
    console.error("Stock move error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* recent movements across all items — for an activity feed */
router.get("/movements", async (req: Request, res: Response) => {
  try {
    const take = Math.min(Number(req.query.limit) || 50, 200);
    const movements = await prisma.stockMovement.findMany({
      take,
      orderBy: { createdAt: "desc" },
      include: {
        item: { select: { id: true, name: true, sku: true, unit: true } },
        supplier: { select: { name: true } },
        user: userPublic,
        booking: { select: { id: true, serviceName: true } },
      },
    });
    res.json(movements);
  } catch (err) {
    console.error("Movements list error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ═══════════════════════════════ SUPPLIERS ═══════════════════════════════ */

router.get("/suppliers", async (_req: Request, res: Response) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { items: true } } },
    });
    res.json(suppliers);
  } catch (err) {
    console.error("Suppliers list error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/suppliers", async (req: Request, res: Response) => {
  try {
    if (await requirePin(req, res)) return;

    const { name, phone, email, gstin, address, notes } = req.body;
    if (!String(name || "").trim()) return res.status(400).json({ message: "Supplier name is required." });
    const supplier = await prisma.supplier.create({
      data: {
        name: String(name).trim(),
        phone: phone || "",
        email: email || "",
        gstin: gstin || "",
        address: address || "",
        notes: notes || "",
      },
    });

    await logAudit({
      req,
      entity: "inventory",
      action: "inventory.supplier.create",
      entityId: supplier.id,
      entityRef: supplier.name,
      summary: `Added supplier ${supplier.name}`,
    });

    res.status(201).json(supplier);
  } catch (err) {
    console.error("Supplier create error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.patch("/suppliers/:id", async (req: Request, res: Response) => {
  try {
    if (await requirePin(req, res)) return;

    const id = String(req.params.id);
    const existing = await prisma.supplier.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Supplier not found." });

    const { name, phone, email, gstin, address, notes, active } = req.body;
    const data: Prisma.SupplierUpdateInput = {};
    if (name !== undefined) data.name = String(name).trim();
    if (phone !== undefined) data.phone = phone || "";
    if (email !== undefined) data.email = email || "";
    if (gstin !== undefined) data.gstin = gstin || "";
    if (address !== undefined) data.address = address || "";
    if (notes !== undefined) data.notes = notes || "";
    if (active !== undefined) data.active = !!active;

    const supplier = await prisma.supplier.update({ where: { id }, data });

    await logAudit({
      req,
      entity: "inventory",
      action: "inventory.supplier.update",
      entityId: supplier.id,
      entityRef: supplier.name,
      summary: `Edited supplier ${supplier.name}`,
    });

    res.json(supplier);
  } catch (err) {
    console.error("Supplier update error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.delete("/suppliers/:id", async (req: Request, res: Response) => {
  try {
    if (await requirePin(req, res)) return;

    const id = String(req.params.id);
    const existing = await prisma.supplier.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Supplier not found." });
    // items keep working — their supplierId is set null by the schema relation
    await prisma.supplier.delete({ where: { id } });

    await logAudit({
      req,
      entity: "inventory",
      action: "inventory.supplier.delete",
      entityId: existing.id,
      entityRef: existing.name,
      summary: `Deleted supplier ${existing.name}`,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Supplier delete error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;