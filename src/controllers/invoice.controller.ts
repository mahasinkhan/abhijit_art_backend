// backend/src/controllers/invoice.controller.ts
// ─────────────────────────────────────────────────────────────────────────────
// Request handlers for the invoice API. Pure domain logic (totals, stock, PDF,
// signed URLs, recompute) lives in ../services/invoice.service.ts; this layer
// owns req/res, validation, PIN checks, audit logging and response shaping.
// invoiceRoutes.ts just wires each route to the matching export below.
// ─────────────────────────────────────────────────────────────────────────────
import type { Request, Response } from "express";
import { transporter, mailFrom, siteUrl } from "../config/mailer.js";
import { buildInvoicePdf, pdfHasRupeeGlyph, invoiceLogoPath } from "../utils/invoicePdf.js";
import { prisma } from "../config/prisma.js";
import { isPinSet, verifyPin, logAudit } from "../utils/security.js";
import {
    str, num, round2, clamp, isEmail, escapeHtml, escapeLines, rupee, fmtDate,
  asSource, asMethod, mapLine, countLinked, computeTotals, upsertCustomer,
  defaultReminderNote, reminderLogoPath, withPayments, recomputeInvoice,
  applyStockSafely, reverseStockSafely, buildInvoicePdfFromRecord,
  pdfSigValid, invoicePdfUrl,
  type Party, type Line, type InvoiceStockSync,
} from "../services/invoice.service.js";

/* Audits stock activity — including the failures. A silent failure is the one
   thing this must not do, so unresolved lines and thrown errors are logged
   just like successful deductions. */
async function logStockAudit(req: Request, kind: "deduct" | "restock", invoiceNo: string, invoiceId: string, stock?: InvoiceStockSync) {
  if (!stock) return;
  const unresolved = stock.unresolved?.length ?? 0;
  if (!stock.changed && !unresolved && !stock.error) return;

  const verb = kind === "deduct" ? "deducted" : "returned";
  let summary: string;
  if (stock.error) {
    summary = `Stock ${verb === "deducted" ? "deduction" : "return"} FAILED for ${invoiceNo} — ${stock.error}`;
  } else {
    const low = stock.warnings.length;
    summary =
      `Stock ${verb} for ${invoiceNo} — ${stock.movementCount} item(s)` +
      (low ? `, ${low} now low/out` : "") +
      (unresolved ? `, ${unresolved} line(s) UNMATCHED (item deleted — not applied)` : "");
  }

  await logAudit({
    req,
    action: kind === "deduct" ? "invoice.stock.deduct" : "invoice.stock.restock",
    entityId: invoiceId,
    entityRef: invoiceNo,
    summary,
    detail: { items: stock.items, warnings: stock.warnings, unresolved: stock.unresolved, error: stock.error ?? null },
  });
}

async function pinError(req: Request): Promise<{ code: number; message: string } | null> {
  if (!(await isPinSet())) {
    return { code: 409, message: "No security PIN is set yet. Set one in Settings before deleting, cancelling, editing or recording a payment." };
  }
  if (!(await verifyPin(str(req.body?.pin)))) {
    return { code: 403, message: "Incorrect security PIN." };
  }
  return null;
}

/* ── PUBLIC invoice PDF (no auth, HMAC-signed link) ── */
export async function getPublicPdf(req: Request, res: Response) {
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
}

