// backend/src/routes/leadRoutes.ts
import { Router, type Request, type Response } from "express";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";

const router = Router();

/* ── PUBLIC: chatbot lead ── */
router.post("/lead", async (req: Request, res: Response) => {
  try {
    const { name, phone, email, message, page } = req.body ?? {};
    if (!name || (!phone && !email)) {
      return res.status(400).json({ ok: false, message: "Name and a contact are required." });
    }
    const lead = await prisma.lead.create({
      data: {
        name: String(name).trim(),
        phone: String(phone || "").trim(),
        email: String(email || "").trim(),
        message: String(message || "").trim(),
        page: String(page || "").trim(),
      },
    });
    res.status(201).json({ ok: true, id: lead.id });
  } catch {
    res.status(500).json({ ok: false, message: "Could not save. Try again." });
  }
});

/* ── ADMIN ONLY: leads ── */
router.get("/leads", protect, adminOnly, async (_req: Request, res: Response) => {
  try {
    const leads = await prisma.lead.findMany({ orderBy: { createdAt: "desc" }, take: 1000 });
    res.json(leads);
  } catch {
    res.status(500).json({ message: "Failed to fetch leads" });
  }
});

export default router;