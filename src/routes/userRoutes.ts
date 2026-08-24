// backend/src/routes/userRoutes.ts
import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";
import { transporter } from "../config/mailer.js";
import { renderCustomerEmail } from "../utils/emailTemplate.js";

const router = Router();

/* every route in this file is admin-only */
router.use(protect, adminOnly);

/* Columns the admin UI needs. Deliberately NO nested `_count` here — order
   counts are resolved separately from Booking.userId (see countOrders), so
   nothing in this file depends on what the User→Booking relation is called. */
const customerSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  address: true,
  notes: true,
  source: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

const str = (v: unknown) => String(v ?? "").trim();
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

/* Order counts per customer — best-effort, so the list never fails even if
   the Booking schema shifts. Same approach as the original GET /users. */
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

/* orders for ONE customer — used by the delete guard and PATCH's response */
async function countOrdersFor(userId: string): Promise<number> {
  try {
    return await prisma.booking.count({ where: { userId } });
  } catch (e) {
    console.warn("Order count unavailable:", (e as Error).message);
    return 0;
  }
}

/* ═══════════════════════════════ LIST ═══════════════════════════════ */

/* GET /api/users?q=&source=  — newest first */
router.get("/", async (req: Request, res: Response) => {
  try {
    const q = str(req.query.q);
    const source = str(req.query.source).toLowerCase();

    const where: Prisma.UserWhereInput = { role: "client" };
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
      ];
    }
    if (source === "online" || source === "offline") where.source = source as any;

    const users = await prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: customerSelect,
    });

    const orderCount = await countOrders();
    res.json(users.map((u) => ({ ...u, _count: { bookings: orderCount[u.id] ?? 0 } })));
  } catch (err) {
    console.error("GET /users failed:", err);
    res.status(500).json({ message: "Failed to load customers" });
  }
});

/* ═══════════════════════════ MANUAL / WALK-IN ═══════════════════════════
   Offline customers are ordinary User rows (source = offline) so their
   bookings and invoices link exactly like a self-registered client's.

   They never chose a password, so we store a random opaque string that is not
   a valid bcrypt hash: comparison against it can never succeed, so the account
   can't be logged into until the customer sets a password via Forgot password.
   ──────────────────────────────────────────────────────────────────── */
router.post("/", async (req: Request, res: Response) => {
  try {
    const name = str(req.body.name);
    const email = str(req.body.email).toLowerCase();
    const phone = str(req.body.phone);
    const address = str(req.body.address);
    const notes = str(req.body.notes);

    if (!name) return res.status(400).json({ message: "Name is required." });
    // Email is optional for walk-in customers — synthesize a placeholder so the
    // (unique, required) email column is satisfied. Real emails are validated.
    const normP = phone.replace(/[\s\-()]/g, "").replace(/^\+91/, "").replace(/^0+/, "");
    const finalEmail = email
      ? (isEmail(email) ? email : "")
      : `cust-${normP || crypto.randomBytes(5).toString("hex")}@noemail.abhijitart`;
    if (email && !finalEmail) return res.status(400).json({ message: "That email doesn't look right." });

    const clash = await prisma.user.findUnique({ where: { email: finalEmail } });
    if (clash) return res.status(409).json({ message: "A customer with this email already exists." });

    const user = await prisma.user.create({
      data: {
        name,
        email: finalEmail,
        phone: phone || undefined,
        address: address || null,
        notes: notes || null,
        source: "offline" as any,
        // unusable by design — see the note above
        password: `nologin:${crypto.randomBytes(24).toString("hex")}`,
      },
      select: customerSelect,
    });

    // brand new customer, so no orders yet
    res.status(201).json({ ...user, _count: { bookings: 0 } });
  } catch (err) {
    console.error("Customer create failed:", err);
    res.status(500).json({ message: "Failed to save the customer" });
  }
});

/* edit a customer's details (never touches role or password) */
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const id = str(req.params.id);
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
    if (phone !== undefined) data.phone = str(phone);
    if (address !== undefined) data.address = str(address) || null;
    if (notes !== undefined) data.notes = str(notes) || null;

    const user = await prisma.user.update({ where: { id }, data, select: customerSelect });
    res.json({ ...user, _count: { bookings: await countOrdersFor(id) } });
  } catch (err) {
    console.error("Customer update failed:", err);
    res.status(500).json({ message: "Failed to update the customer" });
  }
});

