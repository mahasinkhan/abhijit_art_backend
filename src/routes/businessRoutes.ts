// backend/src/routes/businessRoutes.ts
//
// "Shop by business needs" bundles. One tall card per industry, shown as a
// carousel on the home page and as a full grid at /shop-by-business.
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

const bundleFolder = (req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { cloudinaryFolder?: string }).cloudinaryFolder = "avijit-art/business";
  next();
};

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const bool = (v: unknown): boolean => v === true || v === "true" || v === "1" || v === "on";

/** "Cafe & Restaurant" becomes "cafe-restaurant" */
const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** appends -2, -3 and so on until the slug is free */
async function freeSlug(base: string, skipId?: string): Promise<string> {
  const root = base || "bundle";
  let candidate = root;
  for (let n = 2; n < 50; n++) {
    const clash = await prisma.businessBundle.findUnique({ where: { slug: candidate } });
    if (!clash || clash.id === skipId) return candidate;
    candidate = root + "-" + n;
  }
  return root + "-" + Date.now();
}

const ORDERING = [{ order: "asc" as const }, { createdAt: "asc" as const }];

// GET /api/business - public, powers the home carousel and the page
router.get("/", async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.businessBundle.findMany({ where: { active: true }, orderBy: ORDERING });
    res.json(rows);
  } catch (err) {
    console.error("[business] public list failed:", err);
    res.status(500).json({ message: "Failed to load the business bundles" });
  }
});

// GET /api/business/slug/:slug - public, one bundle for a detail page later
router.get("/slug/:slug", async (req: Request, res: Response) => {
  try {
    const row = await prisma.businessBundle.findUnique({ where: { slug: String(req.params.slug) } });
    if (!row || !row.active) {
      res.status(404).json({ message: "Bundle not found" });
      return;
    }
    res.json(row);
  } catch (err) {
    console.error("[business] slug read failed:", err);
    res.status(500).json({ message: "Failed to load the bundle" });
  }
});

// everything below needs an operation or admin token
router.use(protect, operationOnly);

// GET /api/business/all - hidden ones included
router.get("/all", async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.businessBundle.findMany({ orderBy: ORDERING });
    res.json(rows);
  } catch (err) {
    console.error("[business] panel list failed:", err);
    res.status(500).json({ message: "Failed to load the business bundles" });
  }
});

// POST /api/business - multipart upload on field "image"
router.post("/", uploadImage.single("image"), bundleFolder, compressAndUpload, async (req: Request, res: Response) => {
  try {
    const file = req.file as UploadedFile | undefined;
    if (!file?.cloudinaryUrl) {
      res.status(400).json({ message: "An image file is required" });
      return;
    }
    const title = text(req.body?.title);
    if (!title) {
      res.status(400).json({ message: "A title is required" });
      return;
    }
    const slug = await freeSlug(slugify(text(req.body?.slug) || title));
    const last = await prisma.businessBundle.findFirst({ orderBy: { order: "desc" } });

    const row = await prisma.businessBundle.create({
      data: {
        title,
        items: text(req.body?.items),
        imageUrl: file.cloudinaryUrl,
        publicId: file.cloudinaryPublicId ?? "",
        slug,
        href: text(req.body?.href),
        ctaText: text(req.body?.ctaText) || "Explore",
        order: last ? last.order + 1 : 0,
        active: req.body?.active === undefined ? true : bool(req.body.active),
        createdById: req.user?.id ?? null,
      },
    });

    await logAudit({
      req,
      entity: "business",
      action: "business.create",
      entityId: row.id,
      entityRef: row.title,
      summary: "Added business bundle " + row.title,
      detail: { slug: row.slug, imageUrl: row.imageUrl, order: row.order },
    });
    res.status(201).json(row);
  } catch (err) {
    console.error("[business] create failed:", err);
    res.status(500).json({ message: "Failed to create the bundle" });
  }
});

// PATCH /api/business/reorder - MUST stay above "/:id"
router.patch("/reorder", async (req: Request, res: Response) => {
  try {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((v) => typeof v !== "string")) {
      res.status(400).json({ message: "Body must be { ids: string[] }" });
      return;
    }
    await prisma.$transaction(
      (ids as string[]).map((id, i) => prisma.businessBundle.update({ where: { id }, data: { order: i } }))
    );
    const rows = await prisma.businessBundle.findMany({ orderBy: ORDERING });
    await logAudit({
      req,
      entity: "business",
      action: "business.reorder",
      summary: "Reordered " + ids.length + " business bundles",
      detail: { ids },
    });
    res.json(rows);
  } catch (err) {
    console.error("[business] reorder failed:", err);
    res.status(500).json({ message: "Failed to reorder the bundles" });
  }
});

