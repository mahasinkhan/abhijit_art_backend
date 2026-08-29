// backend/src/routes/expenseRoutes.ts
import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";
import { normalisePhone } from "./payeeRoutes.js";

const router = Router();
router.use(protect, adminOnly);

const CATEGORIES = [
  "salary", "advance", "rent", "utilities", "transport",
  "materials", "food", "maintenance", "marketing", "other",
] as const;
type Category = (typeof CATEGORIES)[number];

const METHODS = ["cash", "online"] as const;
type Method = (typeof METHODS)[number];

const num    = (v: any) => Number(v ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

const asCategory = (v: any): Category => (CATEGORIES.includes(v) ? v : "other");
const asMethod   = (v: any): Method   => (METHODS.includes(v) ? v : "cash");

function dayStart(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function dayEnd(d: Date)   { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

/** ?from / ?to as YYYY-MM-DD. Defaults to the current month. */
function readRange(q: any) {
  const now  = new Date();
  const from = q.from ? dayStart(new Date(q.from)) : dayStart(new Date(now.getFullYear(), now.getMonth(), 1));
  const to   = q.to   ? dayEnd(new Date(q.to))     : dayEnd(now);
  return { from, to };
}

const include = {
  payee:     { select: { id: true, name: true, phone: true, kind: true, role: true, userId: true } },
  createdBy: { select: { id: true, name: true } },
};

/** Decimal → number so the frontend never parses strings. */
const shape = (e: any) => ({ ...e, amount: num(e.amount) });

/* ───────────────────────── list ───────────────────────── */
// GET /api/expenses?from=&to=&category=&method=&search=&payeeId=
router.get("/", async (req, res) => {
  try {
    const { from, to } = readRange(req.query);
    const { category, method, search, payeeId } = req.query as Record<string, string>;

    const where: any = { date: { gte: from, lte: to } };
    if (category && CATEGORIES.includes(category as Category)) where.category = category;
    if (method && METHODS.includes(method as Method))          where.method   = method;
    if (payeeId) where.payeeId = payeeId;
    if (search) {
      const digits = normalisePhone(search);
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { notes: { contains: search, mode: "insensitive" } },
        { payee: { name: { contains: search, mode: "insensitive" } } },
        ...(digits ? [{ payee: { phone: { contains: digits } } }] : []),
      ];
    }

    const rows = await prisma.expense.findMany({
      where, include, orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });
    res.json(rows.map(shape));
  } catch (err) {
    console.error("expenses list", err);
    res.status(500).json({ error: "Failed to load expenses" });
  }
});

/* ───────────────────── summary / totals ───────────────────── */
// Registered BEFORE /:id so "summary" is never read as an id.
router.get("/summary", async (req, res) => {
  try {
    const { from, to } = readRange(req.query);
    const now = new Date();

    const [rows, todayRows] = await Promise.all([
      prisma.expense.findMany({ where: { date: { gte: from, lte: to } }, include }),
      prisma.expense.findMany({ where: { date: { gte: dayStart(now), lte: dayEnd(now) } } }),
    ]);

    const total  = round2(rows.reduce((s, r) => s + num(r.amount), 0));
    const cash   = round2(rows.filter((r) => r.method === "cash").reduce((s, r) => s + num(r.amount), 0));
    const today  = round2(todayRows.reduce((s, r) => s + num(r.amount), 0));

    // by category
    const catMap = new Map<string, { category: string; amount: number; count: number }>();
    rows.forEach((r) => {
      const k = r.category as string;
      if (!catMap.has(k)) catMap.set(k, { category: k, amount: 0, count: 0 });
      const c = catMap.get(k)!;
      c.amount = round2(c.amount + num(r.amount));
      c.count += 1;
    });

    // by person — grouped by payee id, which is one phone number
    const payMap = new Map<string, {
      id: string; name: string; phone: string; kind: string;
      amount: number; count: number;
    }>();
    rows.forEach((r: any) => {
      const p = r.payee;
      if (!p) return;
      if (!payMap.has(p.id)) {
        payMap.set(p.id, { id: p.id, name: p.name, phone: p.phone, kind: p.kind, amount: 0, count: 0 });
      }
      const e = payMap.get(p.id)!;
      e.amount = round2(e.amount + num(r.amount));
      e.count += 1;
    });

    // day-by-day
    const dayMap = new Map<string, number>();
    rows.forEach((r) => {
      const k = new Date(r.date).toISOString().slice(0, 10);
      dayMap.set(k, round2((dayMap.get(k) || 0) + num(r.amount)));
    });

    res.json({
      from, to,
      total, cash, online: round2(total - cash), today,
      count: rows.length,
      byCategory: Array.from(catMap.values()).sort((a, b) => b.amount - a.amount),
      byPayee:    Array.from(payMap.values()).sort((a, b) => b.amount - a.amount),
      daily: Array.from(dayMap.entries())
        .map(([date, amount]) => ({ date, amount }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (err) {
    console.error("expenses summary", err);
    res.status(500).json({ error: "Failed to load summary" });
  }
});

/* ───────────────────────── read one ───────────────────────── */
router.get("/:id", async (req, res) => {
  try {
    const row = await prisma.expense.findUnique({ where: { id: req.params.id }, include });
    if (!row) return res.status(404).json({ error: "Expense not found" });
    res.json(shape(row));
  } catch (err) {
    console.error("expense get", err);
    res.status(500).json({ error: "Failed to load expense" });
  }
});

/* ───────────────────────── create ───────────────────────── */
// POST /api/expenses  { date?, category, title, amount, method, payeeId, notes? }
router.post("/", async (req: any, res) => {
  try {
    const { date, category, title, amount, method, payeeId, notes } = req.body || {};

    const amt = round2(Number(amount));
    if (!title || !String(title).trim())   return res.status(400).json({ error: "Title is required" });
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "Enter an amount greater than 0" });
    if (!payeeId)                          return res.status(400).json({ error: "Choose who got the money" });

    const payee = await prisma.payee.findUnique({ where: { id: payeeId }, select: { id: true } });
    if (!payee) return res.status(400).json({ error: "That person is not in the list — add them first" });

    const row = await prisma.expense.create({
      data: {
        date: date ? new Date(date) : new Date(),
        category: asCategory(category),
        title: String(title).trim(),
        amount: amt,
        method: asMethod(method),
        payeeId: payee.id,
        notes: String(notes || "").trim(),
        createdById: req.user?.id || null,
      },
      include,
    });

    res.status(201).json(shape(row));
  } catch (err) {
    console.error("expense create", err);
    res.status(500).json({ error: "Failed to save expense" });
  }
});

/* ───────────────────────── update ───────────────────────── */
router.patch("/:id", async (req, res) => {
  try {
    const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Expense not found" });

    const { date, category, title, amount, method, payeeId, notes } = req.body || {};
    const data: any = {};

    if (date !== undefined)     data.date     = new Date(date);
    if (category !== undefined) data.category = asCategory(category);
    if (method !== undefined)   data.method   = asMethod(method);
    if (notes !== undefined)    data.notes    = String(notes || "").trim();

    if (title !== undefined) {
      if (!String(title).trim()) return res.status(400).json({ error: "Title is required" });
      data.title = String(title).trim();
    }
    if (amount !== undefined) {
      const amt = round2(Number(amount));
      if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "Enter an amount greater than 0" });
      data.amount = amt;
    }
    if (payeeId !== undefined) {
      if (!payeeId) return res.status(400).json({ error: "Choose who got the money" });
      const payee = await prisma.payee.findUnique({ where: { id: payeeId }, select: { id: true } });
      if (!payee) return res.status(400).json({ error: "That person is not in the list" });
      data.payeeId = payee.id;
    }

    const row = await prisma.expense.update({ where: { id: req.params.id }, data, include });
    res.json(shape(row));
  } catch (err) {
    console.error("expense update", err);
    res.status(500).json({ error: "Failed to update expense" });
  }
});

/* ───────────────────────── delete ───────────────────────── */
router.delete("/:id", async (req, res) => {
  try {
    const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Expense not found" });
    await prisma.expense.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error("expense delete", err);
    res.status(500).json({ error: "Failed to delete expense" });
  }
});

export default router;