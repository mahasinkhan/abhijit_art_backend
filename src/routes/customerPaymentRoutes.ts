// backend/src/routes/customerPaymentRoutes.ts
// Account-level payments — the customer runs a tab, not bill-by-bill settling.
//
// HOW IT WORKS
//   Every payment is stored against the CUSTOMER, never an invoice.
//   Which invoice a payment settles is worked out at read time, oldest
//   bill first (FIFO). So editing or deleting a payment re-settles every
//   invoice by itself — there is no per-invoice number to keep in sync.
//
//   Legacy per-invoice payments (Invoice.paidAmount) stay applied to their
//   own invoice, so old records are untouched. Account payments fill only
//   what is still outstanding after that.
//
// SECURITY
//   Reading a ledger / history is open (admin session only). Any action that
//   MOVES MONEY — record, edit or delete a payment — additionally requires the
//   security PIN, exactly like invoice delete / cancel / edit / payment. So no
//   one can add or remove a payment without the PIN.
import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";
import { isPinSet, verifyPin } from "../utils/security.js";

const router = Router();
router.use(protect, adminOnly);

const num    = (v: any) => Number(v ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
const asMethod = (v: any) => (v === "online" ? "online" : "cash");

/** Money actions (add / edit / delete a payment) need the security PIN — the
 *  same guard the invoice delete/cancel/edit/payment routes use. Returns an
 *  error object to send back, or null when the PIN is correct. */
async function pinError(req: any): Promise<{ code: number; message: string } | null> {
  if (!(await isPinSet())) {
    return { code: 409, message: "No security PIN is set yet. Set one in Settings before recording or removing payments." };
  }
  if (!(await verifyPin(String(req.body?.pin || "")))) {
    return { code: 403, message: "Incorrect security PIN." };
  }
  return null;
}

/** Store the payment on the chosen day (or today if none), fixed at noon IST.
 *  We keep DATE only — no clock time — because the statement/history show just
 *  the date. Noon-IST as the instant means it never shifts to the previous or
 *  next day in any server timezone (UTC included). */
function paidAtFrom(input: any): Date {
  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const day = String(input || "").slice(0, 10) || todayIST;   // default: today
  return new Date(`${day}T06:30:00.000Z`);   // noon IST
}

/** Every invoice belonging to this customer — linked by id, or by phone for
 *  older bills that were saved before the customer record existed. */
async function invoicesOf(customerId: string, phone?: string | null) {
  const or: any[] = [{ customerId }];
  const digits = String(phone || "").replace(/\D/g, "").slice(-10);
  if (digits.length === 10) or.push({ clientPhone: { contains: digits } });

  return prisma.invoice.findMany({
    where: { AND: [{ OR: or }, { status: { not: "cancelled" } }] },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
}

/** Runs the FIFO allocation. Pure function — no writes. */
function settle(invoices: any[], payments: any[]) {
  let pool = round2(payments.reduce((s, p) => s + num(p.amount), 0));
  const credit = pool;

  let billed = 0, legacyPaid = 0;

  const rows = invoices.map((inv) => {
    const total   = num(inv.total);
    const legacy  = num(inv.paidAmount);
    const baseDue = round2(Math.max(total - legacy, 0));

    const alloc = round2(Math.min(pool, baseDue));
    pool = round2(pool - alloc);

    const settled = round2(legacy + alloc);
    const due     = round2(Math.max(total - settled, 0));

    billed     = round2(billed + total);
    legacyPaid = round2(legacyPaid + legacy);

    return {
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      date: inv.date,
      createdAt: inv.createdAt,
      total,
      legacyPaid: legacy,
      allocated: alloc,
      settled,
      due,
      status: due <= 0.005 ? "paid" : settled > 0.005 ? "partial" : "unpaid",
      format: (inv.business as any)?.format || "full",
      items: inv.items,
    };
  });

  const paid = round2(legacyPaid + (credit - pool));

  return {
    invoices: rows,
    billed,
    paid,
    balance: round2(Math.max(billed - paid, 0)),
    /** money received beyond every bill — sits as advance for the next one */
    advance: round2(pool),
  };
}

/** Recomputes each invoice's status column so the invoice list agrees with
 *  the ledger. Idempotent — recalculated from scratch, so it can never drift. */
async function resync(customerId: string) {
  const cust = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, phone: true },
  });
  if (!cust) return;

  const [invoices, payments] = await Promise.all([
    invoicesOf(cust.id, cust.phone),
    prisma.customerPayment.findMany({ where: { customerId: cust.id } }),
  ]);

  const { invoices: rows } = settle(invoices, payments);

  await Promise.all(
    rows.map((r) =>
      prisma.invoice.update({
        where: { id: r.id },
        data: { status: r.status as any },
      }),
    ),
  );
}

