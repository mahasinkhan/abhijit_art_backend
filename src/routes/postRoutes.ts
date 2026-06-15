// backend/src/routes/postRoutes.ts
import { Router, type Request, type Response } from "express";
import { prisma } from "../config/prisma.js";
import { protect } from "../middleware/auth.js";
import { cloudinary, uploadImage, compressAndUpload, uploadVideo } from "../config/cloudinary.js";

const router = Router();

type UploadedFile = Express.Multer.File & {
  cloudinaryUrl?: string;
  cloudinaryPublicId?: string;
  path?: string;
  filename?: string;
};

// GET all posts — public
router.get("/", async (_req: Request, res: Response) => {
  try {
    const posts = await prisma.post.findMany({ orderBy: { createdAt: "desc" } });
    res.json(posts);
  } catch (err) {
    res.status(500).json({ message: (err as Error).message });
  }
});

// POST image — compress first, then upload
router.post(
  "/image",
  protect,
  uploadImage.single("media"),
  compressAndUpload,
  async (req: Request, res: Response) => {
    try {
      if (req.user?.role !== "admin")
        return res.status(403).json({ message: "Admins only" });

      const file = req.file as UploadedFile | undefined;
      if (!file?.cloudinaryUrl)
        return res.status(400).json({ message: "Upload failed" });

      const post = await prisma.post.create({
        data: {
          caption:   req.body.caption || "",
          mediaUrl:  file.cloudinaryUrl,
          mediaType: "image",
          publicId:  file.cloudinaryPublicId!,
        },
      });
      res.status(201).json(post);
    } catch (err) {
      res.status(500).json({ message: (err as Error).message });
    }
  }
);

// POST video — direct to Cloudinary with transcoding
router.post(
  "/video",
  protect,
  uploadVideo.single("media"),
  async (req: Request, res: Response) => {
    try {
      if (req.user?.role !== "admin")
        return res.status(403).json({ message: "Admins only" });

      const file = req.file as UploadedFile | undefined;
      if (!file)
        return res.status(400).json({ message: "No video uploaded" });

      const post = await prisma.post.create({
        data: {
          caption:   req.body.caption || "",
          mediaUrl:  file.path!,
          mediaType: "video",
          publicId:  file.filename!,
        },
      });
      res.status(201).json(post);
    } catch (err) {
      res.status(500).json({ message: (err as Error).message });
    }
  }
);

// DELETE post
router.delete("/:id", protect, async (req: Request, res: Response) => {
  try {
    if (req.user?.role !== "admin")
      return res.status(403).json({ message: "Admins only" });

    const post = await prisma.post.findUnique({ where: { id: String(req.params.id) } });
    if (!post) return res.status(404).json({ message: "Post not found" });

    await cloudinary.uploader.destroy(post.publicId, {
      resource_type: post.mediaType === "video" ? "video" : "image",
    });

    await prisma.post.delete({ where: { id: post.id } });
    res.json({ message: "Post deleted" });
  } catch (err) {
    res.status(500).json({ message: (err as Error).message });
  }
});

export default router;