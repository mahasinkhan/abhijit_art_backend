// backend/src/scripts/backfill-customers.ts
// Run once: npx tsx src/scripts/backfill-customers.ts
// Scans all invoices, upserts a Customer for each unique phone/name,
// and links the invoice to that customer via customerId.

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const normalizePhone = (v: string) =>
  (v || "").replace(/\D/g, "").slice(-10) || null;

async function main() {
  const invoices = await prisma.invoice.findMany({
    where: { customerId: null },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Found ${invoices.length} invoices without customerId`);

  let linked = 0;
  let created = 0;
  let skipped = 0;

  for (const inv of invoices) {
    const name  = (inv.clientName || "").trim() || "—";
    const phone = normalizePhone(inv.clientPhone || "");
    const email = (inv.clientEmail || "").trim() || null;
    const gstin = (inv.clientGstin || "").trim() || null;
    const addr  = (inv.clientAddr  || "").trim() || null;
    const src   = inv.source ?? "offline";

    try {
      let customer;

      if (phone) {
        customer = await prisma.customer.upsert({
          where:  { phone },
          update: { name, email: email ?? undefined, gstin: gstin ?? undefined, address: addr ?? undefined },
          create: { phone, name, email, gstin, address: addr, source: src },
        });
      } else {
        // No phone — find by name or create
        customer = await prisma.customer.findFirst({
          where: { phone: null, name: { equals: name, mode: "insensitive" } },
        });
        if (!customer) {
          customer = await prisma.customer.create({
            data: { name, phone: null, email, gstin, address: addr, source: src },
          });
          created++;
        }
      }

      await prisma.invoice.update({
        where: { id: inv.id },
        data:  { customerId: customer.id },
      });

      linked++;
      if (linked % 10 === 0) process.stdout.write(`  linked ${linked}/${invoices.length}\r`);
    } catch (e: any) {
      console.warn(`  ⚠ skipped ${inv.invoiceNo} — ${e.message}`);
      skipped++;
    }
  }

  console.log(`\n✅ Done — ${linked} linked, ${created} new customers created, ${skipped} skipped`);

  const total = await prisma.customer.count();
  console.log(`   Customer table now has ${total} records`);
}

main()
  .catch(e => { console.error("❌ Backfill failed:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());