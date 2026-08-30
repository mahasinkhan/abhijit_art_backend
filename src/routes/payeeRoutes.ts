// backend/src/routes/payeeRoutes.ts
// The people directory behind the cash book — staff and outsiders alike.
import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";

const router = Router();
router.use(protect, adminOnly);

const num    = (v: any) => Number(v ?? 0);
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

/** Rolls a payee's entries into paid / received / balance. */
function withTotals(p: any) {
  const rows = p.expenses || [];
  const paid     = round2(rows.filter((e: any) => e.kind === "expense").reduce((s: number, e: any) => s + num(e.amount), 0));
  const received = round2(rows.filter((e: any) => e.kind === "income").reduce((s: number, e: any) => s + num(e.amount), 0));
  const last = rows.length
    ? rows.reduce((a: any, b: any) => (new Date(a.date) > new Date(b.date) ? a : b))
    : null;
  const { expenses: _drop, ...rest } = p;
  return {
    ...rest,
    paid,
    received,
    /** positive = they still owe us, negative = we owe them */
    net: round2(paid - received),
    entryCount: rows.length,
    lastEntryAt: last?.date || null,
  };
}

/* ───────────────────────── list ───────────────────────── */
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
        expenses: { select: { amount: true, date: true, kind: true } },
        user:     { select: { id: true, name: true, email: true, role: true } },
      },
      orderBy: { name: "asc" },
    });

    const shaped = rows.map(withTotals)
      .sort((a, b) => (b.paid + b.received) - (a.paid + a.received));
    res.json(shaped);
  } catch (err) {
    console.error("payees list", err);
    res.status(500).json({ error: "Failed to load people" });
  }
});

/* ─────────── pull employees into the people list ─────────── */
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

      const existingByUser = await prisma.payee.findUnique({ where: { userId: emp.id } });
      if (existingByUser) continue;

      const existingByPhone = await prisma.payee.findUnique({ where: { phone } });
      if (existingByPhone) {
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

/* ───────────────── one person + full history ───────────────── */
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

    const entries = await prisma.expense.findMany({
      where, orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });

    const outRows = entries.filter((e) => e.kind === "expense");
    const inRows  = entries.filter((e) => e.kind === "income");
    const sum = (l: any[]) => round2(l.reduce((s, e) => s + num(e.amount), 0));

    const paid     = sum(outRows);
    const received = sum(inRows);

    // month-by-month, newest first — reads like a passbook
    const monthMap = new Map<string, { month: string; income: number; expense: number }>();
    entries.forEach((e) => {
      const k = new Date(e.date).toISOString().slice(0, 7);
      if (!monthMap.has(k)) monthMap.set(k, { month: k, income: 0, expense: 0 });
      const m = monthMap.get(k)!;
      if (e.kind === "income") m.income  = round2(m.income + num(e.amount));
      else                     m.expense = round2(m.expense + num(e.amount));
    });

    const catMap = new Map<string, { category: string; kind: string; amount: number }>();
    entries.forEach((e) => {
      const key = `${e.kind}:${e.category}`;
      if (!catMap.has(key)) catMap.set(key, { category: e.category as string, kind: e.kind as string, amount: 0 });
      const c = catMap.get(key)!;
      c.amount = round2(c.amount + num(e.amount));
    });

    res.json({
      ...payee,
      paid,
      received,
      net: round2(paid - received),
      cashPaid:   sum(outRows.filter((e) => e.method === "cash")),
      onlinePaid: sum(outRows.filter((e) => e.method === "online")),
      entryCount: entries.length,
      lastEntryAt: entries[0]?.date || null,
      entries: entries.map((e) => ({ ...e, amount: num(e.amount) })),
      byMonth: Array.from(monthMap.values()).sort((a, b) => b.month.localeCompare(a.month)),
      byCategory: Array.from(catMap.values()).sort((a, b) => b.amount - a.amount),
    });
  } catch (err) {
    console.error("payee get", err);
    res.status(500).json({ error: "Failed to load this person" });
  }
});

/* ───────────────────────── create ───────────────────────── */
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
        payee: clash,
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

    res.status(201).json({ ...row, paid: 0, received: 0, net: 0, entryCount: 0, lastEntryAt: null });
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
    if (kind !== undefined && !existing.userId) data.kind = asKind(kind);
    if (role   !== undefined) data.role   = String(role || "").trim();
    if (notes  !== undefined) data.notes  = String(notes || "").trim();
    if (active !== undefined) data.active = !!active;

    const row = await prisma.payee.update({
      where: { id: req.params.id },
      data,
      include: {
        expenses: { select: { amount: true, date: true, kind: true } },
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
router.delete("/:id", async (req, res) => {
  try {
    const count = await prisma.expense.count({ where: { payeeId: req.params.id } });
    if (count > 0) {
      return res.status(409).json({
        error: `This person has ${count} entr${count === 1 ? "y" : "ies"} on record. Mark them inactive instead of deleting.`,
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