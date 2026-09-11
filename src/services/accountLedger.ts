// backend/src/services/accountLedger.ts
// ─────────────────────────────────────────────────────────────────────────────
// Account-level payment settlement — the single source of truth for "how much
// has this customer actually paid on this bill".
//
// WHY THIS EXISTS
//   Payments live in TWO places:
//     • Payment          — tied to one invoice; cached on Invoice.paidAmount
//                          by recomputeInvoice() in invoice.service.ts
//     • CustomerPayment  — tied to the CUSTOMER, not a bill (the running tab)
//
//   Invoice.paidAmount only ever reflects the FIRST kind. Any list that reads
//   it raw therefore under-reports every customer who pays on account, which is
//   what made the Invoices list show ₹0.00 paid against a bill the ledger drawer
//   showed as part-settled.
//
//   Which invoice an account payment settles is decided HERE, at read time,
//   oldest bill first (FIFO) — never written back. That is deliberate: because
//   nothing is stored, editing or deleting a payment re-settles every invoice by
//   itself, and there is no per-invoice number that can drift out of sync.
//
// DO NOT write `settled` back onto Invoice.paidAmount. settle() treats
// paidAmount as the legacy per-invoice baseline and adds the account allocation
// on top of it, so persisting the result would make the next pass count that
// allocation as legacy and allocate it a second time. recomputeInvoice() would
// also overwrite it from the Payment table. paidAmount stays a cache of Payment.
//
// METHOD TRACKING
//   Payments are walked one at a time rather than summed into a single pool, so
//   every allocated rupee still knows whether it arrived as cash or online. The
//   totals are identical either way — this only exists so the Cash received /
//   Online received cards can account for money paid onto the tab. Payments MUST
//   therefore be passed oldest-first.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "../config/prisma.js";

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Indian mobiles are matched on their last 10 digits, so +91 / spaces /
 *  dashes in either record still line up. */
const last10 = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);

// ── types ────────────────────────────────────────────────────────────────────
export type Method = "cash" | "online";

export type SettleInvoice = {
  id: string;
  invoiceNo?: string;
  date?: Date | string | null;
  createdAt?: Date | string | null;
  total: unknown;
  paidAmount: unknown;
  status?: string | null;
  customerId?: string | null;
  clientPhone?: string | null;
  business?: unknown;
  items?: unknown;
};

export type SettlePayment = { amount: unknown; method?: string | null };

/** What one invoice looks like once the customer's tab has been applied. */
export type SettledRow = {
  /** taken from the running tab (FIFO), on top of legacyPaid */
  accountPaid: number;
  /** the cash slice of accountPaid */
  accountCash: number;
  /** the online slice of accountPaid */
  accountOnline: number;
  /** legacy per-invoice payments — Invoice.paidAmount */
  legacyPaid: number;
  /** legacyPaid + accountPaid — the real "paid" figure to display */
  settled: number;
  due: number;
  status: "unpaid" | "partial" | "paid";
};

/** One customer's account, rolled up. */
export type AccountTotals = {
  billed: number;
  paid: number;
  balance: number;
  /** money received beyond every bill — sits as advance against the next one */
  advance: number;
};

export type Settlement = {
  byInvoice: Map<string, SettledRow>;
  byCustomer: Map<string, AccountTotals>;
};

// ── the FIFO allocation ──────────────────────────────────────────────────────
/** Pure — no writes, no I/O.
 *  `invoices` MUST be oldest-first and must already have cancelled bills
 *  filtered out (they take no allocation).
 *  `payments` MUST be oldest-first — method tracking depends on the order. */
export function settle(invoices: SettleInvoice[], payments: SettlePayment[]) {
  // each payment keeps its own remaining balance so its method survives
  const queue = payments.map((p) => ({
    left: round2(num(p.amount)),
    method: (p.method === "online" ? "online" : "cash") as Method,
  }));
  let qi = 0;

  let billed = 0;
  let legacyTotal = 0;
  let allocatedTotal = 0;

  const rows = invoices.map((inv) => {
    const total = num(inv.total);
    const legacy = num(inv.paidAmount);

    let need = round2(Math.max(total - legacy, 0));
    let alloc = 0;
    let cash = 0;
    let online = 0;

    while (need > 0.005 && qi < queue.length) {
      const p = queue[qi];
      if (p.left <= 0.005) {
        qi++;
        continue;
      }
      const take = round2(Math.min(p.left, need));
      p.left = round2(p.left - take);
      need = round2(need - take);
      alloc = round2(alloc + take);
      if (p.method === "online") online = round2(online + take);
      else cash = round2(cash + take);
      if (p.left <= 0.005) qi++;
    }

    const settled = round2(legacy + alloc);
    const due = round2(Math.max(total - settled, 0));

    billed = round2(billed + total);
    legacyTotal = round2(legacyTotal + legacy);
    allocatedTotal = round2(allocatedTotal + alloc);

    return {
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      date: inv.date,
      createdAt: inv.createdAt,
      total,
      legacyPaid: legacy,
      allocated: alloc,
      allocatedCash: cash,
      allocatedOnline: online,
      settled,
      due,
      status: (due <= 0.005 ? "paid" : settled > 0.005 ? "partial" : "unpaid") as
        | "unpaid"
        | "partial"
        | "paid",
      format: (inv.business as { format?: string } | null)?.format || "full",
      items: inv.items,
    };
  });

  // whatever is still sitting in the queue is unallocated credit
  const advance = round2(queue.slice(qi).reduce((s, p) => s + Math.max(p.left, 0), 0));
  const paid = round2(legacyTotal + allocatedTotal);

  return {
    invoices: rows,
    billed,
    paid,
    balance: round2(Math.max(billed - paid, 0)),
    advance,
  };
}

