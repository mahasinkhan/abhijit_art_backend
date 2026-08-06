// backend/src/routes/securityRoutes.ts
import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs"; // match your auth's bcrypt — see utils/security.ts note
import { protect, adminOnly } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import { isPinSet, setPin, verifyPin } from "../utils/security.js";

const router = Router();

/* admin-only: PIN management + the audit trail are staff-only */
router.use(protect, adminOnly);

const str = (v: unknown) => String(v ?? "").trim();

/* GET /api/security/status — is a billing PIN configured? (drives the UI) */
router.get("/status", async (_req: Request, res: Response) => {
  try {
    res.json({ pinSet: await isPinSet() });
  } catch (err) {
    console.error("security status failed:", err);
    res.status(500).json({ message: "Couldn't read the security status." });
  }
});

/* POST /api/security/pin — set or change the billing PIN.
     First-time setup  → confirm with the admin ACCOUNT password (bootstrap).
     Changing existing → require the CURRENT PIN.
   Body: { newPin, currentPin?, password? } */
router.post("/pin", async (req: Request, res: Response) => {
  try {
    const newPin = str(req.body.newPin);
    if (newPin.length < 6) {
      return res.status(400).json({ message: "PIN must be at least 6 digits." });
    }

    if (await isPinSet()) {
      // changing → must know the current PIN
      if (!(await verifyPin(str(req.body.currentPin)))) {
        return res.status(403).json({ message: "The current PIN is incorrect." });
      }
    } else {
      // first-time → confirm identity with the account password
      const me = await prisma.user.findUnique({ where: { id: (req as any).user?.id } });
      if (!me || !(await bcrypt.compare(str(req.body.password), me.password))) {
        return res.status(403).json({ message: "Your account password is incorrect." });
      }
    }

    await setPin(newPin);
    res.json({ ok: true });
  } catch (err) {
    console.error("set PIN failed:", err);
    res.status(500).json({ message: "Couldn't save the PIN." });
  }
});

/* GET /api/security/audit — the audit trail, newest first.
   Query: ?limit=(1–500, default 100)  ?action=(exact match, optional) */
router.get("/audit", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(str(req.query.limit), 10) || 100, 1), 500);
    const action = str(req.query.action);
    const logs = await prisma.auditLog.findMany({
      where: action ? { action } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    res.json(logs);
  } catch (err) {
    console.error("audit list failed:", err);
    res.status(500).json({ message: "Couldn't load the activity log." });
  }
});

export default router;