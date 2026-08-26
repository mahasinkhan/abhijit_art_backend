// backend/src/middleware/upload.ts
import multer from "multer";
import path from "path";
import fs from "fs";

const taskImageDir = path.join(process.cwd(), "public", "uploads", "tasks");
if (!fs.existsSync(taskImageDir)) fs.mkdirSync(taskImageDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, taskImageDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `task-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

export const taskUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files allowed"));
  },
});