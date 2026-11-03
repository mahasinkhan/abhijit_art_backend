// backend/src/routes/categoryRoutes.ts
//
// Print categories: the icon rail under the header and the page behind
// each icon at /category/<slug>.
//
// The detail route returns the category together with the print grid tiles
// and bulk rates tagged to it, so the page renders from ONE request instead
// of three. That matters here because this is a first paint on a cold cache.

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

const catFolder = (req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { cloudinaryFolder?: string }).cloudinaryFolder = "avijit-art/categories";
  next();
};

/* custom rail icons live apart from the header photos, they are tiny PNGs */
const iconFolder = (req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { cloudinaryFolder?: string }).cloudinaryFolder = "avijit-art/category-icons";
  next();
};

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const bool = (v: unknown): boolean => v === true || v === "true" || v === "1" || v === "on";

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

async function freeSlug(base: string, skipId?: string): Promise<string> {
  const root = base || "category";
  let candidate = root;
  for (let n = 2; n < 50; n++) {
    const clash = await prisma.printCategory.findUnique({ where: { slug: candidate } });
    if (!clash || clash.id === skipId) return candidate;
    candidate = root + "-" + n;
  }
  return root + "-" + Date.now();
}

const ORDERING = [{ order: "asc" as const }, { createdAt: "asc" as const }];

// GET /api/categories - public, powers the icon rail
router.get("/", async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.printCategory.findMany({ where: { active: true }, orderBy: ORDERING });
    res.json(rows);
  } catch (err) {
    console.error("[categories] public list failed:", err);
    res.status(500).json({ message: "Failed to load the categories" });
  }
});

// GET /api/categories/:slug - public, the category plus everything in it
router.get("/:slug", async (req: Request, res: Response) => {
  try {
    const slug = String(req.params.slug);
    const category = await prisma.printCategory.findUnique({ where: { slug } });
    if (!category || !category.active) {
      res.status(404).json({ message: "Category not found" });
      return;
    }

    const [cards, bulk] = await Promise.all([
      prisma.serviceCard.findMany({
        where: { active: true, category: slug },
        orderBy: ORDERING,
      }),
      prisma.bulkItem.findMany({
        where: { active: true, category: slug },
        orderBy: ORDERING,
      }),
    ]);

    res.json({ category, cards, bulk });
  } catch (err) {
    console.error("[categories] detail failed:", err);
    res.status(500).json({ message: "Failed to load the category" });
  }
});

// everything below needs an operation or admin token
router.use(protect, operationOnly);

// GET /api/categories/admin/all - hidden ones included, with counts
router.get("/admin/all", async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.printCategory.findMany({ orderBy: ORDERING });

    // how many tiles and rates are tagged to each slug, for the panel list
    const [cardGroups, bulkGroups] = await Promise.all([
      prisma.serviceCard.groupBy({ by: ["category"], _count: { _all: true } }),
      prisma.bulkItem.groupBy({ by: ["category"], _count: { _all: true } }),
    ]);
    const cardMap = new Map(cardGroups.map((g) => [g.category, g._count._all]));
    const bulkMap = new Map(bulkGroups.map((g) => [g.category, g._count._all]));

    res.json(
      rows.map((r) => ({
        ...r,
        cardCount: cardMap.get(r.slug) ?? 0,
        bulkCount: bulkMap.get(r.slug) ?? 0,
      }))
    );
  } catch (err) {
    console.error("[categories] panel list failed:", err);
    res.status(500).json({ message: "Failed to load the categories" });
  }
});

// POST /api/categories - image optional here, the rail uses a drawn icon
router.post("/", uploadImage.single("image"), catFolder, compressAndUpload, async (req: Request, res: Response) => {
  try {
    const title = text(req.body?.title);
    if (!title) {
      res.status(400).json({ message: "A title is required" });
      return;
    }
    const file = req.file as UploadedFile | undefined;
    const slug = await freeSlug(slugify(text(req.body?.slug) || title));
    const last = await prisma.printCategory.findFirst({ orderBy: { order: "desc" } });

    const row = await prisma.printCategory.create({
      data: {
        title,
        slug,
        icon: text(req.body?.icon),
        blurb: text(req.body?.blurb),
        points: text(req.body?.points),
        imageUrl: file?.cloudinaryUrl ?? "",
        publicId: file?.cloudinaryPublicId ?? "",
        order: last ? last.order + 1 : 0,
        active: req.body?.active === undefined ? true : bool(req.body.active),
        createdById: req.user?.id ?? null,
      },
    });

    await logAudit({
      req,
      entity: "category",
      action: "category.create",
      entityId: row.id,
      entityRef: row.title,
      summary: "Added category " + row.title,
      detail: { slug: row.slug },
    });
    res.status(201).json(row);
  } catch (err) {
    console.error("[categories] create failed:", err);
    res.status(500).json({ message: "Failed to create the category" });
  }
});