/* ─────────────── the customer's running account ─────────────── */
router.get("/:customerId/ledger", async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.customerId },
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const [invoices, payments] = await Promise.all([
      invoicesOf(customer.id, customer.phone),
      prisma.customerPayment.findMany({
        where: { customerId: customer.id },
        orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
      }),
    ]);

    // FIFO needs oldest-first; the response lists newest-first for the UI
    const ledger = settle(invoices, [...payments].reverse());

    res.json({
      customer,
      billed: ledger.billed,
      paid: ledger.paid,
      balance: ledger.balance,
      advance: ledger.advance,
      invoices: ledger.invoices.slice().reverse(),
      payments: payments.map((p) => ({ ...p, amount: num(p.amount) })),
    });
  } catch (err) {
    console.error("customer ledger", err);
    res.status(500).json({ error: "Failed to load this account" });
  }
});

/* ─────────────────────── record a payment ─────────────────────── */
router.post("/", async (req, res) => {
  try {
    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ error: pe.message });

    const { customerId, amount, method, note, paidAt } = req.body || {};

    if (!customerId) return res.status(400).json({ error: "Customer is required" });

    const amt = round2(num(amount));
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "Enter an amount greater than zero" });
    }

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return res.status(400).json({ error: "That customer no longer exists" });

    const row = await prisma.customerPayment.create({
      data: {
        customerId,
        amount: amt,
        method: asMethod(method),
        note: String(note || "").trim(),
        paidAt: paidAtFrom(paidAt),
        createdById: (req as any).user?.id || null,
      },
    });

    await resync(customerId);

    res.status(201).json({ ...row, amount: num(row.amount) });
  } catch (err) {
    console.error("customer payment create", err);
    res.status(500).json({ error: "Failed to record this payment" });
  }
});

/* ─────────────────────────── update ─────────────────────────── */
router.patch("/:id", async (req, res) => {
  try {
    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ error: pe.message });

    const existing = await prisma.customerPayment.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Payment not found" });

    const { amount, method, note, paidAt } = req.body || {};
    const data: any = {};

    if (amount !== undefined) {
      const amt = round2(num(amount));
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: "Enter an amount greater than zero" });
      }
      data.amount = amt;
    }
    if (method !== undefined) data.method = asMethod(method);
    if (note   !== undefined) data.note   = String(note || "").trim();
    if (paidAt !== undefined) data.paidAt = paidAtFrom(paidAt);

    const row = await prisma.customerPayment.update({ where: { id: req.params.id }, data });
    await resync(existing.customerId);

    res.json({ ...row, amount: num(row.amount) });
  } catch (err) {
    console.error("customer payment update", err);
    res.status(500).json({ error: "Failed to update this payment" });
  }
});

/* ─────────────────────────── delete ─────────────────────────── */
router.delete("/:id", async (req, res) => {
  try {
    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ error: pe.message });

    const existing = await prisma.customerPayment.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Payment not found" });

    await prisma.customerPayment.delete({ where: { id: req.params.id } });
    await resync(existing.customerId);

    res.json({ ok: true });
  } catch (err) {
    console.error("customer payment delete", err);
    res.status(500).json({ error: "Failed to remove this payment" });
  }
});

export default router;