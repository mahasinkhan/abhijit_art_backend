// backend/src/routes/payeeRoutes.ts
// The people directory behind the cash book — staff, suppliers and counter
// customers on ONE list, used by both directions of the book.
//
// THE NAME IS THE IDENTITY. That is how the studio actually works: a name is
// written down every time, a number often never. So the name is matched on a
// folded key (upper case, spacing collapsed) and `phone` is an ordinary detail
// — optional, editable, and no longer able to block a save. Leaving the number
// blank has to work, because the alternative is the name never joining the
// dropdown at all.
//
// Nothing here deletes or merges records. Two people who share a name keep
// separate rows; POST hands back the existing one so the caller reuses it
// rather than forking a second history under the same spelling.
import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";

const router = Router();
router.use(protect, adminOnly);

const num    = (v: any) => Number(v ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The identity key. "  azad   da " and "AZAD DA" are one person, so case and
 * stray spacing are folded away before anything is compared or stored.
 */
export function nameKeyOf(raw: any): string {
  return String(raw || "").trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Digits only, minus a leading 91 / 0, so the same mobile written three ways
 * still displays and searches identically. No longer unique — a contact
 * detail now, not the identity.
 */
export function normalisePhone(raw: any): string {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0"))  d = d.slice(1);
  return d;
}

/**
 * Blank is fine; half-typed is not. A five-digit number on a record is worse
 * than an empty field, because it looks callable and isn't.
 */
function readPhone(raw: any): { value: string | null } | { error: string } {
  const digits = normalisePhone(raw);
  if (!digits) return { value: null };
  if (digits.length !== 10) {
    return { error: "A phone number must be 10 digits — leave it blank if you don't have it" };
  }
  return { value: digits };
}

const asKind = (v: any) => (v === "employee" ? "employee" : "outsider");

/** Rolls a payee's entries into paid / received / balance, both directions. */
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
    phone: rest.phone || "",          // callers have always read a string here
    paid,
    received,
    /** positive = we have paid them more than they have paid us */
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

    // Busiest first, counting both directions — the names written most often
    // sit nearest the top of the dropdown.
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
      const key = nameKeyOf(emp.name);
      if (!key) { skipped.push(emp.name || "(unnamed)"); continue; }

      // A staff member with no number on file used to be skipped entirely and
      // so never appeared in the dropdown. The user link is identity enough.
      const digits = normalisePhone(emp.phone);
      const store  = digits.length === 10 ? digits : null;

      const existingByUser = await prisma.payee.findUnique({ where: { userId: emp.id } });
      if (existingByUser) continue;

      // Match on the name — a staff member already written into the book by
      // hand is the same person and must not fork into a second record.
      const existing = await prisma.payee.findUnique({ where: { nameKey: key } });

      if (existing) {
        await prisma.payee.update({
          where: { id: existing.id },
          data: {
            userId: emp.id,
            kind: "employee",
            phone: existing.phone || store,   // never overwrite a number on file
          },
        });
        linked++;
      } else {
        await prisma.payee.create({
          data: {
            name: String(emp.name).trim().replace(/\s+/g, " "),
            nameKey: key,
            phone: store,
            kind: "employee",
            userId: emp.id,
          },
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
      phone: payee.phone || "",
      paid,
      received,
      net: round2(paid - received),
      cashPaid:       sum(outRows.filter((e) => e.method === "cash")),
      onlinePaid:     sum(outRows.filter((e) => e.method === "online")),
      cashReceived:   sum(inRows.filter((e) => e.method === "cash")),
      onlineReceived: sum(inRows.filter((e) => e.method === "online")),
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

    const cleanName = String(name || "").trim().replace(/\s+/g, " ");
    const key       = nameKeyOf(cleanName);
    if (!key) return res.status(400).json({ error: "Name is required" });

    const ph = readPhone(phone);
    if ("error" in ph) return res.status(400).json({ error: ph.error });

    // The same name typed again is the same person. Hand the existing record
    // back so the caller reuses it — history stays on one page instead of
    // splitting across two spellings of one man's name.
    const twin = await prisma.payee.findUnique({
      where: { nameKey: key },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });
    if (twin) {
      // A number typed alongside a known name is worth keeping if we had none.
      const filled = ph.value && !twin.phone
        ? await prisma.payee.update({ where: { id: twin.id }, data: { phone: ph.value } })
        : twin;
      return res.status(409).json({
        error: `${filled.name} is already in the list`,
        payee: { ...filled, phone: filled.phone || "" },
      });
    }

    let linkId: string | null = null;
    if (userId) {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!u) return res.status(400).json({ error: "That employee account no longer exists" });
      const taken = await prisma.payee.findUnique({ where: { userId } });
      if (taken) {
        return res.status(409).json({
          error: "That employee is already in the list",
          payee: { ...taken, phone: taken.phone || "" },
        });
      }
      linkId = u.id;
    }

    const row = await prisma.payee.create({
      data: {
        name: cleanName,
        nameKey: key,
        phone: ph.value,
        kind: asKind(linkId ? "employee" : kind),
        userId: linkId,
        role: String(role || "").trim(),
        notes: String(notes || "").trim(),
      },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });

    res.status(201).json({
      ...row, phone: row.phone || "",
      paid: 0, received: 0, net: 0, entryCount: 0, lastEntryAt: null,
    });
  } catch (err) {
    console.error("payee create", err);
    res.status(500).json({ error: "Failed to save this person" });
  }
});

/* ───────────────────────── update ─────────────────────────
   Correcting a person: their name, their number, which list they sit in.
   Entry titles are deliberately NOT rewritten — an entry records what was
   written on the day, and a historical row is not ours to edit from here. */
router.patch("/:id", async (req, res) => {
  try {
    const existing = await prisma.payee.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Person not found" });

    const { name, phone, kind, role, notes, active } = req.body || {};
    const data: any = {};

    if (name !== undefined) {
      const cleanName = String(name).trim().replace(/\s+/g, " ");
      const key       = nameKeyOf(cleanName);
      if (!key) return res.status(400).json({ error: "Name is required" });
      if (key !== existing.nameKey) {
        const clash = await prisma.payee.findUnique({ where: { nameKey: key } });
        if (clash && clash.id !== existing.id) {
          return res.status(409).json({
            error: `${clash.name} is already in the list — renaming would make two of them`,
            payee: { ...clash, phone: clash.phone || "" },
          });
        }
        data.nameKey = key;
      }
      data.name = cleanName;
    }

    if (phone !== undefined) {
      const ph = readPhone(phone);
      if ("error" in ph) return res.status(400).json({ error: ph.error });
      data.phone = ph.value;                  // may be null — the number was cleared
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

/* ───────────────────────── delete ─────────────────────────
   Only ever for a record with no money against it. Anyone with history is
   deactivated instead, so no entry is ever orphaned or lost. */
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