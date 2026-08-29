// backend/src/routes/payeeRoutes.ts
import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";

const router = Router();
router.use(protect, adminOnly);

const num = (v: any) => Number(v ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Phone IS the identity, so it has to be stored the same way every time.
 * Keeps digits only and drops a leading 91 / 0 on Indian mobiles, so
 * "+91 97654 32100", "09765432100" and "9765432100" all land on one record.
 */
export function normalisePhone(raw: any): string {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0"))  d = d.slice(1);
  return d;
}

const asKind = (v: any) => (v === "employee" ? "employee" : "outsider");

/** Attaches paid-total and last-paid to a payee row. */
function withTotals(p: any) {
  const expenses = p.expenses || [];
  const total = round2(expenses.reduce((s: number, e: any) => s + num(e.amount), 0));
  const last  = expenses.length
    ? expenses.reduce((a: any, b: any) => (new Date(a.date) > new Date(b.date) ? a : b))
    : null;
  const { expenses: _drop, ...rest } = p;
  return {
    ...rest,
    totalPaid:  total,
    paymentCount: expenses.length,
    lastPaidAt: last?.date || null,
  };
}

/* ───────────────────────── list ───────────────────────── */
// GET /api/payees?kind=&search=&includeInactive=1
router.get("/", async (req, res) => {
  try {
    const { kind, search, includeInactive } = req.query as Record<string, string>;

    const where: any = {};
    if (kind === "employee" || kind === "outsider") where.kind = kind;
    if (!includeInactive) where.active = true;
    if (search) {
      const digits = normalisePhone(search);
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { role: { contains: search, mode: "insensitive" } },
        ...(digits ? [{ phone: { contains: digits } }] : []),
      ];
    }

    const rows = await prisma.payee.findMany({
      where,
      include: {
        expenses: { select: { amount: true, date: true } },
        user:     { select: { id: true, name: true, email: true, role: true } },
      },
      orderBy: { name: "asc" },
    });

    const shaped = rows.map(withTotals).sort((a, b) => b.totalPaid - a.totalPaid);
    res.json(shaped);
  } catch (err) {
    console.error("payees list", err);
    res.status(500).json({ error: "Failed to load people" });
  }
});

/* ─────────── pull employees into the people list ─────────── */
// POST /api/payees/sync-employees
// Creates a Payee for every employee that has a phone number and isn't
// linked yet. Employees without a phone are reported back, not guessed at.
router.post("/sync-employees", async (_req, res) => {
  try {
    const employees = await prisma.user.findMany({
      where: { role: "employee" },
      select: { id: true, name: true, phone: true },
    });

    let created = 0, linked = 0;
    const skipped: string[] = [];

    for (const emp of employees) {
      const phone = normalisePhone(emp.phone);
      if (!phone) { skipped.push(emp.name); continue; }

      const existingByUser  = await prisma.payee.findUnique({ where: { userId: emp.id } });
      if (existingByUser) continue;

      const existingByPhone = await prisma.payee.findUnique({ where: { phone } });
      if (existingByPhone) {
        // same number already in the book — attach the login to it
        await prisma.payee.update({
          where: { id: existingByPhone.id },
          data: { userId: emp.id, kind: "employee", name: existingByPhone.name || emp.name },
        });
        linked++;
      } else {
        await prisma.payee.create({
          data: { name: emp.name, phone, kind: "employee", userId: emp.id },
        });
        created++;
      }
    }

    res.json({ created, linked, skipped, total: employees.length });
  } catch (err) {
    console.error("payee sync", err);
    res.status(500).json({ error: "Failed to sync employees" });
  }
});

