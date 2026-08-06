// backend/src/routes/invoiceRoutes.ts
import { Router, type Request, type Response } from "express";
import { protect, adminOnly } from "../middleware/auth.js";
import { transporter, mailFrom, siteUrl } from "../config/mailer.js";
import { buildInvoicePdf, pdfHasRupeeGlyph, invoiceLogoPath } from "../utils/invoicePdf.js";
import { prisma } from "../config/prisma.js";
import { isPinSet, verifyPin, logAudit } from "../utils/security.js";

const router = Router();

/* admin-only: only staff email or store invoices */
router.use(protect, adminOnly);

const str = (v: unknown) => String(v ?? "").trim();
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
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

/* PIN gate for sensitive actions (delete / cancel / payment). Returns an error
   to send back, or null if the PIN checks out. Reads the PIN from req.body.pin. */
async function pinError(req: Request): Promise<{ code: number; message: string } | null> {
  if (!(await isPinSet())) {
    return { code: 409, message: "No security PIN is set yet. Set one in Settings before deleting, cancelling or changing a payment." };
  }
  if (!(await verifyPin(str(req.body?.pin)))) {
    return { code: 403, message: "Incorrect security PIN." };
  }
  return null;
}

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
       warranty, paidAmount }

   Persists the bill into the Invoices history. Called automatically when the
   admin downloads the PDF or emails it. Keyed on invoiceNo. Totals recomputed
   server-side. paidAmount = the advance received; on a re-save it must NOT wipe
   a payment logged later, so the incoming advance only wins when set (> 0).
   Status derived from paid-vs-total; a cancelled invoice stays cancelled.
   Not PIN-gated (staff create bills freely) but the first create is audited.
   ─────────────────────────────────────────────────────────── */
router.post("/", async (req: Request, res: Response) => {
  try {
    const inv = (req.body || {}) as {
      invNo?: string; date?: string; biz?: Party; client?: Party;
      items?: Line[]; discType?: string; discVal?: unknown; taxPct?: unknown;
      notes?: string; warranty?: string; paidAmount?: unknown;
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

    /* re-save of an existing number? keep any payment already recorded */
    const existing = await prisma.invoice.findUnique({ where: { invoiceNo } });
    const incomingPaid = clamp(num(inv.paidAmount), 0, total);
    const paidAmount = existing
      ? incomingPaid > 0
        ? incomingPaid
        : clamp(Number(existing.paidAmount), 0, total)
      : incomingPaid;
    const status = existing?.status === "cancelled" ? "cancelled" : deriveStatus(paidAmount, total);

    const data = {
      date,
      clientName: str(client.name) || "—",
      clientPhone: str(client.phone) || null,
      clientEmail: str(client.email) || null,
      clientGstin: str(client.gstin) || null,
      clientAddr: str(client.address) || null,
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
      paidAmount,
      status: status as "unpaid" | "partial" | "paid" | "cancelled",
      notes: str(inv.notes) || null,
      warranty: str(inv.warranty) || null,
    };

    const saved = existing
      ? await prisma.invoice.update({ where: { invoiceNo }, data })
      : await prisma.invoice.create({ data: { invoiceNo, ...data, createdById } });

    /* audit only the first time an invoice number is created — re-saves on
       every Download/Send would otherwise flood the log */
    if (!existing) {
      await logAudit({
        req, action: "invoice.create", entityId: saved.id, entityRef: invoiceNo,
        summary: `Created invoice ${invoiceNo} for ${data.clientName} — ${rupee(total)}` +
          (paidAmount > 0 ? ` (advance ${rupee(paidAmount)})` : ""),
        detail: { total, paidAmount, status },
      });
    }

    res.status(201).json(saved);
  } catch (err) {
    console.error("Invoice save failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't save the invoice." });
  }
});

/* GET /api/invoices — full records, newest first (history list + re-download) */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const invoices = await prisma.invoice.findMany({ orderBy: { createdAt: "desc" } });
    res.json(invoices);
  } catch (err) {
    console.error("Invoice list failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't load invoices." });
  }
});

/* GET /api/invoices/:id — one saved bill */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = str(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });
    res.json(invoice);
  } catch (err) {
    console.error("Invoice fetch failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't load the invoice." });
  }
});

/* PATCH /api/invoices/:id/payment — record / update how much has been received.
   🔒 PIN-gated. Clamps to [0, total], derives the status, un-cancels, audits. */
router.patch("/:id/payment", async (req: Request, res: Response) => {
  try {
    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ message: pe.message });

    const id = str(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });

    const total = Number(invoice.total);
    const prev = Number(invoice.paidAmount);
    const paidAmount = clamp(num(req.body.paidAmount), 0, total);
    const status = deriveStatus(paidAmount, total);

    const updated = await prisma.invoice.update({
      where: { id },
      data: { paidAmount, status },
    });

    await logAudit({
      req, action: "invoice.payment", entityId: invoice.id, entityRef: invoice.invoiceNo,
      summary: `Payment on ${invoice.invoiceNo}: ${rupee(prev)} → ${rupee(paidAmount)} (balance ${rupee(Math.max(total - paidAmount, 0))})`,
      detail: { previous: prev, received: paidAmount, total, balanceDue: Math.max(total - paidAmount, 0), status },
    });

    res.json(updated);
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Invoice not found." });
    }
    console.error("Invoice payment update failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't update the payment." });
  }
});

/* PATCH /api/invoices/:id/status — unpaid / partial / paid / cancelled.
   🔒 PIN-gated (all status changes alter money/state).
     paid   → received = total      unpaid → received = 0
     cancelled leaves the received amount untouched.
   "partial" isn't settable directly — it comes from an amount (/payment). */
const STATUSES = ["unpaid", "partial", "paid", "cancelled"] as const;
router.patch("/:id/status", async (req: Request, res: Response) => {
  try {
    const status = str(req.body.status);
    if (!(STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ message: "Status must be unpaid, partial, paid or cancelled." });
    }
    if (status === "partial") {
      return res.status(400).json({ message: "To set a partial payment, record the received amount via the payment action." });
    }

    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ message: pe.message });

    const id = str(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });

    const total = Number(invoice.total);
    const data: { status: (typeof STATUSES)[number]; paidAmount?: number } = {
      status: status as (typeof STATUSES)[number],
    };
    if (status === "paid") data.paidAmount = total;
    else if (status === "unpaid") data.paidAmount = 0;

    const updated = await prisma.invoice.update({ where: { id }, data });

    const isCancel = status === "cancelled";
    await logAudit({
      req, action: isCancel ? "invoice.cancel" : "invoice.status", entityId: invoice.id, entityRef: invoice.invoiceNo,
      summary: isCancel ? `Cancelled invoice ${invoice.invoiceNo}` : `Marked invoice ${invoice.invoiceNo} ${status}`,
      detail: { from: invoice.status, to: status },
    });

    res.json(updated);
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") {
      return res.status(404).json({ message: "Invoice not found." });
    }
    console.error("Invoice status update failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't update the invoice." });
  }
});

/* DELETE /api/invoices/:id — remove a saved bill. 🔒 PIN-gated + audited.
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