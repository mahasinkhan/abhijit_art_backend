// backend/src/routes/heroRoutes.ts
import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";
import { cloudinary, uploadImage, compressAndUpload } from "../config/cloudinary.js";

const router = Router();

type UploadedFile = Express.Multer.File & {
  cloudinaryUrl?: string;
  cloudinaryPublicId?: string;
};

// hero art gets its own Cloudinary folder instead of sharing the posts one
const heroFolder = (req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { cloudinaryFolder?: string }).cloudinaryFolder = "avijit-art/hero";
  next();
};

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const bool = (v: unknown): boolean => v === true || v === "true" || v === "1" || v === "on";
const ORDERING = [{ order: "asc" as const }, { createdAt: "asc" as const }];

// GET /api/hero - public, powers the homepage hero
router.get("/", async (_req: Request, res: Response) => {
  try {
    const slides = await prisma.heroSlide.findMany({ where: { active: true }, orderBy: ORDERING });
    res.json(slides);
  } catch (err) {
    console.error("[hero] public list failed:", err);
    res.status(500).json({ message: "Failed to load hero slides" });
  }
});

// everything below needs an admin token
router.use(protect, adminOnly);

// GET /api/hero/all - admin, hidden slides included
router.get("/all", async (_req: Request, res: Response) => {
  try {
    const slides = await prisma.heroSlide.findMany({ orderBy: ORDERING });
    res.json(slides);
  } catch (err) {
    console.error("[hero] admin list failed:", err);
    res.status(500).json({ message: "Failed to load hero slides" });
  }
});

// POST /api/hero - admin, multipart upload on field "image"
router.post("/", uploadImage.single("image"), heroFolder, compressAndUpload, async (req: Request, res: Response) => {
  try {
    const file = req.file as UploadedFile | undefined;
    if (!file?.cloudinaryUrl) {
      res.status(400).json({ message: "An image file is required" });
      return;
    }
    const last = await prisma.heroSlide.findFirst({ orderBy: { order: "desc" } });
    const slide = await prisma.heroSlide.create({
      data: {
        imageUrl: file.cloudinaryUrl,
        publicId: file.cloudinaryPublicId ?? "",
        alt: text(req.body?.alt),
        eyebrow: text(req.body?.eyebrow),
        titleTop: text(req.body?.titleTop),
        titleBottom: text(req.body?.titleBottom),
        subtitle: text(req.body?.subtitle),
        order: last ? last.order + 1 : 0,
        active: req.body?.active === undefined ? true : bool(req.body.active),
      },
    });
    res.status(201).json(slide);
  } catch (err) {
    console.error("[hero] create failed:", err);
    res.status(500).json({ message: "Failed to create hero slide" });
  }
});

// PATCH /api/hero/reorder - MUST stay above "/:id" or Express matches id="reorder"
router.patch("/reorder", async (req: Request, res: Response) => {
  try {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((v) => typeof v !== "string")) {
      res.status(400).json({ message: "Body must be { ids: string[] }" });
      return;
    }
    await prisma.$transaction(
      (ids as string[]).map((id, i) => prisma.heroSlide.update({ where: { id }, data: { order: i } }))
    );
    const slides = await prisma.heroSlide.findMany({ orderBy: ORDERING });
    res.json(slides);
  } catch (err) {
    console.error("[hero] reorder failed:", err);
    res.status(500).json({ message: "Failed to reorder hero slides" });
  }
});

// PATCH /api/hero/:id - admin, edits caption text and visibility (JSON body)
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const slide = await prisma.heroSlide.update({
      where: { id: String(req.params.id) },
      data: {
        ...(b.alt !== undefined ? { alt: text(b.alt) } : {}),
        ...(b.eyebrow !== undefined ? { eyebrow: text(b.eyebrow) } : {}),
        ...(b.titleTop !== undefined ? { titleTop: text(b.titleTop) } : {}),
        ...(b.titleBottom !== undefined ? { titleBottom: text(b.titleBottom) } : {}),
        ...(b.subtitle !== undefined ? { subtitle: text(b.subtitle) } : {}),
        ...(b.active !== undefined ? { active: bool(b.active) } : {}),
        ...(typeof b.order === "number" ? { order: b.order } : {}),
      },
    });
    res.json(slide);
  } catch (err) {
    console.error("[hero] update failed:", err);
    res.status(404).json({ message: "Hero slide not found" });
  }
});

// PUT /api/hero/:id/image - admin, swaps the photo and keeps the caption
router.put("/:id/image", uploadImage.single("image"), heroFolder, compressAndUpload, async (req: Request, res: Response) => {
  try {
    const file = req.file as UploadedFile | undefined;
    if (!file?.cloudinaryUrl) {
      res.status(400).json({ message: "An image file is required" });
      return;
    }
    const existing = await prisma.heroSlide.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      res.status(404).json({ message: "Hero slide not found" });
      return;
    }
    const slide = await prisma.heroSlide.update({
      where: { id: existing.id },
      data: { imageUrl: file.cloudinaryUrl, publicId: file.cloudinaryPublicId ?? "" },
    });
    if (existing.publicId) {
      try {
        await cloudinary.uploader.destroy(existing.publicId, { resource_type: "image" });
      } catch (e) {
        console.warn("[hero] old asset not removed from cloudinary:", e);
      }
    }
    res.json(slide);
  } catch (err) {
    console.error("[hero] image replace failed:", err);
    res.status(500).json({ message: "Failed to replace hero image" });
  }
});

// DELETE /api/hero/:id - admin, also drops the cloudinary asset
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.heroSlide.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      res.status(404).json({ message: "Hero slide not found" });
      return;
    }
    await prisma.heroSlide.delete({ where: { id: existing.id } });
    if (existing.publicId) {
      try {
        await cloudinary.uploader.destroy(existing.publicId, { resource_type: "image" });
      } catch (e) {
        console.warn("[hero] cloudinary destroy failed:", e);
      }
    }
    res.json({ message: "Hero slide deleted", id: existing.id });
  } catch (err) {
    console.error("[hero] delete failed:", err);
    res.status(500).json({ message: "Failed to delete hero slide" });
  }
});

export default router;
