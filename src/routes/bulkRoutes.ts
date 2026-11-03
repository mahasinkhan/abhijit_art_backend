// backend/src/routes/bulkRoutes.ts
//
// Bulk rate cards: "Bulk Visiting Cards, Rs 2 each for 500 pieces".
// Shown on the home page and in full at /bulk-printing.
// Public GET, operation gated writes, Cloudinary cleanup, audit rows.

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

const bulkFolder = (req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { cloudinaryFolder?: string }).cloudinaryFolder = "avijit-art/bulk";
  next();
};

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const bool = (v: unknown): boolean => v === true || v === "true" || v === "1" || v === "on";

/** whole number, never negative, junk becomes the fallback */
const num = (v: unknown, fallback = 0): number => {
  const n = Math.round(Number(typeof v === "string" ? v.replace(/[^\d.-]/g, "") : v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const ORDERING = [{ order: "asc" as const }, { createdAt: "asc" as const }];

// GET /api/bulk - public
router.get("/", async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.bulkItem.findMany({ where: { active: true }, orderBy: ORDERING });
    res.json(rows);
  } catch (err) {
    console.error("[bulk] public list failed:", err);
    res.status(500).json({ message: "Failed to load the bulk rates" });
  }
});

// everything below needs an operation or admin token
router.use(protect, operationOnly);

// GET /api/bulk/all - hidden ones included
router.get("/all", async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.bulkItem.findMany({ orderBy: ORDERING });
    res.json(rows);
  } catch (err) {
    console.error("[bulk] panel list failed:", err);
    res.status(500).json({ message: "Failed to load the bulk rates" });
  }
});

// POST /api/bulk - multipart upload on field "image"
router.post("/", uploadImage.single("image"), bulkFolder, compressAndUpload, async (req: Request, res: Response) => {
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
    const last = await prisma.bulkItem.findFirst({ orderBy: { order: "desc" } });

    const row = await prisma.bulkItem.create({
      data: {
        name,
        imageUrl: file.cloudinaryUrl,
        publicId: file.cloudinaryPublicId ?? "",
        pricePer: num(req.body?.pricePer, 0),
        minQty: num(req.body?.minQty, 100),
        unit: text(req.body?.unit) || "pieces",
        note: text(req.body?.note),
        href: text(req.body?.href) || "/services",
        order: last ? last.order + 1 : 0,
        active: req.body?.active === undefined ? true : bool(req.body.active),
        createdById: req.user?.id ?? null,
      },
    });

    await logAudit({
      req,
      entity: "bulk",
      action: "bulk.create",
      entityId: row.id,
      entityRef: row.name,
      summary: "Added bulk rate " + row.name,
      detail: { pricePer: row.pricePer, minQty: row.minQty, unit: row.unit },
    });
    res.status(201).json(row);
  } catch (err) {
    console.error("[bulk] create failed:", err);
    res.status(500).json({ message: "Failed to create the bulk rate" });
  }
});

// PATCH /api/bulk/reorder - MUST stay above "/:id"
router.patch("/reorder", async (req: Request, res: Response) => {
  try {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((v) => typeof v !== "string")) {
      res.status(400).json({ message: "Body must be { ids: string[] }" });
      return;
    }
    await prisma.$transaction(
      (ids as string[]).map((id, i) => prisma.bulkItem.update({ where: { id }, data: { order: i } }))
    );
    const rows = await prisma.bulkItem.findMany({ orderBy: ORDERING });
    await logAudit({
      req,
      entity: "bulk",
      action: "bulk.reorder",
      summary: "Reordered " + ids.length + " bulk rates",
      detail: { ids },
    });
    res.json(rows);
  } catch (err) {
    console.error("[bulk] reorder failed:", err);
    res.status(500).json({ message: "Failed to reorder the bulk rates" });
  }
});

