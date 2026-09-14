import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const roles = await prisma.$queryRawUnsafe(`
    SELECT e.enumlabel AS role
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'Role'
    ORDER BY e.enumsortorder;
  `);

  const visitor = await prisma.$queryRawUnsafe(`
    SELECT to_regclass('public."Visitor"')::text AS visitor_table;
  `);

  console.log("ROLE ENUM:");
  console.dir(roles, { depth: null });

  console.log("VISITOR TABLE:");
  console.dir(visitor, { depth: null });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());