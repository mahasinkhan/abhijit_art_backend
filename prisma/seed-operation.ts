/**
 * Seeds (or promotes) the operations user who manages the public site
 * content: home banners and the offer strip.
 *
 *   cd C:\avijit-art\backend
 *
 *   # defaults from .env, or the built-in ones below
 *   npx tsx prisma/seed-operation.ts
 *
 *   # or pass them inline: name, email, password
 *   npx tsx prisma/seed-operation.ts "Design Desk" design@abhijitart.com Str0ngPass!
 *
 * Safe to run more than once. If the email already exists it only flips the
 * role to `operation` and leaves the password alone, unless you pass a new
 * one on the command line.
 *
 * .env keys it will read if no arguments are given:
 *   OPERATION_NAME, OPERATION_EMAIL, OPERATION_PASSWORD
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/config/prisma.js";

const [, , argName, argEmail, argPassword] = process.argv;

const NAME = argName || process.env.OPERATION_NAME || "Operations";
const EMAIL = (argEmail || process.env.OPERATION_EMAIL || "operation@abhijitart.com")
  .trim()
  .toLowerCase();
const PASSWORD = argPassword || process.env.OPERATION_PASSWORD || "";

const mask = (s: string) => (s.length <= 2 ? "**" : s[0] + "*".repeat(s.length - 2) + s[s.length - 1]);

async function main() {
  if (!EMAIL.includes("@")) {
    console.error("That email does not look valid:", EMAIL);
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });

  if (existing) {
    const data: { role: "operation"; password?: string } = { role: "operation" };
    if (PASSWORD) {
      if (PASSWORD.length < 8) {
        console.error("Password must be at least 8 characters.");
        process.exit(1);
      }
      data.password = await bcrypt.hash(PASSWORD, 10);
    }

    const user = await prisma.user.update({ where: { id: existing.id }, data });

    console.log("");
    console.log("Existing account promoted.");
    console.log("  name    :", user.name);
    console.log("  email   :", user.email);
    console.log("  role    :", user.role, existing.role === "operation" ? "(unchanged)" : "(was " + existing.role + ")");
    console.log("  password:", PASSWORD ? "reset to " + mask(PASSWORD) : "left as it was");
    console.log("");
    console.log("Sign in at /login, then open /operation");
    return;
  }

  if (!PASSWORD) {
    console.error("");
    console.error("No account exists for " + EMAIL + ", so a password is required.");
    console.error("Pass one inline:");
    console.error('  npx tsx prisma/seed-operation.ts "' + NAME + '" ' + EMAIL + " YourStrongPass1");
    console.error("or set OPERATION_PASSWORD in backend/.env and run it again.");
    console.error("");
    process.exit(1);
  }

  if (PASSWORD.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const user = await prisma.user.create({
    data: {
      name: NAME,
      email: EMAIL,
      password: await bcrypt.hash(PASSWORD, 10),
      role: "operation",
      source: "offline",
      notes: "Site content account: home banners and the offer strip.",
    },
  });

  console.log("");
  console.log("Operations account created.");
  console.log("  name    :", user.name);
  console.log("  email   :", user.email);
  console.log("  password:", mask(PASSWORD), "(the one you just passed)");
  console.log("  role    :", user.role);
  console.log("");
  console.log("Sign in at /login, then open /operation");
  console.log("Change the password from Settings after the first sign in.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });