// One-off: remove two empty test records for good.
//
// Safe only because both came back with zero entries — a Payee with money
// written against it is what those rows point at, and deleting one would
// either fail on the foreign key or orphan real figures. So the count is
// checked again here rather than trusted from a minute ago.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const KEYS = ["SOURO", "JYOTIPROVA GHOSH"];

const found = await prisma.payee.findMany({
  where: { nameKey: { in: KEYS } },
  include: { _count: { select: { expenses: true } } },
});

if (!found.length) {
  console.log("Neither name is in the list — nothing to do.");
} else {
  const busy = found.filter((p) => p._count.expenses > 0);
  if (busy.length) {
    console.log("Refusing to delete — these now have entries against them:");
    for (const p of busy) console.log(`  ${p.name} — ${p._count.expenses}`);
    console.log("\nLeave them deactivated instead.");
  } else {
    for (const p of found) {
      await prisma.payee.delete({ where: { id: p.id } });
      console.log(`Deleted ${p.name}`);
    }
    console.log(`\nDone — ${found.length} empty record${found.length === 1 ? "" : "s"} removed.`);
  }
}

await prisma.$disconnect();