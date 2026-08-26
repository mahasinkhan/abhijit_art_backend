// backend/src/routes/userRoutes.ts
import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";
import { transporter } from "../config/mailer.js";
import { renderCustomerEmail } from "../utils/emailTemplate.js";
import { employeeController } from "../controllers/employee.controller.js";

const router = Router();
router.use(protect, adminOnly);

const customerSelect = {
  id: true, name: true, email: true, phone: true,
  role: true, address: true, notes: true, source: true, createdAt: true,
} satisfies Prisma.UserSelect;

const str     = (v: unknown) => String(v ?? "").trim();
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

async function countOrders(): Promise<Record<string, number>> {
  const orderCount: Record<string, number> = {};
  try {
    const grouped = await prisma.booking.groupBy({ by: ["userId"], _count: true });
    for (const g of grouped) {
      if (g.userId) orderCount[g.userId] = g._count as unknown as number;
    }
  } catch (e) {
    console.warn("Customer order counts unavailable:", (e as Error).message);
  }
  return orderCount;
}

async function countOrdersFor(userId: string): Promise<number> {
  try { return await prisma.booking.count({ where: { userId } }); }
  catch (e) { console.warn("Order count unavailable:", (e as Error).message); return 0; }
}

/* ═══════════════════════════════ CUSTOMERS ══════════════════════════════════ */

router.get("/", async (req: Request, res: Response) => {
  try {
    const q      = str(req.query.q);
    const source = str(req.query.source).toLowerCase();
    const where: Prisma.UserWhereInput = { role: "client" };
    if (q) {
      where.OR = [
        { name:  { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
      ];
    }
    if (source === "online" || source === "offline") where.source = source as any;

    const users      = await prisma.user.findMany({ where, orderBy: { createdAt: "desc" }, select: customerSelect });
    const orderCount = await countOrders();
    res.json(users.map((u) => ({ ...u, _count: { bookings: orderCount[u.id] ?? 0 } })));
  } catch (err) {
    console.error("GET /users failed:", err);
    res.status(500).json({ message: "Failed to load customers" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const name    = str(req.body.name);
    const email   = str(req.body.email).toLowerCase();
    const phone   = str(req.body.phone);
    const address = str(req.body.address);
    const notes   = str(req.body.notes);

    if (!name) return res.status(400).json({ message: "Name is required." });

    const normP      = phone.replace(/[\s\-()]/g, "").replace(/^\+91/, "").replace(/^0+/, "");
    const finalEmail = email
      ? (isEmail(email) ? email : "")
      : `cust-${normP || crypto.randomBytes(5).toString("hex")}@noemail.abhijitart`;
    if (email && !finalEmail)
      return res.status(400).json({ message: "That email doesn't look right." });

    const clash = await prisma.user.findUnique({ where: { email: finalEmail } });
    if (clash)
      return res.status(409).json({ message: "A customer with this email already exists." });

    const user = await prisma.user.create({
      data: {
        name, email: finalEmail,
        phone: phone || undefined,
        address: address || null,
        notes: notes || null,
        source: "offline" as any,
        password: `nologin:${crypto.randomBytes(24).toString("hex")}`,
      },
      select: customerSelect,
    });

    res.status(201).json({ ...user, _count: { bookings: 0 } });
  } catch (err) {
    console.error("Customer create failed:", err);
    res.status(500).json({ message: "Failed to save the customer" });
  }
});

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const id       = str(req.params.id);
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Customer not found." });

    const { name, email, phone, address, notes } = req.body;
    const data: Prisma.UserUpdateInput = {};

    if (name !== undefined) {
      if (!str(name)) return res.status(400).json({ message: "Name can't be empty." });
      data.name = str(name);
    }
    if (email !== undefined) {
      const next = str(email).toLowerCase();
      if (!isEmail(next)) return res.status(400).json({ message: "That email doesn't look right." });
      if (next !== existing.email) {
        const clash = await prisma.user.findUnique({ where: { email: next } });
        if (clash) return res.status(409).json({ message: "Another customer already uses this email." });
      }
      data.email = next;
    }
    if (phone   !== undefined) data.phone   = str(phone);
    if (address !== undefined) data.address = str(address) || null;
    if (notes   !== undefined) data.notes   = str(notes)   || null;

    const user = await prisma.user.update({ where: { id }, data, select: customerSelect });
    res.json({ ...user, _count: { bookings: await countOrdersFor(id) } });
  } catch (err) {
    console.error("Customer update failed:", err);
    res.status(500).json({ message: "Failed to update the customer" });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id       = str(req.params.id);
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing)            return res.status(404).json({ message: "Customer not found." });
    if (existing.id === req.user!.id)
      return res.status(400).json({ message: "You can't delete your own account." });
    if (existing.role === "admin")
      return res.status(400).json({ message: "Admin accounts can't be deleted here." });

    const orders = await countOrdersFor(id);
    if (orders > 0)
      return res.status(400).json({ message: `This customer has ${orders} order(s). Deleting them would break that history.` });

    await prisma.user.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error("Customer delete failed:", err);
    res.status(500).json({ message: "Failed to delete the customer" });
  }
});

