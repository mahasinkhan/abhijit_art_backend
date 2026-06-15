// backend/src/routes/serviceRoutes.ts
import { Router, type Request, type Response } from "express";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  const services = await prisma.service.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
  });
  res.json(services);
});

router.post("/", protect, adminOnly, async (req: Request, res: Response) => {
  const { name, description, priceFrom, icon, active } = req.body;
  const service = await prisma.service.create({
    data: { name, description, priceFrom, icon, active },
  });
  res.status(201).json(service);
});

export default router;