// ── bulk settlement for every customer, in 3 queries ─────────────────────────
/**
 * Settles the whole book at once so list endpoints don't fire one query per row.
 *
 * Pass `invoices` when the caller has already loaded them (listInvoices does),
 * otherwise the minimum set of columns is fetched here.
 *
 * Cancelled invoices are excluded from allocation and get no entry in
 * `byInvoice` — callers should fall back to the invoice's own paidAmount for
 * anything missing from the map.
 */
export async function buildSettlement(invoices?: SettleInvoice[]): Promise<Settlement> {
  const [allInvoices, customers, payments] = await Promise.all([
    invoices ??
      prisma.invoice.findMany({
        select: {
          id: true,
          total: true,
          paidAmount: true,
          status: true,
          customerId: true,
          clientPhone: true,
          date: true,
          createdAt: true,
        },
      }),
    prisma.customer.findMany({ select: { id: true, phone: true } }),
    // oldest-first: settle() walks these in order to keep cash/online straight
    prisma.customerPayment.findMany({
      select: { customerId: true, amount: true, method: true },
      orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  // phone → customerId, so bills saved before the customer record existed
  // (matched by phone only) still land on the right tab
  const phoneToCustomer = new Map<string, string>();
  for (const c of customers) {
    const key = last10(c.phone);
    if (key.length === 10 && !phoneToCustomer.has(key)) phoneToCustomer.set(key, c.id);
  }

  const paymentsByCustomer = new Map<string, SettlePayment[]>();
  for (const p of payments) {
    const list = paymentsByCustomer.get(p.customerId);
    if (list) list.push(p);
    else paymentsByCustomer.set(p.customerId, [p]);
  }

  // group invoices onto their customer's tab
  const invoicesByCustomer = new Map<string, SettleInvoice[]>();
  for (const inv of allInvoices as SettleInvoice[]) {
    if (inv.status === "cancelled") continue;
    const key = inv.customerId || phoneToCustomer.get(last10(inv.clientPhone)) || "";
    if (!key) continue;
    const list = invoicesByCustomer.get(key);
    if (list) list.push(inv);
    else invoicesByCustomer.set(key, [inv]);
  }

  const byInvoice = new Map<string, SettledRow>();
  const byCustomer = new Map<string, AccountTotals>();

  const stamp = (v: Date | string | null | undefined) => {
    const t = v ? new Date(v).getTime() : NaN;
    return Number.isFinite(t) ? t : 0;
  };

  for (const [customerId, list] of invoicesByCustomer) {
    // FIFO — oldest bill first, matching the ledger route's ordering
    list.sort((a, b) => stamp(a.date) - stamp(b.date) || stamp(a.createdAt) - stamp(b.createdAt));

    const result = settle(list, paymentsByCustomer.get(customerId) ?? []);

    for (const r of result.invoices) {
      byInvoice.set(r.id, {
        accountPaid: r.allocated,
        accountCash: r.allocatedCash,
        accountOnline: r.allocatedOnline,
        legacyPaid: r.legacyPaid,
        settled: r.settled,
        due: r.due,
        status: r.status,
      });
    }

    byCustomer.set(customerId, {
      billed: result.billed,
      paid: result.paid,
      balance: result.balance,
      advance: result.advance,
    });
  }

  return { byInvoice, byCustomer };
}

/** Convenience for a single customer — same maths, one tab. */
export async function settleCustomer(customerId: string): Promise<AccountTotals> {
  const { byCustomer } = await buildSettlement();
  return byCustomer.get(customerId) ?? { billed: 0, paid: 0, balance: 0, advance: 0 };
}

// ── settle a single freshly-mutated invoice ──────────────────────────────────
/**
 * Wraps one invoice in the same settled figures GET / sends.
 *
 * The mutation endpoints (record payment, edit, delete payment, cancel /
 * reactivate) return the updated row and the UI swaps it into the list in place
 * WITHOUT reloading. recomputeInvoice() only knows about this invoice's own
 * Payment rows, so without this wrapper a row would snap back to its unsettled
 * numbers the moment it was touched, and only correct itself on the next
 * Refresh. Every endpoint that hands an invoice back to the client should send
 * it through here.
 */
export async function withAccountSettlement<
  T extends { id: string; total: unknown; paidAmount: unknown; status?: string | null },
>(invoice: T) {
  const { byInvoice } = await buildSettlement();
  const s = byInvoice.get(invoice.id);
  const total = num(invoice.total);
  const legacyPaid = num(invoice.paidAmount);

  return {
    ...invoice,
    paidAmount: s ? s.settled : legacyPaid,
    legacyPaid,
    accountPaid: s?.accountPaid ?? 0,
    accountCash: s?.accountCash ?? 0,
    accountOnline: s?.accountOnline ?? 0,
    balanceDue: s ? s.due : round2(Math.max(total - legacyPaid, 0)),
    status: invoice.status === "cancelled" ? invoice.status : (s?.status ?? invoice.status),
  };
}