/* ── POST /email — send invoice by email ── */
export async function emailInvoice(req: Request, res: Response) {
  try {
    const to = str(req.body.to).toLowerCase();
    const subject = str(req.body.subject);
    const message = str(req.body.message);
    const inv = (req.body.invoice || {}) as {
      invNo?: string; date?: string; biz?: Party; client?: Party;
      items?: Line[]; discType?: string; discVal?: unknown; taxPct?: unknown;
      notes?: string; warranty?: string; paidAmount?: unknown;
    };

    if (!to) return res.status(400).json({ message: "Recipient email is required." });
    if (!isEmail(to)) return res.status(400).json({ message: "That recipient email doesn't look right." });
    if (!subject) return res.status(400).json({ message: "Subject is required." });

    const biz: Party = inv.biz || {};
    const client: Party = inv.client || {};
    const bizName = str(biz.name) || "Abhijit Art";

    const lines = (Array.isArray(inv.items) ? inv.items : []).filter(
      (it) => str(it.desc) || num(it.rate) > 0,
    );
    if (!lines.length) return res.status(400).json({ message: "Add at least one line item before emailing." });

    const { subtotal, discVal, discountAmt, taxPct, taxAmt, total } = computeTotals(
      lines, inv.discType, inv.discVal, inv.taxPct,
    );

    const paidAmount = clamp(round2(num(req.body.paidAmount ?? inv.paidAmount)), 0, total);
    const balanceDue = round2(Math.max(total - paidAmount, 0));
    const site = siteUrl();

    const rows = lines.map((it, i) => `<tr>
          <td style="padding:9px 8px;border-bottom:1px solid #f4f5f7;font-size:13px;color:#8a8f9a;text-align:center">${i + 1}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #f4f5f7;font-size:13px;color:#1f2430">${escapeHtml(it.desc) || "—"}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #f4f5f7;font-size:13px;color:#1f2430;text-align:right">${num(it.qty)}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #f4f5f7;font-size:13px;color:#1f2430;text-align:right">${rupee(num(it.rate))}</td>
          <td style="padding:9px 8px;border-bottom:1px solid #f4f5f7;font-size:13px;color:#1f2430;text-align:right">${rupee(num(it.qty) * num(it.rate))}</td>
        </tr>`).join("");

    const totalRow = (label: string, value: string, strong = false) => `<tr>
        <td style="padding:${strong ? "12px" : "6px"} 4px 6px;font-size:${strong ? "15px" : "12.5px"};color:${strong ? "#1f2430" : "#8a8f9a"};font-weight:${strong ? 800 : 400};${strong ? "border-top:1px solid #ececf1;" : ""}">${label}</td>
        <td style="padding:${strong ? "12px" : "6px"} 4px 6px;font-size:${strong ? "16px" : "13px"};text-align:right;font-weight:${strong ? 800 : 700};color:${strong ? "#d9542f" : "#1f2430"};${strong ? "border-top:1px solid #ececf1;" : ""}">${value}</td>
      </tr>`;

    const paidRows = paidAmount > 0.005
      ? `<tr>
           <td style="padding:6px 4px;font-size:12.5px;color:#8a8f9a">Paid</td>
           <td style="padding:6px 4px;font-size:13px;text-align:right;font-weight:700;color:#15733f">− ${rupee(paidAmount)}</td>
         </tr>
         <tr>
           <td style="padding:9px 4px 6px;font-size:14px;color:#1f2430;font-weight:800">Balance due</td>
           <td style="padding:9px 4px 6px;font-size:15px;text-align:right;font-weight:800;color:#d9542f">${rupee(balanceDue)}</td>
         </tr>`
      : "";

    const totalsHtml =
      totalRow("Subtotal", rupee(subtotal)) +
      (discountAmt > 0 ? totalRow(`Discount${inv.discType === "percent" ? ` (${discVal}%)` : ""}`, "− " + rupee(discountAmt)) : "") +
      (taxPct > 0 ? totalRow(`GST (${taxPct}%)`, rupee(taxAmt)) : "") +
      totalRow("Total", rupee(total), true) +
      paidRows;

    const messageHtml = message
      ? message.split(/\n\s*\n/).map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#1f2430">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join("")
      : "";

    const notesHtml = str(inv.notes) || str(inv.warranty)
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
              ${invoiceLogoPath
                ? `<img src="cid:aa-logo" alt="${escapeHtml(bizName)}" height="52" style="height:52px;width:auto;display:block;border:0" />`
                : `<div style="font-size:21px;font-weight:800;color:#d9542f;letter-spacing:-0.4px">${escapeHtml(bizName)}</div>`}
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

    const text =
      (message ? message + "\n\n" : "") +
      `INVOICE ${str(inv.invNo)}\nDate: ${fmtDate(str(inv.date))}\n\n` +
      `Bill to: ${str(client.name) || "—"}\n\n` +
      lines.map((it, i) => `${i + 1}. ${str(it.desc) || "—"} — ${num(it.qty)} x ${rupee(num(it.rate))} = ${rupee(num(it.qty) * num(it.rate))}`).join("\n") +
      `\n\nSubtotal: ${rupee(subtotal)}` +
      (discountAmt > 0 ? `\nDiscount: -${rupee(discountAmt)}` : "") +
      (taxPct > 0 ? `\nGST (${taxPct}%): ${rupee(taxAmt)}` : "") +
      `\nTOTAL: ${rupee(total)}` +
      (paidAmount > 0.005 ? `\nPaid: -${rupee(paidAmount)}\nBalance due: ${rupee(balanceDue)}` : "") +
      `\n\n` +
      (str(inv.notes) ? `Notes: ${str(inv.notes)}\n` : "") +
      (str(inv.warranty) ? `Warranty: ${str(inv.warranty)}\n` : "") +
      `\nA printable PDF copy is attached to this email.\n\n${bizName} · Berhampore, West Bengal\n${site}`;

    const discountLabel = `Discount${inv.discType === "percent" ? ` (${discVal}%)` : ""}`;
    const pdf = await buildInvoicePdf({
      invNo: str(inv.invNo), date: fmtDate(str(inv.date)), biz, client,
      lines: lines.map((it) => ({ desc: str(it.desc), qty: num(it.qty), rate: num(it.rate) })),
      subtotal, discountAmt, discountLabel, taxAmt, taxLabel: `GST (${taxPct}%)`,
      total, paidAmount, notes: str(inv.notes), warranty: str(inv.warranty), siteUrl: site,
    });

    if (!invoiceLogoPath) {
      console.warn("ℹ️  invoice logo not found — set INVOICE_LOGO in .env, or copy abhijit_art_logo.png into backend/assets/. Falling back to text.");
    }
    if (!pdfHasRupeeGlyph) {
      console.warn("ℹ️  invoice PDF is using \"Rs.\" — drop NotoSans-Regular.ttf + NotoSans-Bold.ttf into backend/assets/ to print the ₹ glyph instead.");
    }

    const safeNo = str(inv.invNo).replace(/[^\w.-]+/g, "-") || "invoice";

    const info = (await transporter.sendMail({
      from: mailFrom(),
      to,
      replyTo: str(biz.email) || process.env.SMTP_USER || undefined,
      subject,
      html,
      text,
      attachments: [
        { filename: `Invoice-${safeNo}.pdf`, content: pdf, contentType: "application/pdf" },
        ...(invoiceLogoPath ? [{ filename: "logo.png", path: invoiceLogoPath, cid: "aa-logo", contentDisposition: "inline" as const, contentType: "image/png" }] : []),
      ],
    })) as { accepted?: (string | { address: string })[]; rejected?: (string | { address: string })[]; messageId?: string; response?: string };

    const addr = (a: string | { address: string }) => (typeof a === "string" ? a : a.address);
    const rejected = (info.rejected || []).some((a) => addr(a).toLowerCase() === to);
    if (rejected) {
      console.error(`🧾 invoice REJECTED  ${to} — ${info.response || "recipient refused"}`);
      return res.status(502).json({ message: info.response || "The mail server refused that address." });
    }

    console.log(`🧾 invoice ${str(inv.invNo)} sent  ${to}  pdf=${(pdf.length / 1024).toFixed(0)}kb  id=${info.messageId || "?"}  ${info.response || ""}`);

    await logAudit({
      req, action: "invoice.email", entityRef: str(inv.invNo),
      summary: `Emailed invoice ${str(inv.invNo) || "(no number)"} to ${to}`,
      detail: { to, total, paidAmount, balanceDue },
    });

    res.json({ ok: true, messageId: info.messageId, total, pdfBytes: pdf.length });
  } catch (err) {
    console.error("Invoice email failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't send the invoice." });
  }
}