/* ═══════════════════════════════ EMPLOYEES ══════════════════════════════════
   Thin wrappers — all logic lives in employeeController / employeeService
   ─────────────────────────────────────────────────────────────────────────── */

router.post(   "/employee",     employeeController.create);
router.patch(  "/employee/:id", employeeController.update);
router.delete( "/employee/:id", employeeController.remove);

/* ═══════════════════════════════ BULK EMAIL ═════════════════════════════════ */

const MAIL_FROM = process.env.MAIL_FROM || `Abhijit Art <${process.env.SMTP_USER}>`;
const sleep     = (ms: number) => new Promise((r) => setTimeout(r, ms));
const firstNameOf = (name: string) => (name || "").trim().split(/\s+/)[0] || name || "there";
const fillTokens  = (t: string, full: string, first: string) =>
  String(t ?? "")
    .replace(/\{\{\s*first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*name\s*\}\}/gi, full || first);

router.post("/email", async (req: Request, res: Response) => {
  try {
    const _b = req.body as {
      userIds?: string[]; subject?: string; message?: string; body?: string;
      buttonText?: string; ctaLabel?: string; buttonLink?: string; ctaUrl?: string;
    };
    const userIds    = _b.userIds;
    const subject    = _b.subject;
    const message    = _b.message ?? _b.body;
    const buttonText = _b.buttonText ?? _b.ctaLabel;
    const buttonLink = _b.buttonLink ?? _b.ctaUrl;

    if (!Array.isArray(userIds) || userIds.length === 0)
      return res.status(400).json({ message: "Select at least one customer." });
    if (!str(subject)) return res.status(400).json({ message: "Subject is required." });
    if (!str(message)) return res.status(400).json({ message: "Message is required." });
    if (buttonLink && !/^https:\/\//i.test(buttonLink))
      return res.status(400).json({ message: "Button link must start with https://" });

    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    });

    try { await transporter.verify(); }
    catch (e: any) {
      return res.status(500).json({
        message: `Email server not reachable: ${e?.message || "SMTP connection/auth failed"}.`,
      });
    }

    const siteUrl = process.env.PUBLIC_SITE_URL || "https://abhijitart.com";
    const logoUrl = process.env.EMAIL_LOGO_URL  || undefined;

    let sent = 0;
    const failures: { email: string; error: string }[] = [];
    const skipped:  string[] = [];

    for (const u of users) {
      const to = (u.email || "").trim();
      if (!to) { skipped.push(u.name || u.id); continue; }

      const first = firstNameOf(u.name);
      const subj  = fillTokens(subject!, u.name, first);
      const body  = fillTokens(message!, u.name, first);

      const html = renderCustomerEmail({
        subject: subj, message: body, recipientName: u.name,
        buttonText: buttonText?.trim() || undefined,
        buttonLink: buttonLink?.trim() || undefined,
        phone: "7405179066", email: "abhijitart85@gmail.com",
        siteUrl, logoUrl,
      });

      try {
        const info = (await transporter.sendMail({
          from: MAIL_FROM, to, subject: subj, html,
          text: body + `\n\n—\nAbhijit Art · Berhampore, West Bengal\n${siteUrl}\n` +
            `You're receiving this because you're a customer. Reply "unsubscribe" to opt out.`,
          headers: { "List-Unsubscribe": `<mailto:${process.env.SMTP_USER || ""}?subject=unsubscribe>` },
        })) as { accepted?: unknown[]; rejected?: (string | { address: string })[]; response?: string; messageId?: string; };

        const addr     = (a: string | { address: string }) => (typeof a === "string" ? a : a.address);
        const rejected = (info.rejected || []).map(addr).map((s) => s.toLowerCase());

        if (rejected.includes(to.toLowerCase())) {
          const e = info.response || "The mail server refused this address.";
          console.error(`✉️  refused → ${to}: ${e}`);
          failures.push({ email: to, error: e });
        } else {
          console.log(`✉️  sent → ${to}  ${info.response || ""}`);
          sent += 1;
        }
      } catch (e: any) {
        const errMsg = e?.message || "send failed";
        console.error(`✉️  send threw → ${to}: ${errMsg}`);
        failures.push({ email: to, error: errMsg });
      }

      await sleep(400);
    }

    res.json({ sent, failed: failures.length, skipped: skipped.length, total: users.length, failures });
  } catch (err) {
    console.error("Bulk email error:", err);
    res.status(500).json({ message: "Couldn't send the emails." });
  }
});

export default router;