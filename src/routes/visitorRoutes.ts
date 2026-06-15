// backend/src/routes/visitorRoutes.ts
import { Router, type Request, type Response } from "express";
import geoip from "geoip-lite";
import { UAParser } from "ua-parser-js";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";

const router = Router();

/* ── PUBLIC: log a visit ── */
router.post("/track", async (req: Request, res: Response) => {
  try {
    const xff = req.headers["x-forwarded-for"];
    let ip = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0].trim()
      || req.socket.remoteAddress || "";
    ip = ip.replace("::ffff:", "");

    const geo = geoip.lookup(ip);
    const ua = new UAParser(req.headers["user-agent"]).getResult();

    const visit = await prisma.visitor.create({
      data: {
        ip,
        city: geo?.city || "",
        region: geo?.region || "",
        country: geo?.country || "",
        page: req.body?.page || "",
        referrer: req.body?.referrer || (req.headers["referer"] as string) || "Direct",
        userAgent: req.headers["user-agent"] || "",
        device: ua.device?.type || "desktop",
        browser: ua.browser?.name || "",
        os: ua.os?.name || "",
      },
    });
    res.status(201).json({ ok: true, id: visit.id });
  } catch {
    res.status(200).json({ ok: false });
  }
});

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

/* ── ADMIN ONLY: all visits ── */
router.get("/", protect, adminOnly, async (_req: Request, res: Response) => {
  try {
    const visitors = await prisma.visitor.findMany({ orderBy: { createdAt: "desc" }, take: 1000 });
    res.json(visitors);
  } catch {
    res.status(500).json({ message: "Failed to fetch visitors" });
  }
});

export default router;