// PATCH /api/business/:id
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const id = String(req.params.id);
    const before = await prisma.businessBundle.findUnique({ where: { id } });
    if (!before) {
      res.status(404).json({ message: "Bundle not found" });
      return;
    }
    if (b.title !== undefined && !text(b.title)) {
      res.status(400).json({ message: "The title cannot be empty" });
      return;
    }

    // a renamed slug has to stay unique, and a blank one falls back to the title
    let slug: string | undefined;
    if (b.slug !== undefined) {
      const wanted = slugify(text(b.slug) || text(b.title) || before.title);
      if (wanted !== before.slug) slug = await freeSlug(wanted, id);
    }

    const row = await prisma.businessBundle.update({
      where: { id },
      data: {
        ...(b.title !== undefined ? { title: text(b.title) } : {}),
        ...(b.items !== undefined ? { items: text(b.items) } : {}),
        ...(slug ? { slug } : {}),
        ...(b.href !== undefined ? { href: text(b.href) } : {}),
        ...(b.ctaText !== undefined ? { ctaText: text(b.ctaText) || "Explore" } : {}),
        ...(b.active !== undefined ? { active: bool(b.active) } : {}),
        ...(typeof b.order === "number" ? { order: b.order } : {}),
      },
    });

    const flipped = before.active !== row.active;
    await logAudit({
      req,
      entity: "business",
      action: flipped ? (row.active ? "business.show" : "business.hide") : "business.update",
      entityId: row.id,
      entityRef: row.title,
      summary: flipped
        ? (row.active ? "Made bundle live: " : "Hid bundle: ") + row.title
        : "Edited bundle " + row.title,
      detail: { before, after: row },
    });
    res.json(row);
  } catch (err) {
    console.error("[business] update failed:", err);
    res.status(500).json({ message: "Failed to update the bundle" });
  }
});

// PUT /api/business/:id/image - swaps the photo, keeps the text
router.put("/:id/image", uploadImage.single("image"), bundleFolder, compressAndUpload, async (req: Request, res: Response) => {
  try {
    const file = req.file as UploadedFile | undefined;
    if (!file?.cloudinaryUrl) {
      res.status(400).json({ message: "An image file is required" });
      return;
    }
    const existing = await prisma.businessBundle.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      res.status(404).json({ message: "Bundle not found" });
      return;
    }
    const row = await prisma.businessBundle.update({
      where: { id: existing.id },
      data: { imageUrl: file.cloudinaryUrl, publicId: file.cloudinaryPublicId ?? "" },
    });
    if (existing.publicId) {
      try {
        await cloudinary.uploader.destroy(existing.publicId, { resource_type: "image" });
      } catch (e) {
        console.warn("[business] old asset not removed from cloudinary:", e);
      }
    }
    await logAudit({
      req,
      entity: "business",
      action: "business.image",
      entityId: row.id,
      entityRef: row.title,
      summary: "Replaced the photo on bundle " + row.title,
      detail: { from: existing.imageUrl, to: row.imageUrl },
    });
    res.json(row);
  } catch (err) {
    console.error("[business] image replace failed:", err);
    res.status(500).json({ message: "Failed to replace the photo" });
  }
});

// DELETE /api/business/:id
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.businessBundle.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      res.status(404).json({ message: "Bundle not found" });
      return;
    }
    await prisma.businessBundle.delete({ where: { id: existing.id } });
    if (existing.publicId) {
      try {
        await cloudinary.uploader.destroy(existing.publicId, { resource_type: "image" });
      } catch (e) {
        console.warn("[business] cloudinary destroy failed:", e);
      }
    }
    await logAudit({
      req,
      entity: "business",
      action: "business.delete",
      entityId: existing.id,
      entityRef: existing.title,
      summary: "Deleted bundle " + existing.title,
      detail: { deleted: existing },
    });
    res.json({ message: "Bundle deleted", id: existing.id });
  } catch (err) {
    console.error("[business] delete failed:", err);
    res.status(500).json({ message: "Failed to delete the bundle" });
  }
});

export default router;