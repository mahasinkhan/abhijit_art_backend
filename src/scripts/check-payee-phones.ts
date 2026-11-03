/**
 * Checks whether Payee.phone can take a UNIQUE index.
 * Read only, it changes nothing.
 *
 *   cd C:\avijit-art\backend
 *   npx tsx src/scripts/check-payee-phones.ts
 */
import { prisma } from "../config/prisma.js";

type Row = {
  id: string;
  name: string;
  phone: string | null;
  kind: string;
  userId: string | null;
  createdAt: Date;
  expenses: number;
};

async function main() {
  const payees = await prisma.payee.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      phone: true,
      kind: true,
      userId: true,
      createdAt: true,
      _count: { select: { expenses: true } },
    },
  });

  const rows: Row[] = payees.map((p) => ({
    id: p.id,
    name: p.name,
    phone: p.phone,
    kind: String(p.kind),
    userId: p.userId,
    createdAt: p.createdAt,
    expenses: p._count.expenses,
  }));

  const withPhone = rows.filter((r) => r.phone !== null && r.phone.trim() !== "");
  const blank = rows.length - withPhone.length;

  const groups = new Map<string, Row[]>();
  for (const r of withPhone) {
    const key = (r.phone as string).trim();
    const list = groups.get(key) || [];
    list.push(r);
    groups.set(key, list);
  }

  const dupes = [...groups.entries()].filter(([, list]) => list.length > 1);

  console.log("");
  console.log("Payee rows total      :", rows.length);
  console.log("With a phone number   :", withPhone.length);
  console.log("Blank or null phone   :", blank, "(allowed, NULL repeats are fine under UNIQUE)");
  console.log("Duplicate phone groups:", dupes.length);
  console.log("");

  if (dupes.length === 0) {
    console.log("CLEAR. The unique index on Payee.phone will apply without error.");
    console.log("Run: npx prisma db push   and answer yes to the warning.");
  } else {
    console.log("BLOCKED. Fix these before pushing. Keep one row per number,");
    console.log("move its expenses, then blank or delete the others.");
    console.log("");
    for (const [phone, list] of dupes) {
      console.log("phone " + phone);
      for (const r of list) {
        console.log(
          "   id=" + r.id +
          "  name=" + JSON.stringify(r.name) +
          "  kind=" + r.kind +
          "  user=" + (r.userId ? "linked" : "none") +
          "  expenses=" + r.expenses +
          "  created=" + r.createdAt.toISOString().slice(0, 10)
        );
      }
      console.log("");
    }
  }

  const empties = rows.filter((r) => r.phone !== null && r.phone.trim() === "");
  if (empties.length > 1) {
    console.log("WARNING: " + empties.length + ' rows have an EMPTY STRING phone, not NULL.');
    console.log('Empty strings are NOT treated as NULL, so they count as duplicates.');
    console.log("Set them to NULL first:");
    console.log('  await prisma.payee.updateMany({ where: { phone: "" }, data: { phone: null } });');
    console.log("");
    for (const r of empties) {
      console.log("   id=" + r.id + "  name=" + JSON.stringify(r.name) + "  expenses=" + r.expenses);
    }
    console.log("");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });