// backend/src/controllers/customer.controller.ts
import type { Request, Response } from "express";
import { prisma } from "../config/prisma.js";
import { Prisma } from "@prisma/client";
import { transporter, mailFrom } from "../config/mailer.js";

const str = (v: unknown) => String(v ?? "").trim();
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type InvoiceStat = { total: Prisma.Decimal | number; paidAmount: Prisma.Decimal | number; status: string };

function computeStats(invoices: InvoiceStat[]) {
  const active = invoices.filter(i => i.status !== "cancelled");
  const billed = active.reduce((s, i) => s + Number(i.total), 0);
  const paid   = active.reduce((s, i) => s + Number(i.paidAmount), 0);
  return {
    billed: Math.round(billed * 100) / 100,
    paid:   Math.round(paid   * 100) / 100,
    due:    Math.round(Math.max(billed - paid, 0) * 100) / 100,
  };
}

/* ── GET / ── list with invoice stats ── */
export async function listCustomers(req: Request, res: Response) {
  try {
    const q      = str(req.query.q);
    const raw    = str(req.query.source);
    // the UI's dropdown says "From billing" / "Walk-in", which map onto the
    // CustomerSource enum online|offline. Accept both spellings.
    const source =
      raw === "billing" || raw === "online"  ? "online"  :
      raw === "walkin"  || raw === "offline" ? "offline" : "";

    const where: Prisma.CustomerWhereInput = {};
    if (q) {
      where.OR = [
        { name:  { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
        { email: { contains: q, mode: "insensitive" } },
      ];
    }
    if (source) {
      where.source = source as "online" | "offline";
    }

    const customers = await prisma.customer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { invoices: true } },
        invoices: { select: { total: true, paidAmount: true, status: true } },
      },
    });

    const result = customers.map(c => ({
      id: c.id, name: c.name, phone: c.phone, email: c.email,
      gstin: c.gstin, address: c.address, source: c.source,
      createdAt: c.createdAt, updatedAt: c.updatedAt,
      invoiceCount: c._count.invoices,
      ...computeStats(c.invoices),
    }));

    res.json(result);
  } catch (err) {
    console.error("Customer list failed:", err);
    res.status(500).json({ message: "Couldn't load customers." });
  }
}

/* ── POST / ── create ── */
export async function createCustomer(req: Request, res: Response) {
  try {
    const body    = req.body || {};
    const name    = str(body.name);
    const phone   = str(body.phone).replace(/\D/g, "").slice(-10) || null;
    const email   = str(body.email)   || null;
    const gstin   = str(body.gstin)   || null;
    const address = str(body.address) || null;
    const source: "online" | "offline" =
      body.source === "online" ? "online" : "offline";

    if (!name) return res.status(400).json({ message: "Name is required." });

    if (phone) {
      const existing = await prisma.customer.findUnique({ where: { phone } });
      if (existing) return res.status(409).json({ message: "Phone already registered.", existing });
    }

    // duplicate email check
    if (email) {
      const existing = await prisma.customer.findFirst({ where: { email } });
      if (existing) return res.status(409).json({ message: "Email already registered.", existing });
    }

    const customer = await prisma.customer.create({
      data: { name, phone, email, gstin, address, source },
    });
    res.status(201).json(customer);
  } catch (err) {
    if ((err as { code?: string }).code === "P2002")
      return res.status(409).json({ message: "Phone already registered." });
    console.error("Customer create failed:", err);
    res.status(500).json({ message: "Couldn't create customer." });
  }
}

/* ── GET /:id ── single with invoices ── */
export async function getCustomer(req: Request, res: Response) {
  try {
    const id = str(req.params.id);
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        invoices: {
          orderBy: { createdAt: "desc" },
          include: { payments: { orderBy: { createdAt: "asc" } } },
        },
      },
    });
    if (!customer) return res.status(404).json({ message: "Customer not found." });
    res.json(customer);
  } catch (err) {
    console.error("Customer fetch failed:", err);
    res.status(500).json({ message: "Couldn't load customer." });
  }
}

/* ── PATCH /:id ── update ── */
export async function updateCustomer(req: Request, res: Response) {
  try {
    const id   = str(req.params.id);
    const body = req.body || {};

    const data: Prisma.CustomerUpdateInput = {};
    if ("name"    in body) data.name    = str(body.name) || "—";
    if ("email"   in body) data.email   = str(body.email)   || null;
    if ("gstin"   in body) data.gstin   = str(body.gstin)   || null;
    if ("address" in body) data.address = str(body.address) || null;
    if ("phone"   in body) {
      data.phone = str(body.phone).replace(/\D/g, "").slice(-10) || null;
    }

    const updated = await prisma.customer.update({ where: { id }, data });
    res.json(updated);
  } catch (err) {
    if ((err as { code?: string }).code === "P2025")
      return res.status(404).json({ message: "Customer not found." });
    if ((err as { code?: string }).code === "P2002")
      return res.status(409).json({ message: "Phone already registered." });
    console.error("Customer update failed:", err);
    res.status(500).json({ message: "Couldn't update customer." });
  }
}

/* ── DELETE /:id ── delete ── */
export async function deleteCustomer(req: Request, res: Response) {
  try {
    const id = str(req.params.id);
    // Null out customerId on all invoices first (safety — schema has onDelete:SetNull but explicit is safer)
    await prisma.invoice.updateMany({ where: { customerId: id }, data: { customerId: null } });
    await prisma.customer.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025")
      return res.status(404).json({ message: "Customer not found." });
    console.error("Customer delete failed:", err);
    res.status(500).json({ message: "Couldn't delete customer." });
  }
}

