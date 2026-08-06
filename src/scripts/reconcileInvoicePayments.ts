// backend/src/scripts/reconcileInvoicePayments.ts
//
// One-off: invoices marked "paid" before the paidAmount field existed are
// stored as paid but with ₹0 received, so Due / Received disagree with the
// Paid badge. This backfills paidAmount to match status:
//   paid → full total,  unpaid → 0.  Partial + cancelled are left untouched.
//
//   cd backend
//   npx tsx src/scripts/reconcileInvoicePayments.ts

import "dotenv/config";
import { prisma } from "../config/prisma.js";

async function main() {
  const invoices = await prisma.invoice.findMany();
  let fixed = 0;

  for (const inv of invoices) {
    const total = Number(inv.total);
    const paid = Number(inv.paidAmount);
    let next = paid;

    if (inv.status === "paid" && paid + 0.005 < total) next = total;   // legacy paid, ₹0 recorded
    else if (inv.status === "unpaid" && paid > 0.005) next = 0;        // normalise
    if (next > total) next = total;                                    // clamp overpayment

    if (Math.abs(next - paid) > 0.005) {
      await prisma.invoice.update({ where: { id: inv.id }, data: { paidAmount: next } });
      console.log(`✔ ${inv.invoiceNo}: ₹${paid.toFixed(2)} → ₹${next.toFixed(2)}  (${inv.status}, total ₹${total.toFixed(2)})`);
      fixed++;
    }
  }

  console.log(`\nDone — reconciled ${fixed} invoice(s).`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});