// backend/src/seed.ts
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { prisma } from "./config/prisma.js";

dotenv.config();

const services = [
  { name: "Flex Printing / Painting", icon: "🖼️", description: "Banners, hoardings and flex boards in any size." },
  { name: "Laser Cutting", icon: "🔆", description: "Precise laser cutting and engraving." },
  { name: "Digital Printing", icon: "🖨️", description: "High quality digital prints." },
  { name: "Sticker Cutting (Plotter)", icon: "✂️", description: "Custom stickers and vinyl cutting." },
  { name: "Stamp Making", icon: "📑", description: "Rubber and pre-inked stamps." },
  { name: "ID Card Holder", icon: "🪪", description: "Card holders and lanyards." },
  { name: "PVC Card", icon: "💳", description: "Durable PVC ID and visiting cards." },
  { name: "Cup Printing", icon: "☕", description: "Custom printed mugs and cups." },
  { name: "LED Module", icon: "💡", description: "LED modules and glow sign components." },
];

const run = async (): Promise<void> => {
  await prisma.service.deleteMany();
  await prisma.service.createMany({ data: services });
  console.log(`✅ Seeded ${services.length} services`);

  const adminEmail = "admin@abhijitart.com";
  const hashed = await bcrypt.hash("AbhiArt2026", 10);

  await prisma.user.deleteMany({ where: { email: adminEmail } });
  await prisma.user.create({
    data: { name: "Avijit Art Admin", email: adminEmail, password: hashed, role: "admin" },
  });
  console.log("✅ Admin Credentials Updated");

  await prisma.$disconnect();
  process.exit(0);
};

run();