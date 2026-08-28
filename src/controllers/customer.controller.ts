// backend/src/controllers/customer.controller.ts
import type { Request, Response } from "express";
import { prisma } from "../config/prisma.js";
import { Prisma } from "@prisma/client";
import { transporter, mailFrom } from "../config/mailer.js";

const str = (v: unknown) => String(v ?? "").trim();

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
    const source = str(req.query.source) as "online" | "offline" | "";

    const where: Prisma.CustomerWhereInput = {};
    if (q) {
      where.OR = [
        { name:  { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
        { email: { contains: q, mode: "insensitive" } },
      ];
    }
    if (source === "online" || source === "offline") {
      where.source = source;
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

/* ── POST /email ── bulk email with HTML template + token replacement ── */
export async function emailCustomers(req: Request, res: Response) {
  try {
    const { ids, subject, message } = req.body || {};
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ message: "No customer IDs provided." });
    if (!str(subject)) return res.status(400).json({ message: "Subject is required." });
    if (!str(message)) return res.status(400).json({ message: "Message is required." });

    const customers = await prisma.customer.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true },
    });

    const results: { id: string; name: string; email: string | null; status: "sent" | "skipped" | "failed"; reason?: string }[] = [];

    for (const c of customers) {
      if (!c.email) {
        results.push({ id: c.id, name: c.name, email: null, status: "skipped", reason: "No email on file" });
        continue;
      }

      // Token replacement: {{name}}, {{first_name}}
      const firstName = c.name.split(/\s+/)[0] || c.name;
      const body = str(message)
        .replace(/\{\{name\}\}/gi, c.name)
        .replace(/\{\{first_name\}\}/gi, firstName);

      const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f6f8;font-family:'DM Sans',Arial,sans-serif">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:28px 12px">
          <tr><td align="center">
            <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border:1px solid #f0e6dc">
              <tr><td style="padding:28px 28px 0">
                <div style="font-size:21px;font-weight:800;color:#d9542f;letter-spacing:-0.4px">Abhijit Art</div>
              </td></tr>
              <tr><td style="padding:20px 28px">
                ${body.split(/\n\s*\n/).map(p =>
                  `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#1f2430">${
                    p.replace(/\n/g, "<br/>")
                  }</p>`
                ).join("")}
              </td></tr>
              <tr><td style="padding:18px 28px;border-top:1px solid #f0e6dc;background:#fffcf9">
                <div style="font-size:12px;color:#8a8f9a">Abhijit Art · Berhampore, West Bengal</div>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body></html>`;

      try {
        await transporter.sendMail({
          from: mailFrom(),
          to: c.email,
          subject: str(subject).replace(/\{\{name\}\}/gi, c.name).replace(/\{\{first_name\}\}/gi, firstName),
          html,
          text: body,
        });
        results.push({ id: c.id, name: c.name, email: c.email, status: "sent" });
      } catch (e) {
        results.push({ id: c.id, name: c.name, email: c.email, status: "failed", reason: (e as Error).message });
      }
    }

    const sent    = results.filter(r => r.status === "sent").length;
    const skipped = results.filter(r => r.status === "skipped").length;
    const failed  = results.filter(r => r.status === "failed").length;

    console.log(`📧 bulk email: ${sent} sent, ${skipped} skipped, ${failed} failed`);
    res.json({ sent, skipped, failed, results });
  } catch (err) {
    console.error("Customer email failed:", err);
    res.status(500).json({ message: "Couldn't send emails." });
  }
}