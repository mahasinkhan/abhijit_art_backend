// backend/src/routes/incomeExpenseRoutes.ts
// Day-to-day cash book: money in and money out. Nothing here touches
// Invoices or Quick Orders — this is the shop's own pocket diary.
import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";
import { normalisePhone } from "./payeeRoutes.js";

const router = Router();
router.use(protect, adminOnly);

const EXPENSE_CATS = [
  "salary", "advance", "lent", "rent", "utilities",
  "transport", "materials", "food", "maintenance", "marketing", "other",
] as const;

const INCOME_CATS = ["sale", "loan_back", "refund", "other_income"] as const;

type Kind     = "income" | "expense";
type Category = (typeof EXPENSE_CATS)[number] | (typeof INCOME_CATS)[number];

const METHODS = ["cash", "online"] as const;
type Method = (typeof METHODS)[number];

const num    = (v: any) => Number(v ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

const asKind   = (v: any): Kind   => (v === "income" ? "income" : "expense");
const asMethod = (v: any): Method => (METHODS.includes(v) ? v : "cash");

/** A category only counts if it belongs to the direction being saved. */
function asCategory(v: any, kind: Kind): Category {
  const allowed: readonly string[] = kind === "income" ? INCOME_CATS : EXPENSE_CATS;
  if (allowed.includes(v)) return v;
  return kind === "income" ? "other_income" : "other";
}

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

const shape = (e: any) => ({ ...e, amount: num(e.amount) });

/* ───────────────────────── list ───────────────────────── */
// GET /api/expenses?from=&to=&kind=&category=&method=&search=&payeeId=
router.get("/", async (req, res) => {
  try {
    const { from, to } = readRange(req.query);
    const { kind, category, method, search, payeeId } = req.query as Record<string, string>;

    const where: any = { date: { gte: from, lte: to } };
    if (kind === "income" || kind === "expense") where.kind = kind;
    if (category) where.category = category;
    if (method && METHODS.includes(method as Method)) where.method = method;
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
    console.error("cashbook list", err);
    res.status(500).json({ error: "Failed to load entries" });
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

    const sum = (list: any[]) => round2(list.reduce((s, r) => s + num(r.amount), 0));
    const inRows  = rows.filter((r) => r.kind === "income");
    const outRows = rows.filter((r) => r.kind === "expense");

    const income  = sum(inRows);
    const expense = sum(outRows);

    // by category, kept per direction so "Food" and "Sale" never mix
    const catMap = new Map<string, { category: string; kind: string; amount: number; count: number }>();
    rows.forEach((r) => {
      const key = `${r.kind}:${r.category}`;
      if (!catMap.has(key)) catMap.set(key, { category: r.category as string, kind: r.kind as string, amount: 0, count: 0 });
      const c = catMap.get(key)!;
      c.amount = round2(c.amount + num(r.amount));
      c.count += 1;
    });

    // by person — paid out, received back, and the balance between the two
    const payMap = new Map<string, {
      id: string; name: string; phone: string; kind: string;
      paid: number; received: number; net: number; count: number;
    }>();
    rows.forEach((r: any) => {
      const p = r.payee;
      if (!p) return;
      if (!payMap.has(p.id)) {
        payMap.set(p.id, { id: p.id, name: p.name, phone: p.phone, kind: p.kind, paid: 0, received: 0, net: 0, count: 0 });
      }
      const e = payMap.get(p.id)!;
      if (r.kind === "income") e.received = round2(e.received + num(r.amount));
      else                     e.paid     = round2(e.paid + num(r.amount));
      e.net = round2(e.paid - e.received);   // positive = they still owe us
      e.count += 1;
    });

    // day-by-day, both directions
    const dayMap = new Map<string, { date: string; income: number; expense: number }>();
    rows.forEach((r) => {
      const k = new Date(r.date).toISOString().slice(0, 10);
      if (!dayMap.has(k)) dayMap.set(k, { date: k, income: 0, expense: 0 });
      const d = dayMap.get(k)!;
      if (r.kind === "income") d.income  = round2(d.income + num(r.amount));
      else                     d.expense = round2(d.expense + num(r.amount));
    });

    res.json({
      from, to,
      income, expense,
      net: round2(income - expense),
      cashIn:    sum(inRows.filter((r) => r.method === "cash")),
      onlineIn:  sum(inRows.filter((r) => r.method === "online")),
      cashOut:   sum(outRows.filter((r) => r.method === "cash")),
      onlineOut: sum(outRows.filter((r) => r.method === "online")),
      todayIn:  sum(todayRows.filter((r) => r.kind === "income")),
      todayOut: sum(todayRows.filter((r) => r.kind === "expense")),
      count: rows.length,
      incomeCount:  inRows.length,
      expenseCount: outRows.length,
      byCategory: Array.from(catMap.values()).sort((a, b) => b.amount - a.amount),
      byPayee:    Array.from(payMap.values()).sort((a, b) => (b.paid + b.received) - (a.paid + a.received)),
      daily:      Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (err) {
    console.error("cashbook summary", err);
    res.status(500).json({ error: "Failed to load summary" });
  }
});

/* ───────────────────────── read one ───────────────────────── */
router.get("/:id", async (req, res) => {
  try {
    const row = await prisma.expense.findUnique({ where: { id: req.params.id }, include });
    if (!row) return res.status(404).json({ error: "Entry not found" });
    res.json(shape(row));
  } catch (err) {
    console.error("cashbook get", err);
    res.status(500).json({ error: "Failed to load entry" });
  }
});

/* ───────────────────────── create ───────────────────────── */
// POST /api/expenses  { kind, date?, category, title, amount, method, payeeId?, notes? }
router.post("/", async (req: any, res) => {
  try {
    const { kind, date, category, title, amount, method, payeeId, notes } = req.body || {};

    const k   = asKind(kind);
    const amt = round2(Number(amount));
    if (!title || !String(title).trim())   return res.status(400).json({ error: "Title is required" });
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "Enter an amount greater than 0" });

    const cat = asCategory(category, k);

    // lending and getting money back are always about a person
    const needsPayee = cat === "lent" || cat === "loan_back" || cat === "salary" || cat === "advance";
    if (needsPayee && !payeeId) {
      return res.status(400).json({ error: "Choose the person this entry belongs to" });
    }

    let linkId: string | null = null;
    if (payeeId) {
      const payee = await prisma.payee.findUnique({ where: { id: payeeId }, select: { id: true } });
      if (!payee) return res.status(400).json({ error: "That person is not in the list — add them first" });
      linkId = payee.id;
    }

    const row = await prisma.expense.create({
      data: {
        kind: k,
        date: date ? new Date(date) : new Date(),
        category: cat,
        title: String(title).trim(),
        amount: amt,
        method: asMethod(method),
        payeeId: linkId,
        notes: String(notes || "").trim(),
        createdById: req.user?.id || null,
      },
      include,
    });

    res.status(201).json(shape(row));
  } catch (err) {
    console.error("cashbook create", err);
    res.status(500).json({ error: "Failed to save entry" });
  }
});

/* ───────────────────────── update ───────────────────────── */
router.patch("/:id", async (req, res) => {
  try {
    const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Entry not found" });

    const { kind, date, category, title, amount, method, payeeId, notes } = req.body || {};
    const data: any = {};

    const k = kind !== undefined ? asKind(kind) : (existing.kind as Kind);
    if (kind !== undefined) data.kind = k;

    // a category always has to match the direction it sits in
    if (category !== undefined || kind !== undefined) {
      data.category = asCategory(category ?? existing.category, k);
    }

    if (date !== undefined)   data.date   = new Date(date);
    if (method !== undefined) data.method = asMethod(method);
    if (notes !== undefined)  data.notes  = String(notes || "").trim();

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
      if (payeeId) {
        const payee = await prisma.payee.findUnique({ where: { id: payeeId }, select: { id: true } });
        if (!payee) return res.status(400).json({ error: "That person is not in the list" });
        data.payeeId = payee.id;
      } else {
        data.payeeId = null;
      }
    }

    const finalCat   = (data.category ?? existing.category) as string;
    const finalPayee = payeeId !== undefined ? data.payeeId : existing.payeeId;
    if (["lent", "loan_back", "salary", "advance"].includes(finalCat) && !finalPayee) {
      return res.status(400).json({ error: "Choose the person this entry belongs to" });
    }

    const row = await prisma.expense.update({ where: { id: req.params.id }, data, include });
    res.json(shape(row));
  } catch (err) {
    console.error("cashbook update", err);
    res.status(500).json({ error: "Failed to update entry" });
  }
});

/* ───────────────────────── delete ───────────────────────── */
router.delete("/:id", async (req, res) => {
  try {
    const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Entry not found" });
    await prisma.expense.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error("cashbook delete", err);
    res.status(500).json({ error: "Failed to delete entry" });
  }
});

export default router;