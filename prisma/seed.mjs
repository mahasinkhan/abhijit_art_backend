import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = "admin@abhijitart.com";
  const plainPassword = "Admin@abhijit2026";

  const hashed = await bcrypt.hash(plainPassword, 10);

  const admin = await prisma.user.upsert({
    where: { email },
    update: { password: hashed, role: "admin" },
    create: { name: "Avijit", email, password: hashed, role: "admin" },
  });

  console.log("✅ Admin ready:", admin.email);
  console.log("   Login with:", email, "/", plainPassword);
}

main()
  .catch((e) => { console.error("❌ Seed failed:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());