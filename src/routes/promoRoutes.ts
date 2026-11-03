// backend/src/routes/promoRoutes.ts
//
// The offer strip above the home page banner cards. Owned by the operation
// role (admin passes too). JSON only, no uploads. The public route returns a
// SINGLE strip, the first active row inside its run window, or null when
// nothing is scheduled, so the frontend simply hides the bar.

import { Router, type Request, type Response } from "express";
import { prisma } from "../config/prisma.js";
import { protect, operationOnly } from "../middleware/auth.js";
import { logAudit } from "../utils/security.js";

const router = Router();

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const bool = (v: unknown): boolean => v === true || v === "true" || v === "1" || v === "on";

/** "" / null / "null" clears the date, anything unparseable is treated as blank */
const when = (v: unknown): Date | null => {
  const s = text(v);
  if (!s || s === "null") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** accepts "d9542f" or "#D9542F", blank means use the brand default */
const hex = (v: unknown): string => {
  const s = text(v).replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(s) ? "#" + s.toLowerCase() : "";
};

const ORDERING = [{ order: "asc" as const }, { createdAt: "desc" as const }];

const liveWhere = () => {
  const now = new Date();
  return {
    active: true,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
    ],
  };
};

const refOf = (p: { text: string }) =>
  p.text.length > 48 ? p.text.slice(0, 45) + "..." : p.text || "untitled offer";

// GET /api/promo - public, the one strip to show right now (or null)
router.get("/", async (_req: Request, res: Response) => {
  try {
    const strip = await prisma.promoStrip.findFirst({ where: liveWhere(), orderBy: ORDERING });
    res.json(strip);
  } catch (err) {
    console.error("[promo] public read failed:", err);
    res.status(500).json({ message: "Failed to load the offer strip" });
  }
});

// everything below needs an operation or admin token
router.use(protect, operationOnly);

// GET /api/promo/all - every strip, hidden and scheduled included
router.get("/all", async (_req: Request, res: Response) => {
  try {
    const strips = await prisma.promoStrip.findMany({
      orderBy: [{ order: "asc" }, { createdAt: "desc" }],
    });
    res.json(strips);
  } catch (err) {
    console.error("[promo] panel list failed:", err);
    res.status(500).json({ message: "Failed to load offer strips" });
  }
});

// POST /api/promo - create
router.post("/", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const value = text(body.text);
    if (!value) {
      res.status(400).json({ message: "Offer text is required" });
      return;
    }
    const first = await prisma.promoStrip.findFirst({ orderBy: { order: "asc" } });
    const strip = await prisma.promoStrip.create({
      data: {
        text: value,
        href: text(body.href) || "/services",
        colorFrom: hex(body.colorFrom),
        colorTo: hex(body.colorTo),
        // a new offer goes to the top of the queue, since only the first shows
        order: first ? first.order - 1 : 0,
        active: body.active === undefined ? true : bool(body.active),
        startsAt: when(body.startsAt),
        endsAt: when(body.endsAt),
        createdById: req.user?.id ?? null,
      },
    });
    await logAudit({
      req,
      entity: "promo",
      action: "promo.create",
      entityId: strip.id,
      entityRef: refOf(strip),
      summary: "Created offer strip: " + refOf(strip),
      detail: { strip },
    });
    res.status(201).json(strip);
  } catch (err) {
    console.error("[promo] create failed:", err);
    res.status(500).json({ message: "Failed to create the offer strip" });
  }
});

// PATCH /api/promo/reorder - MUST stay above "/:id"
router.patch("/reorder", async (req: Request, res: Response) => {
  try {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((v) => typeof v !== "string")) {
      res.status(400).json({ message: "Body must be { ids: string[] }" });
      return;
    }
    await prisma.$transaction(
      (ids as string[]).map((id, i) => prisma.promoStrip.update({ where: { id }, data: { order: i } }))
    );
    const strips = await prisma.promoStrip.findMany({
      orderBy: [{ order: "asc" }, { createdAt: "desc" }],
    });
    await logAudit({
      req,
      entity: "promo",
      action: "promo.reorder",
      summary: "Reordered " + ids.length + " offer strips",
      detail: { ids },
    });
    res.json(strips);
  } catch (err) {
    console.error("[promo] reorder failed:", err);
    res.status(500).json({ message: "Failed to reorder offer strips" });
  }
});

// PATCH /api/promo/:id - edit text, link, colours, schedule, visibility
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const id = String(req.params.id);
    const before = await prisma.promoStrip.findUnique({ where: { id } });
    if (!before) {
      res.status(404).json({ message: "Offer strip not found" });
      return;
    }
    if (b.text !== undefined && !text(b.text)) {
      res.status(400).json({ message: "Offer text cannot be empty" });
      return;
    }
    const strip = await prisma.promoStrip.update({
      where: { id },
      data: {
        ...(b.text !== undefined ? { text: text(b.text) } : {}),
        ...(b.href !== undefined ? { href: text(b.href) || "/services" } : {}),
        ...(b.colorFrom !== undefined ? { colorFrom: hex(b.colorFrom) } : {}),
        ...(b.colorTo !== undefined ? { colorTo: hex(b.colorTo) } : {}),
        ...(b.startsAt !== undefined ? { startsAt: when(b.startsAt) } : {}),
        ...(b.endsAt !== undefined ? { endsAt: when(b.endsAt) } : {}),
        ...(b.active !== undefined ? { active: bool(b.active) } : {}),
        ...(typeof b.order === "number" ? { order: b.order } : {}),
      },
    });
    const flipped = before.active !== strip.active;
    await logAudit({
      req,
      entity: "promo",
      action: flipped ? (strip.active ? "promo.show" : "promo.hide") : "promo.update",
      entityId: strip.id,
      entityRef: refOf(strip),
      summary: flipped
        ? (strip.active ? "Made offer strip live: " : "Hid offer strip: ") + refOf(strip)
        : "Edited offer strip " + refOf(strip),
      detail: { before, after: strip },
    });
    res.json(strip);
  } catch (err) {
    console.error("[promo] update failed:", err);
    res.status(500).json({ message: "Failed to update the offer strip" });
  }
});

// DELETE /api/promo/:id
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.promoStrip.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ message: "Offer strip not found" });
      return;
    }
    await prisma.promoStrip.delete({ where: { id } });
    await logAudit({
      req,
      entity: "promo",
      action: "promo.delete",
      entityId: existing.id,
      entityRef: refOf(existing),
      summary: "Deleted offer strip " + refOf(existing),
      detail: { deleted: existing },
    });
    res.json({ message: "Offer strip deleted", id: existing.id });
  } catch (err) {
    console.error("[promo] delete failed:", err);
    res.status(500).json({ message: "Failed to delete the offer strip" });
  }
});

export default router;