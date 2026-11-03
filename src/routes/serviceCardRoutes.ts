// backend/src/routes/serviceCardRoutes.ts
//
// The "what we print" product grid under the hero. Photo, name, from-price
// and an optional badge per tile. Uploaded by the operation role, read by
// anyone. Mirrors heroRoutes: public GET, token gated writes, Cloudinary
// cleanup on replace and delete, audit rows on every write.

import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "../config/prisma.js";
import { protect, operationOnly } from "../middleware/auth.js";
import { cloudinary, uploadImage, compressAndUpload } from "../config/cloudinary.js";
import { logAudit } from "../utils/security.js";

const router = Router();

type UploadedFile = Express.Multer.File & {
  cloudinaryUrl?: string;
  cloudinaryPublicId?: string;
};

// product tiles get their own Cloudinary folder
const cardFolder = (req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { cloudinaryFolder?: string }).cloudinaryFolder = "avijit-art/cards";
  next();
};

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const bool = (v: unknown): boolean => v === true || v === "true" || v === "1" || v === "on";

/** whole rupees, never negative, anything unparseable becomes 0 */
const money = (v: unknown): number => {
  const n = Math.round(Number(typeof v === "string" ? v.replace(/[^\d.-]/g, "") : v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const ORDERING = [{ order: "asc" as const }, { createdAt: "asc" as const }];

// GET /api/cards - public, powers the home grid
router.get("/", async (_req: Request, res: Response) => {
  try {
    const cards = await prisma.serviceCard.findMany({ where: { active: true }, orderBy: ORDERING });
    res.json(cards);
  } catch (err) {
    console.error("[cards] public list failed:", err);
    res.status(500).json({ message: "Failed to load the print grid" });
  }
});

// everything below needs an operation or admin token
router.use(protect, operationOnly);

// GET /api/cards/all - hidden tiles included
router.get("/all", async (_req: Request, res: Response) => {
  try {
    const cards = await prisma.serviceCard.findMany({ orderBy: ORDERING });
    res.json(cards);
  } catch (err) {
    console.error("[cards] panel list failed:", err);
    res.status(500).json({ message: "Failed to load the print grid" });
  }
});

// POST /api/cards - multipart upload on field "image"
router.post("/", uploadImage.single("image"), cardFolder, compressAndUpload, async (req: Request, res: Response) => {
  try {
    const file = req.file as UploadedFile | undefined;
    if (!file?.cloudinaryUrl) {
      res.status(400).json({ message: "An image file is required" });
      return;
    }
    const name = text(req.body?.name);
    if (!name) {
      res.status(400).json({ message: "A product name is required" });
      return;
    }
    const last = await prisma.serviceCard.findFirst({ orderBy: { order: "desc" } });
    const card = await prisma.serviceCard.create({
      data: {
        name,
        caption: text(req.body?.caption),
        imageUrl: file.cloudinaryUrl,
        publicId: file.cloudinaryPublicId ?? "",
        href: text(req.body?.href) || "/services",
        priceFrom: money(req.body?.priceFrom),
        badge: text(req.body?.badge),
        order: last ? last.order + 1 : 0,
        active: req.body?.active === undefined ? true : bool(req.body.active),
        createdById: req.user?.id ?? null,
      },
    });
    await logAudit({
      req,
      entity: "card",
      action: "card.create",
      entityId: card.id,
      entityRef: card.name,
      summary: "Added print grid tile " + card.name,
      detail: { imageUrl: card.imageUrl, priceFrom: card.priceFrom, order: card.order },
    });
    res.status(201).json(card);
  } catch (err) {
    console.error("[cards] create failed:", err);
    res.status(500).json({ message: "Failed to create the tile" });
  }
});

// PATCH /api/cards/reorder - MUST stay above "/:id"
router.patch("/reorder", async (req: Request, res: Response) => {
  try {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((v) => typeof v !== "string")) {
      res.status(400).json({ message: "Body must be { ids: string[] }" });
      return;
    }
    await prisma.$transaction(
      (ids as string[]).map((id, i) => prisma.serviceCard.update({ where: { id }, data: { order: i } }))
    );
    const cards = await prisma.serviceCard.findMany({ orderBy: ORDERING });
    await logAudit({
      req,
      entity: "card",
      action: "card.reorder",
      summary: "Reordered " + ids.length + " print grid tiles",
      detail: { ids },
    });
    res.json(cards);
  } catch (err) {
    console.error("[cards] reorder failed:", err);
    res.status(500).json({ message: "Failed to reorder the tiles" });
  }
});

// PATCH /api/cards/:id - name, caption, link, price, badge, visibility
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const id = String(req.params.id);
    const before = await prisma.serviceCard.findUnique({ where: { id } });
    if (!before) {
      res.status(404).json({ message: "Tile not found" });
      return;
    }
    if (b.name !== undefined && !text(b.name)) {
      res.status(400).json({ message: "The product name cannot be empty" });
      return;
    }
    const card = await prisma.serviceCard.update({
      where: { id },
      data: {
        ...(b.name !== undefined ? { name: text(b.name) } : {}),
        ...(b.caption !== undefined ? { caption: text(b.caption) } : {}),
        ...(b.href !== undefined ? { href: text(b.href) || "/services" } : {}),
        ...(b.priceFrom !== undefined ? { priceFrom: money(b.priceFrom) } : {}),
        ...(b.badge !== undefined ? { badge: text(b.badge) } : {}),
        ...(b.active !== undefined ? { active: bool(b.active) } : {}),
        ...(typeof b.order === "number" ? { order: b.order } : {}),
      },
    });
    const flipped = before.active !== card.active;
    await logAudit({
      req,
      entity: "card",
      action: flipped ? (card.active ? "card.show" : "card.hide") : "card.update",
      entityId: card.id,
      entityRef: card.name,
      summary: flipped
        ? (card.active ? "Made tile live: " : "Hid tile: ") + card.name
        : "Edited tile " + card.name,
      detail: { before, after: card },
    });
    res.json(card);
  } catch (err) {
    console.error("[cards] update failed:", err);
    res.status(500).json({ message: "Failed to update the tile" });
  }
});

