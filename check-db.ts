import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const constraints = await prisma.$queryRawUnsafe(`
    SELECT
      conrelid::regclass::text AS table_name,
      conname AS constraint_name
    FROM pg_constraint
    WHERE conrelid::regclass::text IN ('"Task"', '"KhataEntry"')
    ORDER BY table_name, constraint_name;
  `);

  console.log("CONSTRAINTS:");
  console.dir(constraints, { depth: null });

  const indexes = await prisma.$queryRawUnsafe(`
    SELECT
      tablename,
      indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('Task', 'KhataEntry')
    ORDER BY tablename, indexname;
  `);

  console.log("INDEXES:");
  console.dir(indexes, { depth: null });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());