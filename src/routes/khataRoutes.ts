import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";

const router = Router();
router.use(protect, adminOnly);

const toDecimal = (v: unknown) => {
  const n = parseFloat(String(v ?? "0"));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const normPhone = (v: unknown) => String(v ?? "").replace(/[\s\-()]/g, "").replace(/^\+91/, "").replace(/^0+/, "");

// Ensure a customer (User role "client") exists for this client; create if missing. Never throws.
async function ensureCustomer(client: { name?: unknown; phone?: unknown; email?: unknown }) {
  try {
    const name = String(client.name ?? "").trim();
    const phone = String(client.phone ?? "").trim();
    const email = String(client.email ?? "").trim().toLowerCase();
    const np = normPhone(phone);
    if (!name && !np && !email) return;

    let existing = null as null | { id: string };
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

    await prisma.user.create({
      data: {
        name: name || "Walk-in customer",
        email: safeEmail,
        phone: phone || "",
        source: "offline" as any,
        notes: "Auto-added from Khata invoice",
        password: `nologin:${crypto.randomBytes(24).toString("hex")}`,
      },
    });
  } catch (e) { console.error("ensureCustomer (khata) failed:", e); }
}

// GET /api/khata — all entries, with optional date filter ?date=2026-08-23
router.get("/", async (req: Request, res: Response) => {
  try {
    const { date, customerId } = req.query;
    const where: any = {};
    if (date) {
      const d = new Date(String(date));
      const start = new Date(d); start.setHours(0, 0, 0, 0);
      const end   = new Date(d); end.setHours(23, 59, 59, 999);
      where.entryDate = { gte: start, lte: end };
    }
    if (customerId) where.customerId = String(customerId);
    const entries = await prisma.khataEntry.findMany({
      where,
      orderBy: { entryDate: "desc" },
    });
    res.json(entries);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /api/khata/ledger — per-customer running totals
router.get("/ledger", async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.khataEntry.groupBy({
      by: ["customerId", "customerName", "customerPhone"],
      _sum: { amount: true, advancePaid: true },
      _count: { id: true },
      orderBy: { _sum: { amount: "desc" } },
    });
    // Count how many entries per customer are still unbilled
    const unbilled = await prisma.khataEntry.groupBy({
      by: ["customerId", "customerName", "customerPhone"],
      where: { status: { not: "billed" } },
      _count: { id: true },
    });
    const keyOf = (cid: string | null, name: string, phone: string) => `${cid || ""}|${name}|${phone || ""}`;
    const unbilledMap = new Map<string, number>();
    unbilled.forEach((u) => unbilledMap.set(keyOf(u.customerId, u.customerName, u.customerPhone), u._count.id));
    const ledger = rows.map((r) => ({
      customerId:    r.customerId,
      customerName:  r.customerName,
      customerPhone: r.customerPhone,
      totalOrders:   r._count.id,
      unbilledCount: unbilledMap.get(keyOf(r.customerId, r.customerName, r.customerPhone)) || 0,
      totalAmount:   Number(r._sum.amount  ?? 0),
      totalAdvance:  Number(r._sum.advancePaid ?? 0),
      totalDue:      Math.max(0, Number(r._sum.amount ?? 0) - Number(r._sum.advancePaid ?? 0)),
    }));
    res.json(ledger);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /api/khata — create entry
router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      customerId, customerName, customerPhone, customerEmail,
      items, description, amount, advancePaid, paymentMethod, entryDate,
    } = req.body;
    if (!customerName?.trim()) return res.status(400).json({ error: "customerName required" });
    if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "At least one item required" });

    const entry = await prisma.khataEntry.create({
      data: {
        customerId:    customerId?.trim() || null,
        customerName:  customerName.trim(),
        customerPhone: customerPhone?.trim() || "",
        customerEmail: customerEmail?.trim() || "",
        items,
        description:   description?.trim() || "",
        amount:        toDecimal(amount),
        advancePaid:   toDecimal(advancePaid),
        paymentMethod: paymentMethod || "cash",
        entryDate:     entryDate ? new Date(entryDate) : new Date(),
        createdById:   req.user!.id,
      },
    });
    res.status(201).json(entry);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/khata/:id — edit entry (only unbilled)
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.khataEntry.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Entry not found" });
    if (existing.status === "billed") return res.status(400).json({ error: "Cannot edit a billed entry" });
    const {
      customerName, customerPhone, customerEmail,
      items, description, amount, advancePaid, paymentMethod, entryDate,
    } = req.body;
    const updated = await prisma.khataEntry.update({
      where: { id: String(req.params.id) },
      data: {
        ...(customerName  !== undefined && { customerName:  customerName.trim() }),
        ...(customerPhone !== undefined && { customerPhone: customerPhone?.trim() || "" }),
        ...(customerEmail !== undefined && { customerEmail: customerEmail?.trim() || "" }),
        ...(items         !== undefined && { items }),
        ...(description   !== undefined && { description: description?.trim() || "" }),
        ...(amount        !== undefined && { amount:      toDecimal(amount) }),
        ...(advancePaid   !== undefined && { advancePaid: toDecimal(advancePaid) }),
        ...(paymentMethod !== undefined && { paymentMethod }),
        ...(entryDate     !== undefined && { entryDate: new Date(entryDate) }),
      },
    });
    res.json(updated);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/khata/:id — only unbilled
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.khataEntry.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) return res.status(404).json({ error: "Entry not found" });
    if (existing.status === "billed") return res.status(400).json({ error: "Cannot delete a billed entry" });
    await prisma.khataEntry.delete({ where: { id: String(req.params.id) } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /api/khata/:id/convert — convert to invoice
router.post("/:id/convert", async (req: Request, res: Response) => {
  try {
    const entry = await prisma.khataEntry.findUnique({ where: { id: String(req.params.id) } });
    if (!entry) return res.status(404).json({ error: "Entry not found" });
    if (entry.status === "billed") return res.status(400).json({ error: "Already converted to invoice" });

    // Generate invoice number
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, "0");
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const yy = String(today.getFullYear()).slice(-2);
    const count = await prisma.invoice.count();
    const invoiceNo = `AA-${yy}${mm}${dd}-${String(count + 1).padStart(3, "0")}`;

    // Get business settings
    const settings = await prisma.setting.findMany({ where: { key: { in: ["businessName","businessPhone","businessAddress","businessEmail","businessGstin","businessPan"] } } });
    const s: Record<string, string> = {};
    settings.forEach((st) => { s[st.key] = st.value; });

    const items = entry.items as Array<{ desc: string; qty: number; rate: number }>;
    const subtotal = items.reduce((sum, it) => sum + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0);

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo,
        date:        entry.entryDate,
        clientName:  entry.customerName,
        clientPhone: entry.customerPhone || null,
        clientEmail: entry.customerEmail || null,
        source:      "offline",
        business: {
          name:    s.businessName    || "Abhijit Art",
          phone:   s.businessPhone   || "7405179066",
          address: s.businessAddress || "Rabindra Sadan, Shakti Mandir Club, SS Sen Road Berhampore, West Bengal - 742101",
          email:   s.businessEmail   || "abhijitart85@gmail.com",
          gstin:   s.businessGstin   || "19AQFPD8346K1ZH",
          pan:     s.businessPan     || "AQFPD8346K",
        },
        items:       (entry.items ?? []) as any,
        discType:    "amount",
        discVal:     0,
        taxPct:      0,
        subtotal,
        discountAmt: 0,
        taxAmt:      0,
        total:       subtotal,
        paidAmount:  entry.advancePaid,
        status:      Number(entry.advancePaid) >= subtotal ? "paid" : Number(entry.advancePaid) > 0 ? "partial" : "unpaid",
        notes:       "Keep the invoices for Future References",
        createdById: req.user!.id,
      },
    });

    // Auto-add this customer if not already in the database
    await ensureCustomer({ name: entry.customerName, phone: entry.customerPhone, email: entry.customerEmail });

    // Record the advance as a payment on the invoice
    if (Number(entry.advancePaid) > 0) {
      await prisma.payment.create({
        data: {
          invoiceId:   invoice.id,
          amount:      entry.advancePaid,
          method:      entry.paymentMethod,
          note:        "Advance from Khata",
          createdById: req.user!.id,
        },
      });
    }

    // Mark khata entry as billed
    await prisma.khataEntry.update({
      where: { id: entry.id },
      data: { status: "billed", invoiceId: invoice.id, invoiceNo },
    });

    res.json({ invoice, invoiceNo });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /api/khata/convert-combined — merge multiple unbilled entries into ONE invoice
router.post("/convert-combined", async (req: Request, res: Response) => {
  try {
    const { entryIds } = req.body as { entryIds: string[] };
    if (!Array.isArray(entryIds) || entryIds.length === 0)
      return res.status(400).json({ error: "No entries selected" });

    // Fetch all requested entries that are still unbilled
    const entries = await prisma.khataEntry.findMany({ where: { id: { in: entryIds } } });
    const unbilled = entries.filter((e) => e.status !== "billed");
    if (unbilled.length === 0) return res.status(400).json({ error: "All selected entries are already invoiced" });

    // All must be the same customer
    const first = unbilled[0];
    const sameCustomer = unbilled.every((e) => e.customerName === first.customerName && (e.customerPhone || "") === (first.customerPhone || ""));
    if (!sameCustomer) return res.status(400).json({ error: "Entries belong to different customers" });

    // Generate invoice number
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, "0");
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const yy = String(today.getFullYear()).slice(-2);
    const count = await prisma.invoice.count();
    const invoiceNo = `AA-${yy}${mm}${dd}-${String(count + 1).padStart(3, "0")}`;

    // Business settings
    const settings = await prisma.setting.findMany({ where: { key: { in: ["businessName","businessPhone","businessAddress","businessEmail","businessGstin","businessPan"] } } });
    const s: Record<string, string> = {};
    settings.forEach((st) => { s[st.key] = st.value; });

    // Merge all items across entries
    const mergedItems: Array<{ desc: string; qty: number; rate: number }> = [];
    let totalAdvance = 0;
    for (const e of unbilled) {
      const items = e.items as Array<{ desc: string; qty: number; rate: number }>;
      for (const it of items) mergedItems.push({ desc: it.desc, qty: Number(it.qty) || 0, rate: Number(it.rate) || 0 });
      totalAdvance += Number(e.advancePaid) || 0;
    }
    const subtotal = mergedItems.reduce((sum, it) => sum + it.qty * it.rate, 0);

    // Use the most recent entry's date and payment method
    const latest = unbilled.reduce((a, b) => (a.entryDate > b.entryDate ? a : b));

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo,
        date:        latest.entryDate,
        clientName:  first.customerName,
        clientPhone: first.customerPhone || null,
        clientEmail: first.customerEmail || null,
        source:      "offline",
        business: {
          name:    s.businessName    || "Abhijit Art",
          phone:   s.businessPhone   || "7405179066",
          address: s.businessAddress || "Rabindra Sadan, Shakti Mandir Club, SS Sen Road Berhampore, West Bengal - 742101",
          email:   s.businessEmail   || "abhijitart85@gmail.com",
          gstin:   s.businessGstin   || "19AQFPD8346K1ZH",
          pan:     s.businessPan     || "AQFPD8346K",
        },
        items:       mergedItems,
        discType:    "amount",
        discVal:     0,
        taxPct:      0,
        subtotal,
        discountAmt: 0,
        taxAmt:      0,
        total:       subtotal,
        paidAmount:  totalAdvance,
        status:      totalAdvance >= subtotal ? "paid" : totalAdvance > 0 ? "partial" : "unpaid",
        notes:       "Keep the invoices for Future References",
        createdById: req.user!.id,
      },
    });

    // Auto-add this customer if not already in the database
    await ensureCustomer({ name: first.customerName, phone: first.customerPhone, email: first.customerEmail });

    // Record combined advance as one payment
    if (totalAdvance > 0) {
      await prisma.payment.create({
        data: {
          invoiceId:   invoice.id,
          amount:      totalAdvance,
          method:      latest.paymentMethod,
          note:        `Combined advance from ${unbilled.length} Khata entries`,
          createdById: req.user!.id,
        },
      });
    }

    // Mark ALL merged entries as billed → same invoice
    await prisma.khataEntry.updateMany({
      where: { id: { in: unbilled.map((e) => e.id) } },
      data: { status: "billed", invoiceId: invoice.id, invoiceNo },
    });

    res.json({ invoice, invoiceNo, mergedCount: unbilled.length });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});


export default router;