/* ── POST / — save/update invoice ── */
export async function saveInvoice(req: Request, res: Response) {
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

    console.log(`🧾 POST /invoices ${invoiceNo} — ${lines.length} line(s), ${countLinked(lines)} linked to inventory`);

    const { subtotal, discVal, discountAmt, taxPct, taxAmt, total } = computeTotals(
      lines, inv.discType, inv.discVal, inv.taxPct,
    );

    const when = new Date(str(inv.date));
    const date = isNaN(when.getTime()) ? new Date() : when;
    const createdById = (req as any).user?.id ?? null;
    const existing = await prisma.invoice.findUnique({ where: { invoiceNo } });
    const source = asSource(inv.source, existing?.source ?? "offline");
    const customerId = await upsertCustomer(client, source);
    const content = {
      date,
      clientName: str(client.name) || "—",
      clientPhone: str(client.phone) || null,
      clientEmail: str(client.email) || null,
      clientGstin: str(client.gstin) || null,
            clientAddr: str(client.address) || null,
      source,
      customerId,
      business: {
        name: str(biz.name), address: str(biz.address), phone: str(biz.phone),
        email: str(biz.email), gstin: str(biz.gstin), pan: str(biz.pan),
        // print format flag from the Billing page ("half" = Billing 50%, else full).
        // Kept in the business JSON snapshot so the Invoices-tab Print button can
        // reprint each bill in the exact layout it was created in.
        format: (biz as any).format === "half" ? "half" : "full",
      },
      items: lines.map(mapLine),
      discType: (inv.discType === "percent" ? "percent" : "amount") as "amount" | "percent",
      discVal, taxPct, subtotal, discountAmt, taxAmt, total,
      notes: str(inv.notes) || null,
      warranty: str(inv.warranty) || null,
    };

    if (existing) {
      // Re-save of an existing bill. applyInvoiceStock is idempotent (guarded by
      // invoice.stockApplied), so calling it here can never double-deduct — but it
      // DOES let a bill whose earlier deduction failed (server error, or a line
      // pointing at a since-deleted item) succeed on a retry instead of being
      // stuck forever.
      await prisma.invoice.update({ where: { invoiceNo }, data: content });
      const synced = await recomputeInvoice(existing.id, { reactivate: false });
      const stock = existing.status === "cancelled"
        ? undefined
        : await applyStockSafely(existing.id, createdById);
      await logStockAudit(req, "deduct", invoiceNo, existing.id, stock);
      return res.status(200).json({ ...synced, pdfUrl: invoicePdfUrl(req, existing.id), stock });
    }

        const created = await prisma.invoice.create({ data: { invoiceNo, ...content, createdById } });

    // VERIFY the row is really in the DB before telling the client it saved.
    // If this re-read comes back empty, throw instead of returning a false
    // success — so the frontend shows an error and the user knows to retry.
    const confirm = await prisma.invoice.findUnique({ where: { id: created.id }, select: { id: true } });
    if (!confirm) {
      console.error(`❌ Invoice ${invoiceNo} created but not found on re-read`);
      return res.status(500).json({ message: "The invoice didn't save. Please try again." });
    }

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

    // auto-deduct stock for any line linked to an inventory item (best-effort —
    // never fails the bill). Negatives allowed; now-out/low items come back as
    // warnings, and unmatched lines / thrown errors come back on `stock` so the
    // Billing tab can show them instead of failing silently.
    const stock = await applyStockSafely(created.id, createdById);

    await logAudit({
      req, action: "invoice.create", entityId: created.id, entityRef: invoiceNo,
      summary: `Created invoice ${invoiceNo} for ${content.clientName} — ${rupee(total)}` +
        (advance > 0 ? ` (advance ${rupee(advance)} ${asMethod(inv.paymentMethod, "cash")})` : ""),
      detail: { total, advance, method: advance > 0 ? asMethod(inv.paymentMethod, "cash") : null },
    });
    await logStockAudit(req, "deduct", invoiceNo, created.id, stock);

    res.status(201).json({ ...synced, pdfUrl: invoicePdfUrl(req, created.id), stock });
    } catch (err) {
    console.error("Invoice save failed:", err);
    if ((err as { code?: string }).code === "P2002") {
      return res.status(409).json({ message: `Invoice number "${str((req.body as any)?.invNo)}" already exists. Change the number and save again.` });
    }
    res.status(500).json({ message: (err as Error).message || "Couldn't save the invoice." });
  }
}

/* ── GET / — list all ── */
export async function listInvoices(req: Request, res: Response) {
  try {
    const invoices = await prisma.invoice.findMany({ orderBy: { createdAt: "desc" }, include: withPayments });
    res.json(invoices.map((inv) => ({ ...inv, pdfUrl: invoicePdfUrl(req, inv.id) })));
  } catch (err) {
    console.error("Invoice list failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't load invoices." });
  }
}

/* ── GET /:id — single ── */
export async function getInvoice(req: Request, res: Response) {
  try {
    const id = str(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id }, include: withPayments });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });
    res.json({ ...invoice, pdfUrl: invoicePdfUrl(req, invoice.id) });
  } catch (err) {
    console.error("Invoice fetch failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't load the invoice." });
  }
}

/* ── POST /:id/stock-retry — re-run the stock deduction for one bill ──
   For a bill whose auto-deduct failed or was left unapplied (e.g. a line
   pointed at an item that had been deleted). Idempotent: a bill that already
   has stockApplied=true comes back with changed:false and nothing happens. */
export async function retryStock(req: Request, res: Response) {
  try {
    const id = str(req.params.id);
    const actorId = (req as any).user?.id ?? null;
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });
    if (invoice.status === "cancelled") {
      return res.status(400).json({ message: "This invoice is cancelled — reactivate it before deducting stock." });
    }

    const stock = await applyStockSafely(id, actorId);
    await logStockAudit(req, "deduct", invoice.invoiceNo, invoice.id, stock);

    const updated = await prisma.invoice.findUnique({ where: { id }, include: withPayments });
    res.json({ ...updated, pdfUrl: invoicePdfUrl(req, id), stock });
  } catch (err) {
    console.error("Invoice stock retry failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't re-run the stock deduction." });
  }
}

