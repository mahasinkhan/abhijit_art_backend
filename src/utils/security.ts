// backend/src/utils/security.ts
//
// Shared security + audit helpers. The billing PIN is stored HASHED (bcrypt) in
// the Setting table under key "billing_pin_hash"; sensitive invoice actions
// verify against it. Audit rows are written best-effort so logging can never
// break the action it records.
//
// NOTE: this imports `bcryptjs`. If your auth already uses `bcrypt`, change the
// import to `import bcrypt from "bcrypt"` and skip the install (the hash formats
// are cross-compatible). Otherwise install:
//   npm i bcryptjs && npm i -D @types/bcryptjs

import bcrypt from "bcryptjs";
import type { Request } from "express";
import { prisma } from "../config/prisma.js";

const PIN_KEY = "billing_pin_hash";

/** Has an admin configured the billing PIN yet? */
export async function isPinSet(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: PIN_KEY } });
  return Boolean(row?.value);
}

/** Hash and store a new PIN (overwrites any existing one). */
export async function setPin(pin: string): Promise<void> {
  const hash = await bcrypt.hash(pin, 10);
  await prisma.setting.upsert({
    where: { key: PIN_KEY },
    create: { key: PIN_KEY, value: hash },
    update: { value: hash },
  });
}

/** True only if `pin` matches the stored PIN. False if none set or blank. */
export async function verifyPin(pin: string): Promise<boolean> {
  const clean = String(pin ?? "").trim();
  if (!clean) return false;
  const row = await prisma.setting.findUnique({ where: { key: PIN_KEY } });
  if (!row?.value) return false;
  return bcrypt.compare(clean, row.value);
}

/** Best client IP off a request (proxy-aware). */
function ipOf(req?: Request): string {
  if (!req) return "";
  const fwd = (req.headers?.["x-forwarded-for"] as string | undefined) || "";
  return (fwd.split(",")[0] || (req as any).ip || "").toString().trim();
}

type AuditInput = {
  action: string;            // e.g. "invoice.payment"
  summary: string;           // one-line human description
  entity?: string;           // defaults to "invoice"
  entityId?: string | null;  // the affected record id
  entityRef?: string;        // human handle, e.g. the invoice number
  detail?: unknown;          // structured before/after (stored as JSON)
  req?: Request;             // to capture actor + IP
};

/**
 * Write one audit row. Best-effort: a failure is swallowed (and console-logged)
 * so it can never break the action it was recording.
 */
export async function logAudit(input: AuditInput): Promise<void> {
  try {
    const user = (input.req as any)?.user;
    await prisma.auditLog.create({
      data: {
        action: input.action,
        entity: input.entity || "invoice",
        entityId: input.entityId ?? null,
        entityRef: input.entityRef || "",
        summary: input.summary,
        detail: (input.detail ?? undefined) as any,
        actorId: user?.id ?? null,
        actorName: user?.name || user?.email || "",
        ip: ipOf(input.req),
      },
    });
  } catch (err) {
    console.error("audit log write failed:", err);
  }
}