// backend/config/cloudinary.ts
import dotenv from "dotenv";
dotenv.config(); // ✅ load .env BEFORE cloudinary.config() reads it

import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import multer, { type FileFilterCallback } from "multer";
import type { Request } from "express";
import sharp from "sharp";
import { Readable } from "stream";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const memoryStorage = multer.memoryStorage();

export const uploadImage = multer({
  storage: memoryStorage,
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    if (!file.mimetype.startsWith("image/"))
      return cb(new Error("Images only"));
    cb(null, true);
  },
});

export const compressAndUpload = async (
  req: Request,
  _res: unknown,
  next: (err?: unknown) => void
): Promise<void> => {
  if (!req.file) return next();

  try {
    const compressed = await sharp(req.file.buffer)
      .resize({ width: 1080, withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();

    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder:        "avijit-art/posts",
          resource_type: "image",
          format:        "webp",
          eager: [
            { width: 800, crop: "limit", quality: "auto:good", fetch_format: "auto" },
          ],
          eager_async: true,
        },
        (error, uploaded) => {
          if (error || !uploaded) reject(error);
          else resolve(uploaded);
        }
      );
      Readable.from(compressed).pipe(stream);
    });

    // attach to the file object (extra props)
    (req.file as Express.Multer.File & { cloudinaryUrl?: string; cloudinaryPublicId?: string }).cloudinaryUrl = result.secure_url;
    (req.file as Express.Multer.File & { cloudinaryUrl?: string; cloudinaryPublicId?: string }).cloudinaryPublicId = result.public_id;
    next();
  } catch (err) {
    next(err);
  }
};

const videoStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:        "avijit-art/posts/videos",
    resource_type: "video",
    eager: [
      {
        width:       1280,
        height:      720,
        crop:        "limit",
        quality:     "auto:low",
        video_codec: "h264",
        audio_codec: "aac",
        bit_rate:    "500k",
      },
    ],
    eager_async: true,
  } as Record<string, unknown>,
});

export const uploadVideo = multer({
  storage: videoStorage,
  limits:  { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    if (!file.mimetype.startsWith("video/"))
      return cb(new Error("Videos only"));
    cb(null, true);
  },
});

export { cloudinary };