// PUT /api/cards/:id/image - swaps the photo, keeps the text
router.put("/:id/image", uploadImage.single("image"), cardFolder, compressAndUpload, async (req: Request, res: Response) => {
  try {
    const file = req.file as UploadedFile | undefined;
    if (!file?.cloudinaryUrl) {
      res.status(400).json({ message: "An image file is required" });
      return;
    }
    const existing = await prisma.serviceCard.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      res.status(404).json({ message: "Tile not found" });
      return;
    }
    const card = await prisma.serviceCard.update({
      where: { id: existing.id },
      data: { imageUrl: file.cloudinaryUrl, publicId: file.cloudinaryPublicId ?? "" },
    });
    if (existing.publicId) {
      try {
        await cloudinary.uploader.destroy(existing.publicId, { resource_type: "image" });
      } catch (e) {
        console.warn("[cards] old asset not removed from cloudinary:", e);
      }
    }
    await logAudit({
      req,
      entity: "card",
      action: "card.image",
      entityId: card.id,
      entityRef: card.name,
      summary: "Replaced the photo on tile " + card.name,
      detail: { from: existing.imageUrl, to: card.imageUrl },
    });
    res.json(card);
  } catch (err) {
    console.error("[cards] image replace failed:", err);
    res.status(500).json({ message: "Failed to replace the photo" });
  }
});

// DELETE /api/cards/:id - also drops the cloudinary asset
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.serviceCard.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      res.status(404).json({ message: "Tile not found" });
      return;
    }
    await prisma.serviceCard.delete({ where: { id: existing.id } });
    if (existing.publicId) {
      try {
        await cloudinary.uploader.destroy(existing.publicId, { resource_type: "image" });
      } catch (e) {
        console.warn("[cards] cloudinary destroy failed:", e);
      }
    }
    await logAudit({
      req,
      entity: "card",
      action: "card.delete",
      entityId: existing.id,
      entityRef: existing.name,
      summary: "Deleted tile " + existing.name,
      detail: { deleted: existing },
    });
    res.json({ message: "Tile deleted", id: existing.id });
  } catch (err) {
    console.error("[cards] delete failed:", err);
    res.status(500).json({ message: "Failed to delete the tile" });
  }
});

export default router;