// PATCH /api/categories/reorder - MUST stay above "/:id"
router.patch("/reorder", async (req: Request, res: Response) => {
  try {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((v) => typeof v !== "string")) {
      res.status(400).json({ message: "Body must be { ids: string[] }" });
      return;
    }
    await prisma.$transaction(
      (ids as string[]).map((id, i) => prisma.printCategory.update({ where: { id }, data: { order: i } }))
    );
    const rows = await prisma.printCategory.findMany({ orderBy: ORDERING });
    await logAudit({
      req,
      entity: "category",
      action: "category.reorder",
      summary: "Reordered " + ids.length + " categories",
      detail: { ids },
    });
    res.json(rows);
  } catch (err) {
    console.error("[categories] reorder failed:", err);
    res.status(500).json({ message: "Failed to reorder the categories" });
  }
});

// PATCH /api/categories/:id
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const id = String(req.params.id);
    const before = await prisma.printCategory.findUnique({ where: { id } });
    if (!before) {
      res.status(404).json({ message: "Category not found" });
      return;
    }
    if (b.title !== undefined && !text(b.title)) {
      res.status(400).json({ message: "The title cannot be empty" });
      return;
    }

    /* a renamed slug orphans every tile tagged with the old one, so the
       tags are rewritten in the same transaction */
    let slug: string | undefined;
    if (b.slug !== undefined) {
      const wanted = slugify(text(b.slug) || text(b.title) || before.title);
      if (wanted !== before.slug) slug = await freeSlug(wanted, id);
    }

    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.printCategory.update({
        where: { id },
        data: {
          ...(b.title !== undefined ? { title: text(b.title) } : {}),
          ...(b.icon !== undefined ? { icon: text(b.icon) } : {}),
          ...(b.blurb !== undefined ? { blurb: text(b.blurb) } : {}),
          ...(b.points !== undefined ? { points: text(b.points) } : {}),
          ...(slug ? { slug } : {}),
          ...(b.active !== undefined ? { active: bool(b.active) } : {}),
          ...(typeof b.order === "number" ? { order: b.order } : {}),
        },
      });
      if (slug) {
        await tx.serviceCard.updateMany({ where: { category: before.slug }, data: { category: slug } });
        await tx.bulkItem.updateMany({ where: { category: before.slug }, data: { category: slug } });
      }
      return updated;
    });

    const flipped = before.active !== row.active;
    await logAudit({
      req,
      entity: "category",
      action: flipped ? (row.active ? "category.show" : "category.hide") : "category.update",
      entityId: row.id,
      entityRef: row.title,
      summary: flipped
        ? (row.active ? "Made category live: " : "Hid category: ") + row.title
        : "Edited category " + row.title,
      detail: { before, after: row, slugMoved: Boolean(slug) },
    });
    res.json(row);
  } catch (err) {
    console.error("[categories] update failed:", err);
    res.status(500).json({ message: "Failed to update the category" });
  }
});

// PUT /api/categories/:id/image - the optional page header photo
router.put("/:id/image", uploadImage.single("image"), catFolder, compressAndUpload, async (req: Request, res: Response) => {
  try {
    const file = req.file as UploadedFile | undefined;
    if (!file?.cloudinaryUrl) {
      res.status(400).json({ message: "An image file is required" });
      return;
    }
    const existing = await prisma.printCategory.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      res.status(404).json({ message: "Category not found" });
      return;
    }
    const row = await prisma.printCategory.update({
      where: { id: existing.id },
      data: { imageUrl: file.cloudinaryUrl, publicId: file.cloudinaryPublicId ?? "" },
    });
    if (existing.publicId) {
      try {
        await cloudinary.uploader.destroy(existing.publicId, { resource_type: "image" });
      } catch (e) {
        console.warn("[categories] old asset not removed from cloudinary:", e);
      }
    }
    await logAudit({
      req,
      entity: "category",
      action: "category.image",
      entityId: row.id,
      entityRef: row.title,
      summary: "Replaced the photo on category " + row.title,
      detail: { from: existing.imageUrl, to: row.imageUrl },
    });
    res.json(row);
  } catch (err) {
    console.error("[categories] image replace failed:", err);
    res.status(500).json({ message: "Failed to replace the photo" });
  }
});

