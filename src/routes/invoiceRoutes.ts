// backend/src/routes/invoiceRoutes.ts
import { Router, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { protect, adminOnly } from "../middleware/auth.js";
import { transporter, mailFrom, siteUrl } from "../config/mailer.js";
import { buildInvoicePdf, pdfHasRupeeGlyph, invoiceLogoPath } from "../utils/invoicePdf.js";
import { prisma } from "../config/prisma.js";
import { isPinSet, verifyPin, logAudit } from "../utils/security.js";

const router = Router();

const str = (v: unknown) => String(v ?? "").trim();
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

const escapeHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/* newlines typed into an address field become line breaks */
const escapeLines = (s: unknown) => escapeHtml(s).replace(/\r?\n/g, "<br/>");

const rupee = (n: number) =>
  "₹" + num(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDate = (d: string) => {
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return str(d);
  return dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

type Party = { name?: string; address?: string; phone?: string; email?: string; gstin?: string; pan?: string };
type Line = { desc?: string; qty?: unknown; rate?: unknown };

/* only these two source values are accepted anywhere; anything else falls back */
const asSource = (v: unknown, fallback: "online" | "offline"): "online" | "offline" =>
  v === "online" ? "online" : v === "offline" ? "offline" : fallback;

/* payment method — only cash | online accepted; anything else falls back.
   online = UPI / card / bank transfer; cash = paid in hand. */
const asMethod = (v: unknown, fallback: "cash" | "online"): "cash" | "online" =>
  v === "cash" ? "cash" : v === "online" ? "online" : fallback;

/* one source of truth for the money math, shared by the email + save routes,
   so the emailed figures, the PDF and the stored record can never disagree.
   Always recomputed from the line items — the browser's arithmetic is ignored. */
function computeTotals(lines: Line[], discType: string | undefined, discValRaw: unknown, taxPctRaw: unknown) {
  const subtotal = lines.reduce((s, it) => s + num(it.qty) * num(it.rate), 0);
  const discVal = num(discValRaw);
  const discountAmt = discType === "percent" ? (subtotal * discVal) / 100 : Math.min(discVal, subtotal);
  const taxable = Math.max(subtotal - discountAmt, 0);
  const taxPct = num(taxPctRaw);
  const taxAmt = (taxable * taxPct) / 100;
  const total = taxable + taxAmt;
  return { subtotal, discVal, discountAmt, taxable, taxPct, taxAmt, total };
}

/* payment state derived from money received vs the invoice total. */
function deriveStatus(paid: number, total: number): "unpaid" | "partial" | "paid" {
  if (paid <= 0.005) return "unpaid";
  if (paid + 0.005 >= total) return "paid";
  return "partial";
}

/* first word of a name, for a friendly greeting */
const firstNameOf = (full: string) => str(full).split(/\s+/)[0] || "there";

/* short personal note for a payment reminder (fallback when the client didn't
   type one). Deliberately carries NO numbers — the email shows a styled
   amount-due card, and WhatsApp appends the figures on the client side. */
function defaultReminderNote(invoice: { clientName: string; business: unknown }) {
  const biz = (invoice.business || {}) as Party;
  const bizName = str(biz.name) || "Abhijit Art";
  const name = firstNameOf(invoice.clientName);
  return `Hi ${name}, this is a gentle reminder from ${bizName} about the invoice below. Whenever it's convenient, we'd appreciate it if you could clear the outstanding balance. Thank you for your business!`;
}

/* the logo for the reminder email — embedded inline via CID so it shows even
   when the client blocks remote images. Prefer whatever the invoice PDF uses;
   otherwise fall back to backend/assets and (in dev) the frontend public dir. */
function resolveLogoPath(): string | null {
  if (invoiceLogoPath) return invoiceLogoPath;
  const candidates = [
    process.env.EMAIL_LOGO_FILE,
    path.resolve(process.cwd(), "assets/abhijit_art_logo.png"),
    path.resolve(process.cwd(), "../frontend/public/images/abhijit_art_logo.png"),
    path.resolve(process.cwd(), "public/images/abhijit_art_logo.png"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}
const reminderLogoPath = resolveLogoPath();

/* the payment history, oldest-first, attached to every invoice we return */
const withPayments = { payments: { orderBy: { createdAt: "asc" as const } } };

/* THE invariant: an invoice's paidAmount is always the SUM of its payment rows
   (clamped to the total), and its status is derived from that. Call this after
   any change to the ledger or the total. reactivate=true clears a "cancelled"
   flag (recording money un-cancels); otherwise a cancelled invoice stays
   cancelled. Returns the updated invoice WITH its payments. */
async function recomputeInvoice(invoiceId: string, opts: { reactivate?: boolean } = {}) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: withPayments });
  if (!inv) return null;
  const total = Number(inv.total);
  const sum = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  const paidAmount = clamp(round2(sum), 0, total);
  const status =
    !opts.reactivate && inv.status === "cancelled" ? "cancelled" : deriveStatus(paidAmount, total);
  return prisma.invoice.update({
    where: { id: invoiceId },
    data: { paidAmount, status: status as "unpaid" | "partial" | "paid" | "cancelled" },
    include: withPayments,
  });
}

/* PIN gate for sensitive actions (delete / cancel / payment / edit). Returns an
   error to send back, or null if the PIN checks out. Reads from req.body.pin. */
async function pinError(req: Request): Promise<{ code: number; message: string } | null> {
  if (!(await isPinSet())) {
    return { code: 409, message: "No security PIN is set yet. Set one in Settings before deleting, cancelling, editing or recording a payment." };
  }
  if (!(await verifyPin(str(req.body?.pin)))) {
    return { code: 403, message: "Incorrect security PIN." };
  }
  return null;
}

/* ── one place to turn a stored invoice record into a PDF ──────────────
   Used by the email reminder, the invoice email re-send, and the public
   /pdf link — so all three render identically, INCLUDING Paid / Balance due
   (paidAmount comes from the ledger-derived field on the record). */
type InvoiceRecord = {
  invoiceNo: string; date: Date; business: unknown;
  clientName: string; clientAddr: string | null; clientPhone: string | null;
  clientEmail: string | null; clientGstin: string | null;
  items: unknown; subtotal: unknown; discType: string; discVal: unknown;
  discountAmt: unknown; taxPct: unknown; taxAmt: unknown; total: unknown;
  paidAmount: unknown; notes: string | null; warranty: string | null;
};
async function buildInvoicePdfFromRecord(invoice: InvoiceRecord): Promise<Buffer> {
  const biz = (invoice.business || {}) as Party;
  const items = Array.isArray(invoice.items) ? (invoice.items as Line[]) : [];
  return buildInvoicePdf({
    invNo: invoice.invoiceNo,
    date: fmtDate(invoice.date.toISOString()),
    biz,
    client: {
      name: invoice.clientName,
      address: invoice.clientAddr || "",
      phone: invoice.clientPhone || "",
      email: invoice.clientEmail || "",
      gstin: invoice.clientGstin || "",
    },
    lines: items.map((it) => ({ desc: str(it.desc), qty: num(it.qty), rate: num(it.rate) })),
    subtotal: Number(invoice.subtotal),
    discountAmt: Number(invoice.discountAmt),
    discountLabel: `Discount${invoice.discType === "percent" ? ` (${Number(invoice.discVal)}%)` : ""}`,
    taxAmt: Number(invoice.taxAmt),
    taxLabel: `GST (${Number(invoice.taxPct)}%)`,
    total: Number(invoice.total),
    paidAmount: Number(invoice.paidAmount),
    notes: invoice.notes || "",
    warranty: invoice.warranty || "",
    siteUrl: siteUrl(),
  });
}

/* ── public invoice PDF: signed, unguessable links ─────────────────────
   A wa.me reminder can't attach a file, so we attach a LINK to a public
   endpoint that streams the PDF. The link is HMAC-signed so it can't be
   guessed or enumerated. Secret: PDF_SIGNING_SECRET, else the JWT secret. */
const PDF_SECRET = process.env.PDF_SIGNING_SECRET || process.env.JWT_SECRET || "";

function pdfSig(invoiceId: string): string {
  return crypto.createHmac("sha256", PDF_SECRET).update(invoiceId).digest("hex").slice(0, 32);
}
function pdfSigValid(invoiceId: string, sig: string): boolean {
  if (!PDF_SECRET || !sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(pdfSig(invoiceId));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Public base URL of THIS backend, for building the shareable PDF link.
   PUBLIC_API_URL wins if set; otherwise it's derived from the incoming
   request — honouring the reverse proxy's X-Forwarded-Host / -Proto — so it
   resolves to the real domain (e.g. https://api.abhijitart.com) in production
   with zero config, and to http://localhost:PORT while developing. */
function resolveApiBase(req: Request): string {
  const override = (process.env.PUBLIC_API_URL || process.env.API_URL || "").replace(/\/+$/, "");
  if (override) return override;

  const host = str(req.headers["x-forwarded-host"]) || str(req.headers.host);
  if (!host) return "";

  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const fwdProto = str(req.headers["x-forwarded-proto"]).split(",")[0].trim();
  const proto = fwdProto || (isLocal ? "http" : "https");
  return `${proto}://${host}`;
}

/* signed, shareable link to an invoice's PDF — null only when there's no
   signing secret (JWT_SECRET is the fallback) or no resolvable host */
function invoicePdfUrl(req: Request, invoiceId: string): string | null {
  if (!PDF_SECRET) return null;
  const base = resolveApiBase(req);
  if (!base) return null;
  return `${base}/api/invoices/${invoiceId}/pdf?sig=${pdfSig(invoiceId)}`;
}

/* ═══════════════════════ PUBLIC INVOICE PDF ═══════════════════════
   GET /api/invoices/:id/pdf?sig=...

   PUBLIC and unauthenticated — registered BEFORE the admin guard below, so a
   client can open it from a WhatsApp link. The HMAC signature is the gate:
   without the right sig it 403s, and ids can't be enumerated. Streams the same
   PDF the email attaches, Paid / Balance due included.
   ─────────────────────────────────────────────────────────── */
router.get("/:id/pdf", async (req: Request, res: Response) => {
  try {
    const id = str(req.params.id);
    const sig = str(req.query.sig);
    if (!pdfSigValid(id, sig)) {
      return res.status(403).json({ message: "Invalid or expired link." });
    }

    const invoice = await prisma.invoice.findUnique({ where: { id }, include: withPayments });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });

    let pdf: Buffer;
    try {
      pdf = await buildInvoicePdfFromRecord(invoice);
    } catch (e) {
      console.error("Public invoice PDF build failed:", (e as Error).message);
      return res.status(500).json({ message: "Couldn't generate the invoice PDF." });
    }

    const safeNo = invoice.invoiceNo.replace(/[^\w.-]+/g, "-") || "invoice";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Invoice-${safeNo}.pdf"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(pdf);
  } catch (err) {
    console.error("Public invoice PDF failed:", err);
    res.status(500).json({ message: "Couldn't generate the invoice PDF." });
  }
});

/* ── everything below is admin-only ──
   (kept AFTER the public /pdf route above so that link needs no login) */
router.use(protect, adminOnly);

/* ═══════════════════════ INVOICE EMAIL ═══════════════════════
   POST /api/invoices/email
     { to, subject, message, invoice: { invNo, date, biz, client, items,
       discType, discVal, taxPct, notes, warranty } }

   The client gets BOTH: the invoice rendered inline as email-safe table HTML
   (readable straight away, no download needed) and a real PDF attachment built
   with PDFKit (the document of record — savable, printable, forwardable).

   Totals are recomputed from the line items on the server, so the emailed
   figures and the PDF can never disagree with the arithmetic, whatever the
   browser posted.
   ─────────────────────────────────────────────────────────── */
router.post("/email", async (req: Request, res: Response) => {
  try {
    const to = str(req.body.to).toLowerCase();
    const subject = str(req.body.subject);
    const message = str(req.body.message);
    const inv = (req.body.invoice || {}) as {
      invNo?: string; date?: string; biz?: Party; client?: Party;
      items?: Line[]; discType?: string; discVal?: unknown; taxPct?: unknown;
      notes?: string; warranty?: string;
    };

    if (!to) return res.status(400).json({ message: "Recipient email is required." });
    if (!isEmail(to)) return res.status(400).json({ message: "That recipient email doesn't look right." });
    if (!subject) return res.status(400).json({ message: "Subject is required." });

    const biz: Party = inv.biz || {};
    const client: Party = inv.client || {};
    const bizName = str(biz.name) || "Abhijit Art";

    /* keep only real lines, exactly like the on-screen preview does */
    const lines = (Array.isArray(inv.items) ? inv.items : []).filter(
      (it) => str(it.desc) || num(it.rate) > 0,
    );
    if (!lines.length) return res.status(400).json({ message: "Add at least one line item before emailing." });

    /* recompute totals server-side — never trust the client's arithmetic */
    const { subtotal, discVal, discountAmt, taxPct, taxAmt, total } = computeTotals(
      lines, inv.discType, inv.discVal, inv.taxPct,
    );

    const site = siteUrl();

    const rows = lines
      .map(
        (it, i) => `<tr>
          <td style="padding:9px 8px;border-bottom:1px solid #f4f5f7;font-size:13px;color:#8a8f9a;text-align:center">${i + 1}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #f4f5f7;font-size:13px;color:#1f2430">${escapeHtml(it.desc) || "—"}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #f4f5f7;font-size:13px;color:#1f2430;text-align:right">${num(it.qty)}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #f4f5f7;font-size:13px;color:#1f2430;text-align:right">${rupee(num(it.rate))}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #f4f5f7;font-size:13px;color:#1f2430;text-align:right">${rupee(num(it.qty) * num(it.rate))}</td>
        </tr>`,
      )
      .join("");

    const totalRow = (label: string, value: string, strong = false) => `<tr>
        <td style="padding:${strong ? "12px" : "6px"} 4px 6px;font-size:${strong ? "15px" : "12.5px"};color:${strong ? "#1f2430" : "#8a8f9a"};font-weight:${strong ? 800 : 400};${strong ? "border-top:1px solid #ececf1;" : ""}">${label}</td>
        <td style="padding:${strong ? "12px" : "6px"} 4px 6px;font-size:${strong ? "16px" : "13px"};text-align:right;font-weight:${strong ? 800 : 700};color:${strong ? "#d9542f" : "#1f2430"};${strong ? "border-top:1px solid #ececf1;" : ""}">${value}</td>
      </tr>`;

    const totalsHtml =
      totalRow("Subtotal", rupee(subtotal)) +
      (discountAmt > 0
        ? totalRow(`Discount${inv.discType === "percent" ? ` (${discVal}%)` : ""}`, "− " + rupee(discountAmt))
        : "") +
      (taxPct > 0 ? totalRow(`GST (${taxPct}%)`, rupee(taxAmt)) : "") +
      totalRow("Total", rupee(total), true);

    const messageHtml = message
      ? message
          .split(/\n\s*\n/)
          .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#1f2430">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
          .join("")
      : "";

    const notesHtml =
      str(inv.notes) || str(inv.warranty)
        ? `<div style="margin-top:22px;padding-top:14px;border-top:1px solid #ececf1;font-size:12px;color:#8a8f9a;line-height:1.6">
             ${str(inv.notes) ? `<b style="color:#545a67">Notes:</b> ${escapeHtml(inv.notes)}<br/>` : ""}
             ${str(inv.warranty) ? `<b style="color:#545a67">Warranty:</b> ${escapeHtml(inv.warranty)}` : ""}
           </div>`
        : "";

    const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f6f8">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:28px 12px">
        <tr><td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #f0e6dc;font-family:'DM Sans',Arial,Helvetica,sans-serif">

            <tr><td style="padding:26px 28px 0">
              ${
                invoiceLogoPath
                  ? `<img src="cid:aa-logo" alt="${escapeHtml(bizName)}" height="52" style="height:52px;width:auto;display:block;border:0" />`
                  : `<div style="font-size:21px;font-weight:800;color:#d9542f;letter-spacing:-0.4px">${escapeHtml(bizName)}</div>`
              }
            </td></tr>

            ${messageHtml ? `<tr><td style="padding:26px 28px 0">${messageHtml}</td></tr>` : ""}

            <tr><td style="padding:26px 28px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:top;font-size:12px;color:#8a8f9a;line-height:1.55">
                    ${escapeLines(biz.address)}
                    ${biz.phone ? `<br/>☎ ${escapeHtml(biz.phone)}` : ""}
                    ${biz.email ? `<br/>✉ ${escapeHtml(biz.email)}` : ""}
                    ${biz.gstin ? `<br/>GSTIN: ${escapeHtml(biz.gstin)}` : ""}
                    ${biz.pan ? `<br/>PAN: ${escapeHtml(biz.pan)}` : ""}
                  </td>
                  <td style="vertical-align:top;text-align:right;white-space:nowrap">
                    <div style="font-size:20px;font-weight:800;letter-spacing:2px;color:#1f2430">INVOICE</div>
                    <div style="font-size:12px;color:#8a8f9a;line-height:1.55;margin-top:4px">
                      No: <b style="color:#1f2430">${escapeHtml(inv.invNo)}</b><br/>
                      Date: ${fmtDate(str(inv.date))}
                    </div>
                  </td>
                </tr>
              </table>
            </td></tr>

            <tr><td style="padding:24px 28px 0">
              <div style="font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:#b6bac3;font-weight:700;margin-bottom:5px">Bill to</div>
              <div style="font-weight:700;font-size:14px;color:#1f2430">${escapeHtml(client.name) || "—"}</div>
              <div style="font-size:12px;color:#8a8f9a;line-height:1.55;margin-top:3px">
                ${escapeLines(client.address)}
                ${client.phone ? `<br/>☎ ${escapeHtml(client.phone)}` : ""}
                ${client.email ? `<br/>✉ ${escapeHtml(client.email)}` : ""}
                ${client.gstin ? `<br/>GSTIN: ${escapeHtml(client.gstin)}` : ""}
              </div>
            </td></tr>

            <tr><td style="padding:22px 28px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                <thead>
                  <tr>
                    <th style="background:#fafbfc;color:#8a8f9a;font-size:10.5px;letter-spacing:.7px;text-transform:uppercase;text-align:center;padding:9px 8px;border-bottom:1px solid #ececf1;width:30px">#</th>
                    <th style="background:#fafbfc;color:#8a8f9a;font-size:10.5px;letter-spacing:.7px;text-transform:uppercase;text-align:left;padding:9px 8px;border-bottom:1px solid #ececf1">Description</th>
                    <th style="background:#fafbfc;color:#8a8f9a;font-size:10.5px;letter-spacing:.7px;text-transform:uppercase;text-align:right;padding:9px 8px;border-bottom:1px solid #ececf1;width:50px">Qty</th>
                    <th style="background:#fafbfc;color:#8a8f9a;font-size:10.5px;letter-spacing:.7px;text-transform:uppercase;text-align:right;padding:9px 8px;border-bottom:1px solid #ececf1;width:90px">Rate</th>
                    <th style="background:#fafbfc;color:#8a8f9a;font-size:10.5px;letter-spacing:.7px;text-transform:uppercase;text-align:right;padding:9px 8px;border-bottom:1px solid #ececf1;width:100px">Amount</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>

              <table role="presentation" cellpadding="0" cellspacing="0" style="width:270px;margin-left:auto;margin-top:14px;border-collapse:collapse">
                <tbody>${totalsHtml}</tbody>
              </table>

              ${notesHtml}
            </td></tr>

            <tr><td style="padding:22px 28px 26px">
              <!-- right-aligned nested table instead of a float: Outlook
                   ignores float/clear, which broke the signature layout -->
              <table role="presentation" cellpadding="0" cellspacing="0" align="right" style="text-align:right">
                <tr><td style="font-size:11px;color:#8a8f9a;padding-bottom:22px">For ${escapeHtml(bizName)}</td></tr>
                <tr><td style="border-top:1px solid #1f2430;padding-top:5px;font-size:11px;color:#1f2430;font-weight:700;white-space:nowrap">Authorized Signatory</td></tr>
              </table>
            </td></tr>

            <tr><td style="padding:18px 28px;border-top:1px solid #f0e6dc;background:#fffcf9">
              <div style="font-size:12px;color:#8a8f9a;line-height:1.6">
                ${escapeHtml(bizName)} · Berhampore, West Bengal<br/>
                <a href="${escapeHtml(site)}" style="color:#d9542f;text-decoration:none">${escapeHtml(site)}</a>
              </div>
              <div style="font-size:11px;color:#b6bac3;line-height:1.6;margin-top:8px">
                A printable PDF copy is attached. Questions about this invoice? Just reply to this email.
              </div>
            </td></tr>

          </table>
        </td></tr>
      </table>
    </body></html>`;

    /* plain-text mirror for clients that block HTML */
    const text =
      (message ? message + "\n\n" : "") +
      `INVOICE ${str(inv.invNo)}\nDate: ${fmtDate(str(inv.date))}\n\n` +
      `Bill to: ${str(client.name) || "—"}\n\n` +
      lines
        .map((it, i) => `${i + 1}. ${str(it.desc) || "—"} — ${num(it.qty)} x ${rupee(num(it.rate))} = ${rupee(num(it.qty) * num(it.rate))}`)
        .join("\n") +
      `\n\nSubtotal: ${rupee(subtotal)}` +
      (discountAmt > 0 ? `\nDiscount: -${rupee(discountAmt)}` : "") +
      (taxPct > 0 ? `\nGST (${taxPct}%): ${rupee(taxAmt)}` : "") +
      `\nTOTAL: ${rupee(total)}\n\n` +
      (str(inv.notes) ? `Notes: ${str(inv.notes)}\n` : "") +
      (str(inv.warranty) ? `Warranty: ${str(inv.warranty)}\n` : "") +
      `\nA printable PDF copy is attached to this email.\n` +
      `\n${bizName} · Berhampore, West Bengal\n${site}`;

    /* Build a real PDF so the client gets a file they can save, print or
       forward to their accountant — the inline HTML above is for reading,
       the attachment is the document of record. */
    const discountLabel = `Discount${inv.discType === "percent" ? ` (${discVal}%)` : ""}`;
    const pdf = await buildInvoicePdf({
      invNo: str(inv.invNo),
      date: fmtDate(str(inv.date)),
      biz,
      client,
      lines: lines.map((it) => ({
        desc: str(it.desc),
        qty: num(it.qty),
        rate: num(it.rate),
      })),
      subtotal,
      discountAmt,
      discountLabel,
      taxAmt,
      taxLabel: `GST (${taxPct}%)`,
      total,
      notes: str(inv.notes),
      warranty: str(inv.warranty),
      siteUrl: site,
    });

    if (!invoiceLogoPath) {
      console.warn(
        "ℹ️  invoice logo not found — set INVOICE_LOGO in .env, or copy " +
        "abhijit_art_logo.png into backend/assets/. Falling back to text.",
      );
    }

    if (!pdfHasRupeeGlyph) {
      console.warn(
        "ℹ️  invoice PDF is using \"Rs.\" — drop NotoSans-Regular.ttf + NotoSans-Bold.ttf " +
        "into backend/assets/ to print the ₹ glyph instead.",
      );
    }

    /* filename the client sees when they save it */
    const safeNo = str(inv.invNo).replace(/[^\w.-]+/g, "-") || "invoice";

    const info = (await transporter.sendMail({
      from: mailFrom(),
      to,
      replyTo: str(biz.email) || process.env.SMTP_USER || undefined,
      subject,
      html,
      text,
      attachments: [
        {
          filename: `Invoice-${safeNo}.pdf`,
          content: pdf,
          contentType: "application/pdf",
        },
        /* The logo travels with the message so it shows even when the client
           blocks remote images. contentDisposition MUST be "inline": a cid
           alone only makes the part referenceable, and nodemailer's default
           disposition is "attachment" — which made Gmail list logo.png as a
           second attachment next to the PDF. */
        ...(invoiceLogoPath
          ? [{
              filename: "logo.png",
              path: invoiceLogoPath,
              cid: "aa-logo",
              contentDisposition: "inline" as const,
              contentType: "image/png",
            }]
          : []),
      ],
    })) as { accepted?: (string | { address: string })[]; rejected?: (string | { address: string })[]; messageId?: string; response?: string };

    const addr = (a: string | { address: string }) => (typeof a === "string" ? a : a.address);
    const rejected = (info.rejected || []).some((a) => addr(a).toLowerCase() === to);
    if (rejected) {
      console.error(`🧾 invoice REJECTED  ${to} — ${info.response || "recipient refused"}`);
      return res.status(502).json({ message: info.response || "The mail server refused that address." });
    }

    console.log(
      `🧾 invoice ${str(inv.invNo)} sent  ${to}  pdf=${(pdf.length / 1024).toFixed(0)}kb  ` +
      `id=${info.messageId || "?"}  ${info.response || ""}`,
    );

    /* audit: who emailed which invoice, to whom */
    await logAudit({
      req, action: "invoice.email", entityRef: str(inv.invNo),
      summary: `Emailed invoice ${str(inv.invNo) || "(no number)"} to ${to}`,
      detail: { to, total },
    });

    res.json({ ok: true, messageId: info.messageId, total, pdfBytes: pdf.length });
  } catch (err) {
    console.error("Invoice email failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't send the invoice." });
  }
});

/* ═══════════════════════ SAVE / STORE INVOICE ═══════════════════════
   POST /api/invoices
     { invNo, date, biz, client, items, discType, discVal, taxPct, notes,
       warranty, paidAmount, source, paymentMethod }

   Persists the bill into the Invoices history. Called automatically when the
   admin downloads the PDF or emails it. Keyed on invoiceNo. Totals recomputed
   server-side.

   Payments are a LEDGER now: on the FIRST create, an advance (paidAmount > 0)
   becomes the invoice's first Payment row, tagged with paymentMethod (cash|
   online) from the Billing toggle. A re-save (Download-then-Email, re-download)
   NEVER touches payments — it only refreshes the bill's content — so an advance
   is recorded exactly once. paidAmount + status are always derived from the
   ledger via recomputeInvoice. source = online|offline (defaults offline, kept
   on re-save unless a new one is sent).
   Not PIN-gated (staff create bills freely) but the first create is audited.
   ─────────────────────────────────────────────────────────── */
router.post("/", async (req: Request, res: Response) => {
  try {
    const inv = (req.body || {}) as {
      invNo?: string; date?: string; biz?: Party; client?: Party;
      items?: Line[]; discType?: string; discVal?: unknown; taxPct?: unknown;
      notes?: string; warranty?: string; paidAmount?: unknown; source?: unknown;
      paymentMethod?: unknown;
    };

    const invoiceNo = str(inv.invNo);
    if (!invoiceNo) return res.status(400).json({ message: "Invoice number is required." });

    const biz: Party = inv.biz || {};
    const client: Party = inv.client || {};

    const lines = (Array.isArray(inv.items) ? inv.items : []).filter(
      (it) => str(it.desc) || num(it.rate) > 0,
    );
    if (!lines.length) return res.status(400).json({ message: "Add at least one line item before saving." });

    const { subtotal, discVal, discountAmt, taxPct, taxAmt, total } = computeTotals(
      lines, inv.discType, inv.discVal, inv.taxPct,
    );

    const when = new Date(str(inv.date));
    const date = isNaN(when.getTime()) ? new Date() : when;

    const createdById = (req as any).user?.id ?? null;

    const existing = await prisma.invoice.findUnique({ where: { invoiceNo } });
    const source = asSource(inv.source, existing?.source ?? "offline");

    /* the bill's content — NOT paidAmount / status (the ledger owns those) */
    const content = {
      date,
      clientName: str(client.name) || "—",
      clientPhone: str(client.phone) || null,
      clientEmail: str(client.email) || null,
      clientGstin: str(client.gstin) || null,
      clientAddr: str(client.address) || null,
      source,
      business: {
        name: str(biz.name),
        address: str(biz.address),
        phone: str(biz.phone),
        email: str(biz.email),
        gstin: str(biz.gstin),
        pan: str(biz.pan),
      },
      items: lines.map((it) => ({ desc: str(it.desc), qty: num(it.qty), rate: num(it.rate) })),
      discType: (inv.discType === "percent" ? "percent" : "amount") as "amount" | "percent",
      discVal,
      taxPct,
      subtotal,
      discountAmt,
      taxAmt,
      total,
      notes: str(inv.notes) || null,
      warranty: str(inv.warranty) || null,
    };

    if (existing) {
      /* re-save: refresh content, leave the ledger alone, re-derive status */
      await prisma.invoice.update({ where: { invoiceNo }, data: content });
      const synced = await recomputeInvoice(existing.id, { reactivate: false });
      return res.status(200).json(synced);
    }

    /* first create: make the invoice, then log the advance (if any) as the
       first payment, then derive paidAmount/status from the ledger */
    const created = await prisma.invoice.create({ data: { invoiceNo, ...content, createdById } });

    const advance = clamp(num(inv.paidAmount), 0, total);
    if (advance > 0.005) {
      await prisma.payment.create({
        data: {
          invoiceId: created.id,
          amount: advance,
          method: asMethod(inv.paymentMethod, "cash"),
          note: "Advance at billing",
          createdById,
        },
      });
    }

    const synced = await recomputeInvoice(created.id, { reactivate: false });

    await logAudit({
      req, action: "invoice.create", entityId: created.id, entityRef: invoiceNo,
      summary: `Created invoice ${invoiceNo} for ${content.clientName} — ${rupee(total)}` +
        (advance > 0 ? ` (advance ${rupee(advance)} ${asMethod(inv.paymentMethod, "cash")})` : ""),
      detail: { total, advance, method: advance > 0 ? asMethod(inv.paymentMethod, "cash") : null },
    });

    res.status(201).json(synced);
  } catch (err) {
    console.error("Invoice save failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't save the invoice." });
  }
});

/* GET /api/invoices — full records + payment history, newest first.
   Each carries a signed pdfUrl (derived from this request's host, or
   PUBLIC_API_URL if set; null only without a signing secret). */
router.get("/", async (req: Request, res: Response) => {
  try {
    const invoices = await prisma.invoice.findMany({ orderBy: { createdAt: "desc" }, include: withPayments });
    res.json(invoices.map((inv) => ({ ...inv, pdfUrl: invoicePdfUrl(req, inv.id) })));
  } catch (err) {
    console.error("Invoice list failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't load invoices." });
  }
});

/* GET /api/invoices/:id — one saved bill + its payment history (+ signed pdfUrl) */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = str(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id }, include: withPayments });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });
    res.json({ ...invoice, pdfUrl: invoicePdfUrl(req, invoice.id) });
  } catch (err) {
    console.error("Invoice fetch failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't load the invoice." });
  }
});

/* ═══════════════════════ PAYMENT REMINDER ═══════════════════════
   POST /api/invoices/:id/remind
     { channel: "email" | "whatsapp", subject?, message? }

   Nudges a client about an unpaid / partial balance. Two channels:
     • email    — sends a premium branded reminder built here (inline CID logo,
                  an "amount due" card, refined footer) WITH the invoice PDF
                  attached (rebuilt from the stored snapshot, Paid/Balance
                  included); needs a client email on file
     • whatsapp — the browser already opened wa.me with the message (and a
                  signed PDF link); the server just records that a reminder
                  went out

   `message` is a short personal NOTE (no figures) — the amount card carries the
   numbers. Both channels stamp lastRemindedAt + bump reminderCount, write an
   audit line, and return the updated invoice. Read-only on money (never touches
   the ledger), so it is NOT PIN-gated. Paid / cancelled / zero-balance bills are
   refused.
   ─────────────────────────────────────────────────────────── */
router.post("/:id/remind", async (req: Request, res: Response) => {
  try {
    const id = str(req.params.id);
    const channel: "email" | "whatsapp" = req.body?.channel === "whatsapp" ? "whatsapp" : "email";

    const invoice = await prisma.invoice.findUnique({ where: { id }, include: withPayments });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });

    if (invoice.status === "paid") {
      return res.status(400).json({ message: "This invoice is already fully paid." });
    }
    if (invoice.status === "cancelled") {
      return res.status(400).json({ message: "This invoice is cancelled — reactivate it before reminding." });
    }

    const total = Number(invoice.total);
    const paid = Number(invoice.paidAmount);
    const balance = round2(Math.max(total - paid, 0));
    if (balance <= 0.005) {
      return res.status(400).json({ message: "Nothing due on this invoice." });
    }

    const subject = str(req.body?.subject) || `Payment reminder — invoice ${invoice.invoiceNo}`;
    const note = str(req.body?.message) || defaultReminderNote(invoice);

    if (channel === "email") {
      const to = str(invoice.clientEmail).toLowerCase();
      if (!to) return res.status(400).json({ message: "No email on file for this client — use WhatsApp instead." });
      if (!isEmail(to)) return res.status(400).json({ message: "The client's email on file doesn't look right." });

      const biz = (invoice.business || {}) as Party;
      const bizName = str(biz.name) || "Abhijit Art";
      const bizAddress = str(biz.address);
      const bizPhone = str(biz.phone);
      const bizEmail = str(biz.email);
      const dateStr = fmtDate(invoice.date.toISOString());
      const safeNo = invoice.invoiceNo.replace(/[^\w.-]+/g, "-") || "invoice";

      const site = siteUrl();
      const showSite = /^https?:\/\//i.test(site) && !/localhost|127\.0\.0\.1/i.test(site);

      const noteHtml = note
        .split(/\n\s*\n/)
        .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#2a231d">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
        .join("");

      const logoHtml = reminderLogoPath
        ? `<img src="cid:aa-logo" alt="${escapeHtml(bizName)}" height="46" style="height:46px;width:auto;display:block;margin:0 auto;border:0" />`
        : `<div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:.3px">${escapeHtml(bizName)}</div>
           <div style="font-size:10.5px;letter-spacing:3px;text-transform:uppercase;color:#c2974a;font-weight:700;margin-top:6px">Printing &amp; Design Studio</div>`;

      const html = `<!doctype html><html><body style="margin:0;padding:0;background:#efe9dc">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efe9dc;padding:30px 12px">
          <tr><td align="center">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fffdf8;border:1px solid #e7ddcb;font-family:'DM Sans',Arial,Helvetica,sans-serif">

              <tr><td style="background:#2a231d;background:linear-gradient(135deg,#2a231d 0%,#3b2f25 100%);padding:26px 28px;text-align:center">
                ${logoHtml}
              </td></tr>
              <tr><td style="height:4px;line-height:4px;font-size:0;background:#d9542f;background:linear-gradient(90deg,#d9542f 0%,#c2974a 100%)">&nbsp;</td></tr>

              <tr><td style="padding:30px 30px 0">
                <div style="font-size:11px;letter-spacing:2.4px;text-transform:uppercase;color:#c2974a;font-weight:700">Payment reminder</div>
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:21px;font-weight:700;color:#2a231d;margin-top:6px;letter-spacing:-.2px">Invoice ${escapeHtml(invoice.invoiceNo)}</div>
              </td></tr>

              <tr><td style="padding:16px 30px 0">${noteHtml}</td></tr>

              <tr><td style="padding:6px 30px 0">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ecdcc4;border-left:4px solid #d9542f;background:#faf5ea">
                  <tr><td style="padding:16px 18px">
                    <div style="font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:#9a8f81;font-weight:700">Amount due</div>
                    <div style="font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:700;color:#d9542f;line-height:1.1;margin-top:5px">${rupee(balance)}</div>
                    <div style="font-size:12.5px;color:#6f6357;margin-top:9px">Invoice total <b style="color:#2a231d">${rupee(total)}</b> &nbsp;&middot;&nbsp; Received <b style="color:#2a231d">${rupee(paid)}</b></div>
                    <div style="font-size:12px;color:#9a8f81;margin-top:3px">Invoice ${escapeHtml(invoice.invoiceNo)} &nbsp;&middot;&nbsp; ${dateStr}</div>
                  </td></tr>
                </table>
              </td></tr>

              <tr><td style="padding:16px 30px 0">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f1ea;border:1px solid #e7ddcb">
                  <tr>
                    <td width="42" style="padding:11px 0 11px 14px;font-size:18px;vertical-align:middle">📎</td>
                    <td style="padding:11px 14px 11px 8px;font-size:13px;color:#2a231d;vertical-align:middle">The full invoice is attached as a PDF (<b>Invoice-${escapeHtml(safeNo)}.pdf</b>) for your records.</td>
                  </tr>
                </table>
              </td></tr>

              <tr><td style="padding:26px 30px 28px">
                <div style="border-top:1px solid #ecdcc4;padding-top:18px;text-align:center">
                  <div style="font-family:Georgia,'Times New Roman',serif;font-size:16px;font-weight:700;color:#2a231d">${escapeHtml(bizName)}</div>
                  <div style="font-size:12px;color:#9a8f81;margin-top:3px">${escapeLines(bizAddress) || "Berhampore, West Bengal"}</div>
                  <div style="font-size:12px;color:#6f6357;margin-top:8px">${bizPhone ? `&#9742; ${escapeHtml(bizPhone)}` : ""}${bizPhone && bizEmail ? " &nbsp;&middot;&nbsp; " : ""}${bizEmail ? `&#9993; ${escapeHtml(bizEmail)}` : ""}</div>
                  ${showSite ? `<div style="margin-top:9px"><a href="${escapeHtml(site)}" style="color:#d9542f;text-decoration:none;font-size:12px;font-weight:600">${escapeHtml(site.replace(/^https?:\/\//i, ""))}</a></div>` : ""}
                </div>
                <div style="font-size:11px;color:#b6ac9c;line-height:1.6;margin-top:14px;text-align:center">You're receiving this because you have an outstanding balance with ${escapeHtml(bizName)}. Reply to this email with any questions.</div>
              </td></tr>

            </table>
          </td></tr>
        </table>
      </body></html>`;

      const text =
        note + "\n\n" +
        `AMOUNT DUE: ${rupee(balance)}\n` +
        `Invoice total: ${rupee(total)}  ·  Received: ${rupee(paid)}\n` +
        `Invoice ${invoice.invoiceNo}  ·  ${dateStr}\n\n` +
        `The full invoice is attached as a PDF.\n\n` +
        `${bizName}\n${bizAddress || "Berhampore, West Bengal"}` +
        (bizPhone ? `\n${bizPhone}` : "") +
        (bizEmail ? `\n${bizEmail}` : "");

      /* attach the invoice PDF, rebuilt from the stored snapshot — non-fatal:
         if the PDF can't be built, the reminder still goes out */
      let pdf: Buffer | null = null;
      try {
        pdf = await buildInvoicePdfFromRecord(invoice);
      } catch (e) {
        console.warn("🔔 reminder PDF build failed — sending without attachment:", (e as Error).message);
      }

      const attachments: any[] = [];
      if (pdf) attachments.push({ filename: `Invoice-${safeNo}.pdf`, content: pdf, contentType: "application/pdf" });
      if (reminderLogoPath) {
        attachments.push({
          filename: "logo.png",
          path: reminderLogoPath,
          cid: "aa-logo",
          contentDisposition: "inline" as const,
          contentType: "image/png",
        });
      }

      const info = (await transporter.sendMail({
        from: mailFrom(),
        to,
        replyTo: bizEmail || process.env.SMTP_USER || undefined,
        subject,
        html,
        text,
        attachments,
      })) as { rejected?: (string | { address: string })[]; messageId?: string; response?: string };

      const addr = (a: string | { address: string }) => (typeof a === "string" ? a : a.address);
      if ((info.rejected || []).some((a) => addr(a).toLowerCase() === to)) {
        console.error(`🔔 reminder REJECTED  ${to} — ${info.response || "recipient refused"}`);
        return res.status(502).json({ message: info.response || "The mail server refused that address." });
      }
      console.log(
        `🔔 reminder ${invoice.invoiceNo} emailed  ${to}  ` +
        `pdf=${pdf ? (pdf.length / 1024).toFixed(0) + "kb" : "none"}  id=${info.messageId || "?"}  ${info.response || ""}`,
      );
    }

    /* stamp the touch — both channels */
    const updated = await prisma.invoice.update({
      where: { id },
      data: { lastRemindedAt: new Date(), reminderCount: { increment: 1 } },
      include: withPayments,
    });

    await logAudit({
      req, action: "invoice.remind", entityId: invoice.id, entityRef: invoice.invoiceNo,
      summary: `Reminder sent via ${channel} for ${invoice.invoiceNo} — balance ${rupee(balance)}`,
      detail: {
        channel,
        balance,
        to: channel === "email" ? invoice.clientEmail : invoice.clientPhone,
        reminderCount: updated.reminderCount,
      },
    });

    res.json({ ...updated, pdfUrl: invoicePdfUrl(req, updated.id) });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Invoice not found." });
    }
    console.error("Invoice reminder failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't send the reminder." });
  }
});

/* ═══════════════════════ EDIT INVOICE CONTENTS ═══════════════════════
   PATCH /api/invoices/:id/edit
     { date?, client, items, discType, discVal, taxPct, notes, warranty,
       source, pin }

   Edits a saved bill in place (client details, line items, discount/GST,
   notes, source) so a recurring customer's running bill can grow instead of
   spawning ten separate invoices. 🔒 PIN-gated + audited. Payment method is
   NOT here any more — it lives on each payment.

   LOCKED: only unpaid / partial bills are editable — paid and cancelled return
   403. invoiceNo + the business snapshot are immutable. Totals are recomputed
   server-side; the ledger is untouched, and paidAmount / status are re-derived
   against the new total (so adding a line to a partial bill keeps the payments
   and just grows the balance due).
   ─────────────────────────────────────────────────────────── */
router.patch("/:id/edit", async (req: Request, res: Response) => {
  try {
    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ message: pe.message });

    const id = str(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });

    if (invoice.status === "paid") {
      return res.status(403).json({ message: "This invoice is paid and locked. Delete and recreate it to make a correction." });
    }
    if (invoice.status === "cancelled") {
      return res.status(403).json({ message: "This invoice is cancelled. Reactivate it (record a payment) before editing." });
    }

    const body = (req.body || {}) as {
      date?: string; client?: Party; items?: Line[];
      discType?: string; discVal?: unknown; taxPct?: unknown;
      notes?: string; warranty?: string; source?: unknown;
    };

    const client: Party = body.client || {};

    const lines = (Array.isArray(body.items) ? body.items : []).filter(
      (it) => str(it.desc) || num(it.rate) > 0,
    );
    if (!lines.length) return res.status(400).json({ message: "Add at least one line item before saving." });

    const { subtotal, discVal, discountAmt, taxPct, taxAmt, total } = computeTotals(
      lines, body.discType, body.discVal, body.taxPct,
    );

    const whenRaw = str(body.date);
    const when = new Date(whenRaw);
    const date = whenRaw && !isNaN(when.getTime()) ? when : invoice.date;

    const source = asSource(body.source, invoice.source);

    await prisma.invoice.update({
      where: { id },
      data: {
        date,
        clientName: str(client.name) || "—",
        clientPhone: str(client.phone) || null,
        clientEmail: str(client.email) || null,
        clientGstin: str(client.gstin) || null,
        clientAddr: str(client.address) || null,
        source,
        items: lines.map((it) => ({ desc: str(it.desc), qty: num(it.qty), rate: num(it.rate) })),
        discType: (body.discType === "percent" ? "percent" : "amount") as "amount" | "percent",
        discVal,
        taxPct,
        subtotal,
        discountAmt,
        taxAmt,
        total,
        notes: str(body.notes) || null,
        warranty: str(body.warranty) || null,
      },
    });

    /* new total → re-derive paidAmount + status from the untouched ledger */
    const updated = await recomputeInvoice(id, { reactivate: false });
    const paidAmount = updated ? Number(updated.paidAmount) : 0;

    await logAudit({
      req, action: "invoice.edit", entityId: invoice.id, entityRef: invoice.invoiceNo,
      summary: `Edited invoice ${invoice.invoiceNo} for ${str(client.name) || "—"} — now ${rupee(total)}` +
        (paidAmount > 0 ? ` (paid ${rupee(paidAmount)}, balance ${rupee(Math.max(total - paidAmount, 0))})` : ""),
      detail: {
        before: { total: Number(invoice.total), status: invoice.status, items: invoice.items },
        after: { total, itemCount: lines.length },
        paidAmount,
      },
    });

    res.json({ ...updated, pdfUrl: updated ? invoicePdfUrl(req, updated.id) : null });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Invoice not found." });
    }
    console.error("Invoice edit failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't save the changes." });
  }
});

/* ═══════════════════════ RECORD A PAYMENT ═══════════════════════
   POST /api/invoices/:id/payments
     { amount, method, note?, pin }

   Appends one payment to the invoice's ledger — how much, and cash|online.
   🔒 PIN-gated + audited. The amount is clamped to the outstanding balance
   (you can't overpay), recording money un-cancels a cancelled bill, and
   paidAmount / status are re-derived from the whole ledger.
   ─────────────────────────────────────────────────────────── */
router.post("/:id/payments", async (req: Request, res: Response) => {
  try {
    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ message: pe.message });

    const id = str(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id }, include: withPayments });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });

    const total = Number(invoice.total);
    const currentPaid = clamp(round2(invoice.payments.reduce((s, p) => s + Number(p.amount), 0)), 0, total);
    const remaining = round2(Math.max(total - currentPaid, 0));
    if (remaining <= 0.005) {
      return res.status(400).json({ message: "This invoice is already fully paid." });
    }

    const amount = clamp(round2(num(req.body.amount)), 0, remaining);
    if (amount <= 0.005) {
      return res.status(400).json({ message: "Enter a payment amount greater than zero." });
    }

    const method = asMethod(req.body.method, "cash");
    const note = str(req.body.note);
    const createdById = (req as any).user?.id ?? null;

    await prisma.payment.create({
      data: { invoiceId: id, amount, method, note: note || null ? note : "", createdById },
    });

    /* recording money reactivates a cancelled bill */
    const updated = await recomputeInvoice(id, { reactivate: true });
    const balance = updated ? round2(Math.max(total - Number(updated.paidAmount), 0)) : 0;

    await logAudit({
      req, action: "invoice.payment", entityId: invoice.id, entityRef: invoice.invoiceNo,
      summary: `Payment on ${invoice.invoiceNo}: ${rupee(amount)} ${method} (balance ${rupee(balance)})`,
      detail: { amount, method, note, balanceDue: balance, status: updated?.status },
    });

    res.status(201).json({ ...updated, pdfUrl: updated ? invoicePdfUrl(req, updated.id) : null });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Invoice not found." });
    }
    console.error("Invoice payment failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't record the payment." });
  }
});

/* DELETE /api/invoices/:id/payments/:paymentId — remove a wrong ledger entry.
   🔒 PIN-gated + audited. paidAmount / status are re-derived afterwards.
   Send the PIN in the body: api.delete(url, { data: { pin } }). */
router.delete("/:id/payments/:paymentId", async (req: Request, res: Response) => {
  try {
    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ message: pe.message });

    const id = str(req.params.id);
    const paymentId = str(req.params.paymentId);

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.invoiceId !== id) {
      return res.status(404).json({ message: "Payment not found on this invoice." });
    }

    await prisma.payment.delete({ where: { id: paymentId } });

    const updated = await recomputeInvoice(id, { reactivate: false });

    await logAudit({
      req, action: "invoice.payment.delete", entityId: id, entityRef: updated?.invoiceNo ?? id,
      summary: `Removed a ${rupee(Number(payment.amount))} ${payment.method} payment from ${updated?.invoiceNo ?? "invoice"}`,
      detail: { amount: Number(payment.amount), method: payment.method, status: updated?.status },
    });

    res.json({ ...updated, pdfUrl: updated ? invoicePdfUrl(req, updated.id) : null });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Payment not found." });
    }
    console.error("Invoice payment delete failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't remove the payment." });
  }
});

/* PATCH /api/invoices/:id/status — cancel or reactivate a bill.
   🔒 PIN-gated. "cancelled" voids the bill (its payments stay recorded);
   any other value reactivates it and re-derives the status from the ledger.
   The paid/unpaid state itself is NOT set here — it follows the payments. */
const STATUSES = ["unpaid", "partial", "paid", "cancelled"] as const;
router.patch("/:id/status", async (req: Request, res: Response) => {
  try {
    const status = str(req.body.status);
    if (!(STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ message: "Status must be unpaid, partial, paid or cancelled." });
    }

    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ message: pe.message });

    const id = str(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });

    if (status === "cancelled") {
      const updated = await prisma.invoice.update({
        where: { id },
        data: { status: "cancelled" },
        include: withPayments,
      });
      await logAudit({
        req, action: "invoice.cancel", entityId: invoice.id, entityRef: invoice.invoiceNo,
        summary: `Cancelled invoice ${invoice.invoiceNo}`,
        detail: { from: invoice.status, to: "cancelled" },
      });
      return res.json({ ...updated, pdfUrl: invoicePdfUrl(req, updated.id) });
    }

    /* anything non-cancelled = reactivate → status follows the ledger */
    const updated = await recomputeInvoice(id, { reactivate: true });
    await logAudit({
      req, action: "invoice.status", entityId: invoice.id, entityRef: invoice.invoiceNo,
      summary: `Reactivated invoice ${invoice.invoiceNo} → ${updated?.status}`,
      detail: { from: invoice.status, to: updated?.status },
    });
    res.json({ ...updated, pdfUrl: updated ? invoicePdfUrl(req, updated.id) : null });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Invoice not found." });
    }
    console.error("Invoice status update failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't update the invoice." });
  }
});

/* DELETE /api/invoices/:id — remove a saved bill (and its payments, via the
   schema's onDelete: Cascade). 🔒 PIN-gated + audited.
   Send the PIN in the request body: api.delete(url, { data: { pin } }). */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ message: pe.message });

    const id = str(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });

    await prisma.invoice.delete({ where: { id } });

    await logAudit({
      req, action: "invoice.delete", entityId: invoice.id, entityRef: invoice.invoiceNo,
      summary: `Deleted invoice ${invoice.invoiceNo} (${invoice.clientName}, ${rupee(Number(invoice.total))})`,
      detail: { total: Number(invoice.total), paidAmount: Number(invoice.paidAmount), status: invoice.status },
    });

    res.json({ ok: true });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Invoice not found." });
    }
    console.error("Invoice delete failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't delete the invoice." });
  }
});

export default router;