/* ───────────────────── one person + history ───────────────────── */
// GET /api/payees/:id?from=&to=
router.get("/:id", async (req, res) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const where: any = { payeeId: req.params.id };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(`${from}T00:00:00`);
      if (to)   where.date.lte = new Date(`${to}T23:59:59.999`);
    }

    const payee = await prisma.payee.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });
    if (!payee) return res.status(404).json({ error: "Person not found" });

    const expenses = await prisma.expense.findMany({
      where, orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });

    const total  = round2(expenses.reduce((s, e) => s + num(e.amount), 0));
    const cash   = round2(expenses.filter((e) => e.method === "cash").reduce((s, e) => s + num(e.amount), 0));

    // month-by-month, newest first — reads like a passbook
    const monthMap = new Map<string, number>();
    expenses.forEach((e) => {
      const k = new Date(e.date).toISOString().slice(0, 7);
      monthMap.set(k, round2((monthMap.get(k) || 0) + num(e.amount)));
    });

    // category split for this person
    const catMap = new Map<string, number>();
    expenses.forEach((e) => {
      catMap.set(e.category, round2((catMap.get(e.category) || 0) + num(e.amount)));
    });

    res.json({
      ...payee,
      totalPaid: total,
      cash,
      online: round2(total - cash),
      paymentCount: expenses.length,
      lastPaidAt: expenses[0]?.date || null,
      expenses: expenses.map((e) => ({ ...e, amount: num(e.amount) })),
      byMonth: Array.from(monthMap.entries())
        .map(([month, amount]) => ({ month, amount }))
        .sort((a, b) => b.month.localeCompare(a.month)),
      byCategory: Array.from(catMap.entries())
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount),
    });
  } catch (err) {
    console.error("payee get", err);
    res.status(500).json({ error: "Failed to load this person" });
  }
});

/* ───────────────────────── create ───────────────────────── */
// POST /api/payees  { name, phone, kind, userId?, role?, notes? }
router.post("/", async (req, res) => {
  try {
    const { name, phone, kind, userId, role, notes } = req.body || {};

    const cleanName = String(name || "").trim();
    const digits    = normalisePhone(phone);

    if (!cleanName)         return res.status(400).json({ error: "Name is required" });
    if (digits.length < 10) return res.status(400).json({ error: "Enter a valid 10-digit phone number" });

    const clash = await prisma.payee.findUnique({ where: { phone: digits } });
    if (clash) {
      return res.status(409).json({
        error: `${clash.name} already uses this number`,
        payee: clash,           // frontend can just select this one instead
      });
    }

    let linkId: string | null = null;
    if (userId) {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!u) return res.status(400).json({ error: "That employee account no longer exists" });
      const taken = await prisma.payee.findUnique({ where: { userId } });
      if (taken) return res.status(409).json({ error: "That employee is already in the list" });
      linkId = u.id;
    }

    const row = await prisma.payee.create({
      data: {
        name: cleanName,
        phone: digits,
        kind: asKind(linkId ? "employee" : kind),
        userId: linkId,
        role: String(role || "").trim(),
        notes: String(notes || "").trim(),
      },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });

    res.status(201).json({ ...row, totalPaid: 0, paymentCount: 0, lastPaidAt: null });
  } catch (err) {
    console.error("payee create", err);
    res.status(500).json({ error: "Failed to save this person" });
  }
});

/* ───────────────────────── update ───────────────────────── */
router.patch("/:id", async (req, res) => {
  try {
    const existing = await prisma.payee.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Person not found" });

    const { name, phone, kind, role, notes, active } = req.body || {};
    const data: any = {};

    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: "Name is required" });
      data.name = String(name).trim();
    }
    if (phone !== undefined) {
      const digits = normalisePhone(phone);
      if (digits.length < 10) return res.status(400).json({ error: "Enter a valid 10-digit phone number" });
      if (digits !== existing.phone) {
        const clash = await prisma.payee.findUnique({ where: { phone: digits } });
        if (clash) return res.status(409).json({ error: `${clash.name} already uses this number` });
      }
      data.phone = digits;
    }
    // a linked employee stays an employee
    if (kind !== undefined && !existing.userId) data.kind = asKind(kind);
    if (role   !== undefined) data.role   = String(role || "").trim();
    if (notes  !== undefined) data.notes  = String(notes || "").trim();
    if (active !== undefined) data.active = !!active;

    const row = await prisma.payee.update({
      where: { id: req.params.id },
      data,
      include: {
        expenses: { select: { amount: true, date: true } },
        user:     { select: { id: true, name: true, email: true, role: true } },
      },
    });

    res.json(withTotals(row));
  } catch (err) {
    console.error("payee update", err);
    res.status(500).json({ error: "Failed to update this person" });
  }
});

/* ───────────────────────── delete ───────────────────────── */
// Only possible while they have no payment history — otherwise deactivate.
router.delete("/:id", async (req, res) => {
  try {
    const count = await prisma.expense.count({ where: { payeeId: req.params.id } });
    if (count > 0) {
      return res.status(409).json({
        error: `This person has ${count} payment${count === 1 ? "" : "s"} on record. Mark them inactive instead of deleting.`,
      });
    }
    await prisma.payee.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error("payee delete", err);
    res.status(500).json({ error: "Failed to remove this person" });
  }
});

export default router;