// PATCH /api/bulk/:id
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const id = String(req.params.id);
    const before = await prisma.bulkItem.findUnique({ where: { id } });
    if (!before) {
      res.status(404).json({ message: "Bulk rate not found" });
      return;
    }
    if (b.name !== undefined && !text(b.name)) {
      res.status(400).json({ message: "The product name cannot be empty" });
      return;
    }

    const row = await prisma.bulkItem.update({
      where: { id },
      data: {
        ...(b.name !== undefined ? { name: text(b.name) } : {}),
        ...(b.pricePer !== undefined ? { pricePer: num(b.pricePer, 0) } : {}),
        ...(b.minQty !== undefined ? { minQty: num(b.minQty, before.minQty) } : {}),
        ...(b.unit !== undefined ? { unit: text(b.unit) || "pieces" } : {}),
        ...(b.note !== undefined ? { note: text(b.note) } : {}),
        ...(b.href !== undefined ? { href: text(b.href) || "/services" } : {}),
        ...(b.active !== undefined ? { active: bool(b.active) } : {}),
        ...(typeof b.order === "number" ? { order: b.order } : {}),
      },
    });

    const flipped = before.active !== row.active;
    await logAudit({
      req,
      entity: "bulk",
      action: flipped ? (row.active ? "bulk.show" : "bulk.hide") : "bulk.update",
      entityId: row.id,
      entityRef: row.name,
      summary: flipped
        ? (row.active ? "Made bulk rate live: " : "Hid bulk rate: ") + row.name
        : "Edited bulk rate " + row.name,
      detail: { before, after: row },
    });
    res.json(row);
  } catch (err) {
    console.error("[bulk] update failed:", err);
    res.status(500).json({ message: "Failed to update the bulk rate" });
  }
});

// PUT /api/bulk/:id/image - swaps the photo, keeps the text
router.put("/:id/image", uploadImage.single("image"), bulkFolder, compressAndUpload, async (req: Request, res: Response) => {
  try {
    const file = req.file as UploadedFile | undefined;
    if (!file?.cloudinaryUrl) {
      res.status(400).json({ message: "An image file is required" });
      return;
    }
    const existing = await prisma.bulkItem.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      res.status(404).json({ message: "Bulk rate not found" });
      return;
    }
    const row = await prisma.bulkItem.update({
      where: { id: existing.id },
      data: { imageUrl: file.cloudinaryUrl, publicId: file.cloudinaryPublicId ?? "" },
    });
    if (existing.publicId) {
      try {
        await cloudinary.uploader.destroy(existing.publicId, { resource_type: "image" });
      } catch (e) {
        console.warn("[bulk] old asset not removed from cloudinary:", e);
      }
    }
    await logAudit({
      req,
      entity: "bulk",
      action: "bulk.image",
      entityId: row.id,
      entityRef: row.name,
      summary: "Replaced the photo on bulk rate " + row.name,
      detail: { from: existing.imageUrl, to: row.imageUrl },
    });
    res.json(row);
  } catch (err) {
    console.error("[bulk] image replace failed:", err);
    res.status(500).json({ message: "Failed to replace the photo" });
  }
});

// DELETE /api/bulk/:id
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.bulkItem.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      res.status(404).json({ message: "Bulk rate not found" });
      return;
    }
    await prisma.bulkItem.delete({ where: { id: existing.id } });
    if (existing.publicId) {
      try {
        await cloudinary.uploader.destroy(existing.publicId, { resource_type: "image" });
      } catch (e) {
        console.warn("[bulk] cloudinary destroy failed:", e);
      }
    }
    await logAudit({
      req,
      entity: "bulk",
      action: "bulk.delete",
      entityId: existing.id,
      entityRef: existing.name,
      summary: "Deleted bulk rate " + existing.name,
      detail: { deleted: existing },
    });
    res.json({ message: "Bulk rate deleted", id: existing.id });
  } catch (err) {
    console.error("[bulk] delete failed:", err);
    res.status(500).json({ message: "Failed to delete the bulk rate" });
  }
});

export default router;