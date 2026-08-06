// backend/src/routes/userRoutes.ts
import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
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

    const where: Prisma.UserWhereInput = {};
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
    if (!email) return res.status(400).json({ message: "Email is required so you can send this customer offers." });
    if (!isEmail(email)) return res.status(400).json({ message: "That email doesn't look right." });

    const clash = await prisma.user.findUnique({ where: { email } });
    if (clash) return res.status(409).json({ message: "A customer with this email already exists." });

    const user = await prisma.user.create({
      data: {
        name,
        email,
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
    /* Accept BOTH the new field names and the older ones the EmailDrawer may
       still be sending (message⇄body, buttonText⇄ctaLabel, buttonLink⇄ctaUrl),
       so a not-yet-updated frontend doesn't trip a false "Message is required".
       Once the frontend sends the new names, delete the three legacy aliases. */
    const _b = req.body as {
      userIds?: string[];
      subject?: string;
      message?: string;
      body?: string; // legacy alias → message
      buttonText?: string;
      ctaLabel?: string; // legacy alias → buttonText
      buttonLink?: string;
      ctaUrl?: string; // legacy alias → buttonLink
    };
    const userIds = _b.userIds;
    const subject = _b.subject;
    const message = _b.message ?? _b.body;
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

    /* Fail fast with the REAL reason if SMTP auth/connection is broken, instead
       of N identical per-recipient errors — this surfaces straight to the modal. */
    try {
      await transporter.verify();
    } catch (e: any) {
      console.error("✉️  SMTP verify failed:", e?.message || e);
      return res.status(500).json({
        message: `Email server not reachable: ${e?.message || "SMTP connection/auth failed"}. Check SMTP_USER / SMTP_PASS (Gmail App Password) and MAIL_FROM.`,
      });
    }

    /* Public URLs for the branded shell — NEVER the localhost dev URL. */
    const siteUrl = process.env.PUBLIC_SITE_URL || "https://abhijitart.com";
    const logoUrl = process.env.EMAIL_LOGO_URL || undefined;

    let sent = 0;
    const failures: { email: string; error: string }[] = [];
    const skipped: string[] = [];

    // one personalised email per recipient, paced so Gmail SMTP doesn't throttle
    for (const u of users) {
      const to = (u.email || "").trim();
      if (!to) {
        skipped.push(u.name || u.id); // no address on file → skip
        continue;
      }

      const first = firstNameOf(u.name);
      const subj = fillTokens(subject!, u.name, first);
      const body = fillTokens(message!, u.name, first);

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
        /* ── OPTIONAL EXTRAS (kept from your earlier version) ──────────────
           If you want the bare send, drop `text` + `headers` below and the
           accepted/rejected block, and replace the whole try with:
             await transporter.sendMail({ from: MAIL_FROM, to, subject: subj, html });
             sent += 1;
           ------------------------------------------------------------------ */
        const info = (await transporter.sendMail({
          from: MAIL_FROM,
          to,
          subject: subj,
          html,
          // plain-text fallback for HTML-blocking clients (also helps the spam score)
          text:
            body +
            `\n\n—\nAbhijit Art · Berhampore, West Bengal\n${siteUrl}\n` +
            `You're receiving this because you're a customer. Reply "unsubscribe" to opt out.`,
          /* Gmail leans on List-Unsubscribe when deciding Inbox vs Promotions vs
             Spam for bulk mail from a personal address — without it these get filtered. */
          headers: {
            "List-Unsubscribe": `<mailto:${process.env.SMTP_USER || ""}?subject=unsubscribe>`,
          },
        })) as {
          accepted?: (string | { address: string })[];
          rejected?: (string | { address: string })[];
          response?: string;
          messageId?: string;
        };

        /* One recipient per send, so a non-throwing sendMail means Gmail
           accepted the message. We still flag the rare case where the address
           is explicitly refused in info.rejected (rather than throwing). The
           earlier `accepted.length === 0` check was dropped — it could mark a
           genuinely-sent mail as "failed" when Gmail returned no accepted list. */
        const addr = (a: string | { address: string }) => (typeof a === "string" ? a : a.address);
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

    res.json({
      sent,
      failed: failures.length,
      skipped: skipped.length,
      total: users.length,
      failures,
    });
  } catch (err) {
    console.error("Bulk email error:", err);
    res.status(500).json({ message: "Couldn't send the emails." });
  }
});

export default router;