/* delete — refuses admins, yourself, and anyone with order history */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = str(req.params.id);
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Customer not found." });
    if (existing.id === req.user!.id) return res.status(400).json({ message: "You can't delete your own account." });
    if (existing.role === "admin") return res.status(400).json({ message: "Admin accounts can't be deleted here." });

    const orders = await countOrdersFor(id);
    if (orders > 0) {
      return res.status(400).json({
        message: `This customer has ${orders} order(s). Deleting them would break that history.`,
      });
    }

    await prisma.user.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error("Customer delete failed:", err);
    res.status(500).json({ message: "Failed to delete the customer" });
  }
});

/* ═══════════════════════ EMPLOYEE MANAGEMENT ═══════════════════════
   POST   /api/users/employee        — create employee account
   PATCH  /api/users/employee/:id    — edit name / phone / password
   DELETE /api/users/employee/:id    — remove employee + their tasks
   GET    /api/users/employees       — list all employees (with task count)
   ──────────────────────────────────────────────────────────────────── */

/* POST /api/users/employee — admin creates a new employee account */
router.post("/employee", async (req: Request, res: Response) => {
  try {
    const name     = str(req.body.name);
    const email    = str(req.body.email).toLowerCase();
    const phone    = str(req.body.phone);
    const password = str(req.body.password);

    if (!name || !email || !password)
      return res.status(400).json({ error: "name, email and password are required" });
    if (password.length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (!isEmail(email))
      return res.status(400).json({ error: "That email doesn't look right." });

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing)
      return res.status(409).json({ error: "An account with this email already exists" });

    const hashed = await bcrypt.hash(password, 10);
    const employee = await prisma.user.create({
      data: {
        name,
        email,
        phone: phone || "",
        password: hashed,
        role: "employee",
        source: "offline",
      },
      select: {
        id: true, name: true, email: true, phone: true,
        role: true, createdAt: true,
        _count: { select: { tasksAssigned: true } },
      },
    });

    res.status(201).json(employee);
  } catch (err: any) {
    console.error("Employee create failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/* PATCH /api/users/employee/:id — edit name / phone / reset password */
router.patch("/employee/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
    if (!existing || existing.role !== "employee")
      return res.status(404).json({ error: "Employee not found" });

    const { name, phone, password } = req.body;
    const data: Prisma.UserUpdateInput = {};

    if (name  !== undefined) data.name  = str(name);
    if (phone !== undefined) data.phone = str(phone);
    if (password) {
      if (str(password).length < 6)
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      data.password = await bcrypt.hash(str(password), 10);
    }

    const updated = await prisma.user.update({
      where: { id: String(req.params.id) },
      data,
      select: {
        id: true, name: true, email: true, phone: true,
        role: true, createdAt: true,
        _count: { select: { tasksAssigned: true } },
      },
    });

    res.json(updated);
  } catch (err: any) {
    console.error("Employee update failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/* DELETE /api/users/employee/:id — removes employee and their assigned tasks */
router.delete("/employee/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
    if (!existing || existing.role !== "employee")
      return res.status(404).json({ error: "Employee not found" });

    // Delete their assigned tasks first (assignedToId is required on Task)
    await prisma.task.deleteMany({ where: { assignedToId: String(req.params.id) } });
    await prisma.user.delete({ where: { id: String(req.params.id) } });

    res.json({ success: true });
  } catch (err: any) {
    console.error("Employee delete failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════ EMAIL ═══════════════════════════════
   POST /api/users/email
     { userIds: string[], subject, message, buttonText?, buttonLink? }

   One personalised email per recipient, sent SEQUENTIALLY with a short pause
   between sends so Gmail SMTP doesn't throttle a long list. Each message goes
   out individually (never a shared To:/CC:) so recipients can't see each other
   and {{name}}/{{first_name}} are personalised per person.

   The admin's plain text has its tokens filled first, then the personalised
   text is handed to the shared renderCustomerEmail() template
   (backend/src/utils/emailTemplate.ts), which escapes it, splits it into
   paragraphs and wraps it in the branded shell.

   The logo + links inside the shell MUST be public https URLs, so we feed
   PUBLIC_SITE_URL / EMAIL_LOGO_URL — never the localhost dev URL, which shows
   as a dead link + broken logo image in real inboxes.
   ──────────────────────────────────────────────────────────────────── */

const MAIL_FROM = process.env.MAIL_FROM || `Abhijit Art <${process.env.SMTP_USER}>`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const firstNameOf = (name: string) => (name || "").trim().split(/\s+/)[0] || name || "there";

/* {{name}} / {{first_name}} → the recipient's own name (first name resolved once) */
const fillTokens = (t: string, full: string, first: string) =>
  String(t ?? "")
    .replace(/\{\{\s*first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*name\s*\}\}/gi, full || first);

router.post("/email", async (req: Request, res: Response) => {
  try {
    const _b = req.body as {
      userIds?: string[];
      subject?: string;
      message?: string;
      body?: string;
      buttonText?: string;
      ctaLabel?: string;
      buttonLink?: string;
      ctaUrl?: string;
    };
    const userIds    = _b.userIds;
    const subject    = _b.subject;
    const message    = _b.message ?? _b.body;
    const buttonText = _b.buttonText ?? _b.ctaLabel;
    const buttonLink = _b.buttonLink ?? _b.ctaUrl;

    if (!Array.isArray(userIds) || userIds.length === 0)
      return res.status(400).json({ message: "Select at least one customer." });
    if (!String(subject || "").trim()) return res.status(400).json({ message: "Subject is required." });
    if (!String(message || "").trim()) return res.status(400).json({ message: "Message is required." });
    if (buttonLink && !/^https:\/\//i.test(buttonLink))
      return res.status(400).json({ message: "Button link must start with https://" });

    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    });

    try {
      await transporter.verify();
    } catch (e: any) {
      console.error("✉️  SMTP verify failed:", e?.message || e);
      return res.status(500).json({
        message: `Email server not reachable: ${e?.message || "SMTP connection/auth failed"}. Check SMTP_USER / SMTP_PASS (Gmail App Password) and MAIL_FROM.`,
      });
    }

    const siteUrl = process.env.PUBLIC_SITE_URL || "https://abhijitart.com";
    const logoUrl = process.env.EMAIL_LOGO_URL || undefined;

    let sent = 0;
    const failures: { email: string; error: string }[] = [];
    const skipped: string[] = [];

    for (const u of users) {
      const to = (u.email || "").trim();
      if (!to) { skipped.push(u.name || u.id); continue; }

      const first = firstNameOf(u.name);
      const subj  = fillTokens(subject!, u.name, first);
      const body  = fillTokens(message!, u.name, first);

      const html = renderCustomerEmail({
        subject: subj,
        message: body,
        recipientName: u.name,
        buttonText: buttonText?.trim() || undefined,
        buttonLink: buttonLink?.trim() || undefined,
        phone: "7405179066",
        email: "abhijitart85@gmail.com",
        siteUrl,
        logoUrl,
      });

      try {
        const info = (await transporter.sendMail({
          from: MAIL_FROM,
          to,
          subject: subj,
          html,
          text:
            body +
            `\n\n—\nAbhijit Art · Berhampore, West Bengal\n${siteUrl}\n` +
            `You're receiving this because you're a customer. Reply "unsubscribe" to opt out.`,
          headers: {
            "List-Unsubscribe": `<mailto:${process.env.SMTP_USER || ""}?subject=unsubscribe>`,
          },
        })) as {
          accepted?: (string | { address: string })[];
          rejected?: (string | { address: string })[];
          response?: string;
          messageId?: string;
        };

        const addr     = (a: string | { address: string }) => (typeof a === "string" ? a : a.address);
        const rejected = (info.rejected || []).map(addr).map((s) => s.toLowerCase());

        if (rejected.includes(to.toLowerCase())) {
          const err = info.response || "The mail server refused this address.";
          console.error(`✉️  refused → ${to}: ${err}`);
          failures.push({ email: to, error: err });
        } else {
          console.log(`✉️  sent → ${to}  ${info.response || ""}`);
          sent += 1;
        }
      } catch (e: any) {
        const err = e?.message || "send failed";
        console.error(`✉️  send threw → ${to}: ${err}`);
        failures.push({ email: to, error: err });
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