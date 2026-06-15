// backend/src/config/prisma.ts
import { PrismaClient } from "@prisma/client";

// Reuse one client across tsx hot-reloads (avoids exhausting DB connections)
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;