/* ── POST /:id/remind — payment reminder ── */
export async function remindInvoice(req: Request, res: Response) {
  try {
    const id = str(req.params.id);
    const channel: "email" | "whatsapp" = req.body?.channel === "whatsapp" ? "whatsapp" : "email";
    const invoice = await prisma.invoice.findUnique({ where: { id }, include: withPayments });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });
    if (invoice.status === "paid") return res.status(400).json({ message: "This invoice is already fully paid." });
    if (invoice.status === "cancelled") return res.status(400).json({ message: "This invoice is cancelled — reactivate it before reminding." });

    const total = Number(invoice.total);
    const paid = Number(invoice.paidAmount);
    const balance = round2(Math.max(total - paid, 0));
    if (balance <= 0.005) return res.status(400).json({ message: "Nothing due on this invoice." });

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

      const noteHtml = note.split(/\n\s*\n/).map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#2a231d">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join("");
      const logoHtml = reminderLogoPath
        ? `<img src="cid:aa-logo" alt="${escapeHtml(bizName)}" height="46" style="height:46px;width:auto;display:block;margin:0 auto;border:0" />`
        : `<div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:.3px">${escapeHtml(bizName)}</div>
           <div style="font-size:10.5px;letter-spacing:3px;text-transform:uppercase;color:#c2974a;font-weight:700;margin-top:6px">Printing &amp; Design Studio</div>`;

      const html = `<!doctype html><html><body style="margin:0;padding:0;background:#efe9dc">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efe9dc;padding:30px 12px">
          <tr><td align="center">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fffdf8;border:1px solid #e7ddcb;font-family:'DM Sans',Arial,Helvetica,sans-serif">
              <tr><td style="background:linear-gradient(135deg,#2a231d 0%,#3b2f25 100%);padding:26px 28px;text-align:center">${logoHtml}</td></tr>
              <tr><td style="height:4px;line-height:4px;font-size:0;background:linear-gradient(90deg,#d9542f 0%,#c2974a 100%)">&nbsp;</td></tr>
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
        `AMOUNT DUE: ${rupee(balance)}\nInvoice total: ${rupee(total)}  ·  Received: ${rupee(paid)}\nInvoice ${invoice.invoiceNo}  ·  ${dateStr}\n\n` +
        `The full invoice is attached as a PDF.\n\n${bizName}\n${bizAddress || "Berhampore, West Bengal"}` +
        (bizPhone ? `\n${bizPhone}` : "") + (bizEmail ? `\n${bizEmail}` : "");

      let pdf: Buffer | null = null;
      try { pdf = await buildInvoicePdfFromRecord(invoice); } catch (e) {
        console.warn("🔔 reminder PDF build failed — sending without attachment:", (e as Error).message);
      }

      const attachments: any[] = [];
      if (pdf) attachments.push({ filename: `Invoice-${safeNo}.pdf`, content: pdf, contentType: "application/pdf" });
      if (reminderLogoPath) attachments.push({ filename: "logo.png", path: reminderLogoPath, cid: "aa-logo", contentDisposition: "inline" as const, contentType: "image/png" });

      const info = (await transporter.sendMail({
        from: mailFrom(), to,
        replyTo: bizEmail || process.env.SMTP_USER || undefined,
        subject, html, text, attachments,
      })) as { rejected?: (string | { address: string })[]; messageId?: string; response?: string };

      const addr = (a: string | { address: string }) => (typeof a === "string" ? a : a.address);
      if ((info.rejected || []).some((a) => addr(a).toLowerCase() === to)) {
        console.error(`🔔 reminder REJECTED  ${to} — ${info.response || "recipient refused"}`);
        return res.status(502).json({ message: info.response || "The mail server refused that address." });
      }
      console.log(`🔔 reminder ${invoice.invoiceNo} emailed  ${to}  pdf=${pdf ? (pdf.length / 1024).toFixed(0) + "kb" : "none"}  id=${info.messageId || "?"}`);
    }

    const updated = await prisma.invoice.update({
      where: { id },
      data: { lastRemindedAt: new Date(), reminderCount: { increment: 1 } },
      include: withPayments,
    });

    await logAudit({
      req, action: "invoice.remind", entityId: invoice.id, entityRef: invoice.invoiceNo,
      summary: `Reminder sent via ${channel} for ${invoice.invoiceNo} — balance ${rupee(balance)}`,
      detail: { channel, balance, to: channel === "email" ? invoice.clientEmail : invoice.clientPhone, reminderCount: updated.reminderCount },
    });

    res.json({ ...updated, pdfUrl: invoicePdfUrl(req, updated.id) });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") return res.status(404).json({ message: "Invoice not found." });
    console.error("Invoice reminder failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't send the reminder." });
  }
}

/* ── PATCH /:id/edit — edit unpaid/partial invoice ──
   Stock is RE-SYNCED: the old consumption is reversed and the new line-up is
   applied, so changing a linked line's quantity (or removing it) is reflected
   in inventory instead of leaving the original deduction stranded. */
export async function editInvoice(req: Request, res: Response) {
  try {
    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ message: pe.message });

    const id = str(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });
    if (invoice.status === "paid") return res.status(403).json({ message: "This invoice is paid and locked. Delete and recreate it to make a correction." });
    if (invoice.status === "cancelled") return res.status(403).json({ message: "This invoice is cancelled. Reactivate it (record a payment) before editing." });

    const body = (req.body || {}) as { date?: string; client?: Party; items?: Line[]; discType?: string; discVal?: unknown; taxPct?: unknown; notes?: string; warranty?: string; source?: unknown; };
    const client: Party = body.client || {};
    const actorId = (req as any).user?.id ?? null;

    const lines = (Array.isArray(body.items) ? body.items : []).filter((it) => str(it.desc) || num(it.rate) > 0);
    if (!lines.length) return res.status(400).json({ message: "Add at least one line item before saving." });

    const { subtotal, discVal, discountAmt, taxPct, taxAmt, total } = computeTotals(lines, body.discType, body.discVal, body.taxPct);
    const whenRaw = str(body.date);
    const when = new Date(whenRaw);
    const date = whenRaw && !isNaN(when.getTime()) ? when : invoice.date;
    const source = asSource(body.source, invoice.source);

    // give back whatever this bill had taken, using the OLD line-up
    const reversed = await reverseStockSafely(id, "edited", actorId);

    await prisma.invoice.update({
      where: { id },
      data: {
        date, source,
        clientName: str(client.name) || "—",
        clientPhone: str(client.phone) || null,
        clientEmail: str(client.email) || null,
        clientGstin: str(client.gstin) || null,
        clientAddr: str(client.address) || null,
        // itemId preserved so the fresh deduction below (and any later
        // cancel/delete restock) still sees the inventory links
        items: lines.map(mapLine),
        discType: (body.discType === "percent" ? "percent" : "amount") as "amount" | "percent",
        discVal, taxPct, subtotal, discountAmt, taxAmt, total,
        notes: str(body.notes) || null,
        warranty: str(body.warranty) || null,
      },
    });

    // take the new line-up
    const stock = await applyStockSafely(id, actorId);

    const updated = await recomputeInvoice(id, { reactivate: false });
    const paidAmount = updated ? Number(updated.paidAmount) : 0;

    await logAudit({
      req, action: "invoice.edit", entityId: invoice.id, entityRef: invoice.invoiceNo,
      summary: `Edited invoice ${invoice.invoiceNo} for ${str(client.name) || "—"} — now ${rupee(total)}` +
        (paidAmount > 0 ? ` (paid ${rupee(paidAmount)}, balance ${rupee(Math.max(total - paidAmount, 0))})` : ""),
      detail: { before: { total: Number(invoice.total), status: invoice.status }, after: { total, itemCount: lines.length }, paidAmount },
    });
    await logStockAudit(req, "restock", invoice.invoiceNo, invoice.id, reversed);
    await logStockAudit(req, "deduct", invoice.invoiceNo, invoice.id, stock);

    res.json({ ...updated, pdfUrl: updated ? invoicePdfUrl(req, updated.id) : null, stock });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") return res.status(404).json({ message: "Invoice not found." });
    console.error("Invoice edit failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't save the changes." });
  }
}

/* ── POST /:id/payments — record a payment ── */
export async function recordPayment(req: Request, res: Response) {
  try {
    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ message: pe.message });

    const id = str(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id }, include: withPayments });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });

    const total = Number(invoice.total);
    const currentPaid = clamp(round2(invoice.payments.reduce((s, p) => s + Number(p.amount), 0)), 0, total);
    const remaining = round2(Math.max(total - currentPaid, 0));
    if (remaining <= 0.005) return res.status(400).json({ message: "This invoice is already fully paid." });

    const amount = clamp(round2(num(req.body.amount)), 0, remaining);
    if (amount <= 0.005) return res.status(400).json({ message: "Enter a payment amount greater than zero." });

    const method = asMethod(req.body.method, "cash");
    const note = str(req.body.note);
    const createdById = (req as any).user?.id ?? null;
    const wasCancelled = invoice.status === "cancelled";

    await prisma.payment.create({
      data: { invoiceId: id, amount, method, note: note || "", createdById },
    });

    const updated = await recomputeInvoice(id, { reactivate: true });
    const balance = updated ? round2(Math.max(total - Number(updated.paidAmount), 0)) : 0;

    // a payment un-cancels the bill → re-consume its linked stock
    const stock = wasCancelled && updated && updated.status !== "cancelled"
      ? await applyStockSafely(id, createdById)
      : undefined;

    await logAudit({
      req, action: "invoice.payment", entityId: invoice.id, entityRef: invoice.invoiceNo,
      summary: `Payment on ${invoice.invoiceNo}: ${rupee(amount)} ${method} (balance ${rupee(balance)})`,
      detail: { amount, method, note, balanceDue: balance, status: updated?.status },
    });
    await logStockAudit(req, "deduct", invoice.invoiceNo, invoice.id, stock);

    res.status(201).json({ ...updated, pdfUrl: updated ? invoicePdfUrl(req, updated.id) : null, stock });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") return res.status(404).json({ message: "Invoice not found." });
    console.error("Invoice payment failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't record the payment." });
  }
}

/* ── DELETE /:id/payments/:paymentId ── */
export async function deletePayment(req: Request, res: Response) {
  try {
    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ message: pe.message });

    const id = str(req.params.id);
    const paymentId = str(req.params.paymentId);

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.invoiceId !== id) return res.status(404).json({ message: "Payment not found on this invoice." });

    await prisma.payment.delete({ where: { id: paymentId } });
    const updated = await recomputeInvoice(id, { reactivate: false });

    await logAudit({
      req, action: "invoice.payment.delete", entityId: id, entityRef: updated?.invoiceNo ?? id,
      summary: `Removed a ${rupee(Number(payment.amount))} ${payment.method} payment from ${updated?.invoiceNo ?? "invoice"}`,
      detail: { amount: Number(payment.amount), method: payment.method, status: updated?.status },
    });

    res.json({ ...updated, pdfUrl: updated ? invoicePdfUrl(req, updated.id) : null });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") return res.status(404).json({ message: "Payment not found." });
    console.error("Invoice payment delete failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't remove the payment." });
  }
}

/* ── PATCH /:id/status — cancel / reactivate ── */
const STATUSES = ["unpaid", "partial", "paid", "cancelled"] as const;
export async function setInvoiceStatus(req: Request, res: Response) {
  try {
    const status = str(req.body.status);
    if (!(STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ message: "Status must be unpaid, partial, paid or cancelled." });
    }
    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ message: pe.message });

    const id = str(req.params.id);
    const actorId = (req as any).user?.id ?? null;
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });

    if (status === "cancelled") {
      const updated = await prisma.invoice.update({ where: { id }, data: { status: "cancelled" }, include: withPayments });
      // cancelling restocks any linked items
      const stock = await reverseStockSafely(id, "cancelled", actorId);
      await logAudit({ req, action: "invoice.cancel", entityId: invoice.id, entityRef: invoice.invoiceNo, summary: `Cancelled invoice ${invoice.invoiceNo}`, detail: { from: invoice.status, to: "cancelled" } });
      await logStockAudit(req, "restock", invoice.invoiceNo, invoice.id, stock);
      return res.json({ ...updated, pdfUrl: invoicePdfUrl(req, updated.id), stock });
    }

    const wasCancelled = invoice.status === "cancelled";
    const updated = await recomputeInvoice(id, { reactivate: true });
    // reactivating a cancelled bill → re-consume its linked stock
    const stock = wasCancelled && updated && updated.status !== "cancelled"
      ? await applyStockSafely(id, actorId)
      : undefined;
    await logAudit({ req, action: "invoice.status", entityId: invoice.id, entityRef: invoice.invoiceNo, summary: `Reactivated invoice ${invoice.invoiceNo} → ${updated?.status}`, detail: { from: invoice.status, to: updated?.status } });
    await logStockAudit(req, "deduct", invoice.invoiceNo, invoice.id, stock);
    res.json({ ...updated, pdfUrl: updated ? invoicePdfUrl(req, updated.id) : null, stock });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") return res.status(404).json({ message: "Invoice not found." });
    console.error("Invoice status update failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't update the invoice." });
  }
}

/* ── DELETE /:id — delete invoice ── */
export async function deleteInvoice(req: Request, res: Response) {
  try {
    const pe = await pinError(req);
    if (pe) return res.status(pe.code).json({ message: pe.message });

    const id = str(req.params.id);
    const actorId = (req as any).user?.id ?? null;
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });

    // restock linked items BEFORE removing the bill (writes returned movements
    // while the invoice still exists; the FK then nulls invoiceId on delete,
    // with the invoice number kept in each movement's note). Best-effort.
    const stock = await reverseStockSafely(id, "deleted", actorId);

    await prisma.invoice.delete({ where: { id } });

    await logAudit({
      req, action: "invoice.delete", entityId: invoice.id, entityRef: invoice.invoiceNo,
      summary: `Deleted invoice ${invoice.invoiceNo} (${invoice.clientName}, ${rupee(Number(invoice.total))})`,
      detail: { total: Number(invoice.total), paidAmount: Number(invoice.paidAmount), status: invoice.status },
    });
    await logStockAudit(req, "restock", invoice.invoiceNo, invoice.id, stock);

    res.json({ ok: true, stock });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") return res.status(404).json({ message: "Invoice not found." });
    console.error("Invoice delete failed:", err);
    res.status(500).json({ message: (err as Error).message || "Couldn't delete the invoice." });
  }
}


/* ── GET /next-number — server-decided next invoice number ──
   The frontend asks the server for the next number so it's ALWAYS unique —
   even across devices, browsers or a cleared localStorage. We take today's
   stamp, find the highest AA-YYMMDD-NNN already in the DB for today, and
   return the next one. The DB is the single source of truth; the unique
   constraint on invoiceNo (plus saveInvoice's 409 on a clash) is the final
   guard if two people bill at the same instant. */
export async function nextInvoiceNumber(_req: Request, res: Response) {
  try {
        // Always the IST calendar date, so the counter rolls over at midnight IST
    // no matter what timezone the server runs in (UTC on most hosts). en-CA
    // gives YYYY-MM-DD; slice+strip → YYMMDD.
    const stamp = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(2).replace(/-/g, "");
    const prefix = `AA-${stamp}-`;

    const todays = await prisma.invoice.findMany({
      where: { invoiceNo: { startsWith: prefix } },
      select: { invoiceNo: true },
    });

    let maxSeq = 0;
    for (const row of todays) {
      const m = row.invoiceNo.match(/-(\d+)$/);
      if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10) || 0);
    }

    const next = `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;
    res.json({ invoiceNo: next });
  } catch (err) {
    console.error("next invoice number failed:", err);
    res.status(500).json({ message: "Couldn't get the next invoice number." });
  }
}