/* ── POST /email ── bulk email with HTML template + token replacement ──
   Body keys accepted (the UI sends the first of each pair; the second spelling
   is kept so any older caller keeps working):
     customerIds | ids
     body        | message
     ctaLabel    | buttonText
     ctaUrl      | buttonLink
   Response is shaped for the UI's send report: { sent, skipped, failed, total,
   results:[{ ok, id, name, email, error? }] }. */
export async function emailCustomers(req: Request, res: Response) {
  try {
    const b = req.body || {};
    const ids: unknown = b.customerIds ?? b.ids ?? b.userIds;
    const subject  = str(b.subject);
    const message  = str(b.body ?? b.message);
    const ctaLabel = str(b.ctaLabel ?? b.buttonText);
    const ctaUrlIn = str(b.ctaUrl   ?? b.buttonLink);
    // only allow real absolute links in the button
    const ctaUrl = /^https?:\/\//i.test(ctaUrlIn) ? ctaUrlIn : "";

    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ message: "No customer IDs provided.", error: "No customer IDs provided." });
    if (!subject) return res.status(400).json({ message: "Subject is required.", error: "Subject is required." });
    if (!message) return res.status(400).json({ message: "Message is required.", error: "Message is required." });

    const customers = await prisma.customer.findMany({
      where: { id: { in: ids as string[] } },
      select: { id: true, name: true, email: true },
    });

    type Row = {
      ok: boolean; id: string; name: string; email: string | null;
      error?: string;
      // legacy fields, kept so an older caller reading these still works
      status: "sent" | "skipped" | "failed"; reason?: string;
    };
    const results: Row[] = [];

    for (const c of customers) {
      if (!c.email) {
        results.push({ ok: false, id: c.id, name: c.name, email: null, error: "No email on file", status: "skipped", reason: "No email on file" });
        continue;
      }

      // Token replacement: {{name}}, {{first_name}} (whitespace inside the
      // braces is allowed, because the templates in the UI write {{first_name}}
      // but a hand-typed one may read {{ first_name }})
      const firstName = c.name.split(/\s+/)[0] || c.name;
      const fill = (s: string) => s
        .replace(/\{\{\s*first_name\s*\}\}/gi, firstName)
        .replace(/\{\{\s*name\s*\}\}/gi, c.name);

      const body = fill(message);
      const subj = fill(subject);

      const paras = body.split(/\n\s*\n/).map(p =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#1f2430">${esc(p).replace(/\n/g, "<br/>")}</p>`
      ).join("");

      const button = ctaLabel && ctaUrl
        ? `<tr><td style="padding:4px 28px 26px">
             <a href="${esc(ctaUrl)}" style="display:inline-block;padding:13px 26px;background:#d9542f;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none">${esc(ctaLabel)}</a>
           </td></tr>`
        : "";

      const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f6f8;font-family:'DM Sans',Arial,sans-serif">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:28px 12px">
          <tr><td align="center">
            <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border:1px solid #f0e6dc">
              <tr><td style="background:#2a231d;padding:20px 28px">
                <div style="font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-0.3px">Abhijit Art</div>
                <div style="font-size:10px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#c2974a;margin-top:4px">Printing &amp; Design Studio</div>
              </td></tr>
              <tr><td style="height:4px;line-height:4px;font-size:0;background:#d9542f">&nbsp;</td></tr>
              <tr><td style="padding:24px 28px 4px">
                <div style="font-size:17px;font-weight:800;color:#1f2430;margin-bottom:14px">${esc(subj)}</div>
                ${paras}
              </td></tr>
              ${button}
              <tr><td style="padding:18px 28px;border-top:1px solid #f0e6dc;background:#fffcf9">
                <div style="font-size:12px;color:#8a8f9a;line-height:1.6">Abhijit Art · Berhampore, West Bengal<br/>7405179066 · abhijitart85@gmail.com</div>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body></html>`;

      const text = body + (ctaLabel && ctaUrl ? `\n\n${ctaLabel}: ${ctaUrl}` : "") + `\n\nAbhijit Art · Berhampore, West Bengal`;

      try {
        await transporter.sendMail({ from: mailFrom(), to: c.email, subject: subj, html, text });
        results.push({ ok: true, id: c.id, name: c.name, email: c.email, status: "sent" });
        console.log(`✉️  sent → ${c.email}`);
      } catch (e) {
        const msg = (e as Error).message || "Send failed";
        results.push({ ok: false, id: c.id, name: c.name, email: c.email, error: msg, status: "failed", reason: msg });
        console.error(`✉️  FAILED → ${c.email}: ${msg}`);
      }

      // Gmail throttles bursts — space the sends out a little.
      await sleep(400);
    }

    const sent    = results.filter(r => r.status === "sent").length;
    const skipped = results.filter(r => r.status === "skipped").length;
    const failed  = results.filter(r => r.status === "failed").length;

    console.log(`📧 bulk email: ${sent} sent, ${skipped} skipped, ${failed} failed`);
    res.json({ sent, skipped, failed, total: results.length, results });
  } catch (err) {
    console.error("Customer email failed:", err);
    res.status(500).json({ message: "Couldn't send emails.", error: (err as Error).message });
  }
}