// PUT /api/categories/:id/icon - upload a custom rail icon
router.put("/:id/icon", uploadImage.single("image"), iconFolder, compressAndUpload, async (req: Request, res: Response) => {
  try {
    const file = req.file as UploadedFile | undefined;
    if (!file?.cloudinaryUrl) {
      res.status(400).json({ message: "An image file is required" });
      return;
    }
    const existing = await prisma.printCategory.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      res.status(404).json({ message: "Category not found" });
      return;
    }
    const row = await prisma.printCategory.update({
      where: { id: existing.id },
      data: { iconUrl: file.cloudinaryUrl, iconPublicId: file.cloudinaryPublicId ?? "" },
    });
    if (existing.iconPublicId) {
      try {
        await cloudinary.uploader.destroy(existing.iconPublicId, { resource_type: "image" });
      } catch (e) {
        console.warn("[categories] old icon not removed from cloudinary:", e);
      }
    }
    await logAudit({
      req,
      entity: "category",
      action: "category.icon",
      entityId: row.id,
      entityRef: row.title,
      summary: "Uploaded a custom icon for " + row.title,
      detail: { iconUrl: row.iconUrl },
    });
    res.json(row);
  } catch (err) {
    console.error("[categories] icon upload failed:", err);
    res.status(500).json({ message: "Failed to upload the icon" });
  }
});

// DELETE /api/categories/:id/icon - drop back to the drawn icons
router.delete("/:id/icon", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.printCategory.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      res.status(404).json({ message: "Category not found" });
      return;
    }
    const row = await prisma.printCategory.update({
      where: { id: existing.id },
      data: { iconUrl: "", iconPublicId: "" },
    });
    if (existing.iconPublicId) {
      try {
        await cloudinary.uploader.destroy(existing.iconPublicId, { resource_type: "image" });
      } catch (e) {
        console.warn("[categories] icon destroy failed:", e);
      }
    }
    await logAudit({
      req,
      entity: "category",
      action: "category.icon",
      entityId: row.id,
      entityRef: row.title,
      summary: "Removed the custom icon from " + row.title,
    });
    res.json(row);
  } catch (err) {
    console.error("[categories] icon remove failed:", err);
    res.status(500).json({ message: "Failed to remove the icon" });
  }
});

// DELETE /api/categories/:id - tagged items are untagged, never deleted
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const existing = await prisma.printCategory.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      res.status(404).json({ message: "Category not found" });
      return;
    }

    const [cards, bulk] = await prisma.$transaction([
      prisma.serviceCard.updateMany({ where: { category: existing.slug }, data: { category: "" } }),
      prisma.bulkItem.updateMany({ where: { category: existing.slug }, data: { category: "" } }),
    ]);
    await prisma.printCategory.delete({ where: { id: existing.id } });

    for (const pid of [existing.publicId, existing.iconPublicId]) {
      if (!pid) continue;
      try {
        await cloudinary.uploader.destroy(pid, { resource_type: "image" });
      } catch (e) {
        console.warn("[categories] cloudinary destroy failed:", e);
      }
    }

    await logAudit({
      req,
      entity: "category",
      action: "category.delete",
      entityId: existing.id,
      entityRef: existing.title,
      summary:
        "Deleted category " + existing.title +
        ", untagged " + cards.count + " tiles and " + bulk.count + " bulk rates",
      detail: { deleted: existing, untaggedCards: cards.count, untaggedBulk: bulk.count },
    });
    res.json({
      message: "Category deleted",
      id: existing.id,
      untaggedCards: cards.count,
      untaggedBulk: bulk.count,
    });
  } catch (err) {
    console.error("[categories] delete failed:", err);
    res.status(500).json({ message: "Failed to delete the category" });
  }
});

export default router;