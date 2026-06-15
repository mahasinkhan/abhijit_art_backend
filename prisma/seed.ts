// backend/prisma/seed.ts
// Run with:  npx ts-node prisma/seed.ts
//   (or add  "prisma": { "seed": "ts-node prisma/seed.ts" }  to package.json, then: npx prisma db seed)

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs"; // ⚠️ MATCH #1: use the SAME lib your login handler uses
                               //    bcryptjs → `import bcrypt from "bcryptjs"`
                               //    bcrypt   → `import bcrypt from "bcrypt"`

const prisma = new PrismaClient();

async function main() {
  const email = "admin@abhijitart.com";
  const plainPassword = "Admin@abhijit2026"; // ← the password you'll log in with

  const hashed = await bcrypt.hash(plainPassword, 10);

  const admin = await prisma.user.upsert({
    where: { email },
    update: {
      password: hashed,   // ⚠️ MATCH #2: field name from schema.prisma (password? passwordHash?)
      role: "admin",      // ⚠️ MATCH #2: must equal what ProtectedRoute checks ("admin")
    },
    create: {
      name: "Avijit",
      email,
      password: hashed,   // ⚠️ MATCH #2: same field name as above
      role: "admin",
    },
  });

  console.log("✅ Admin ready:", admin.email);
  console.log("   Login with:", email, "/", plainPassword);
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());