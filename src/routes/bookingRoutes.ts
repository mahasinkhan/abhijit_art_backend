// backend/src/routes/bookingRoutes.ts
import { Router, type Request, type Response } from "express";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";

const router = Router();
const userPublic = { select: { name: true, email: true, phone: true } };

router.post("/", protect, async (req: Request, res: Response) => {
  try {
    const {
      serviceId,
      quantity,
      notes,
      contactPhone,
      deliveryMethod,
      address,
      preferredDate,
      designLink,
    } = req.body;

    const service = await prisma.service.findUnique({ where: { id: serviceId } });
    if (!service) return res.status(404).json({ message: "Service not found" });

    // coerce quantity to an integer (frontend sends it as a string)
    const qty = parseInt(String(quantity), 10);

    // normalise delivery method to "pickup" | "delivery"
    const method = deliveryMethod === "delivery" ? "delivery" : "pickup";

    // preferredDate arrives as a string like "2026-06-18" — Prisma needs a Date
    let when: Date | null = null;
    if (preferredDate) {
      const d = new Date(preferredDate);
      if (!isNaN(d.getTime())) when = d;
    }

    const booking = await prisma.booking.create({
      data: {
        userId: req.user!.id,
        serviceId: service.id,
        serviceName: service.name,
        quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
        notes: notes || "",
        contactPhone: contactPhone || req.user!.phone || "",
        deliveryMethod: method,
        address: method === "delivery" ? (address || "") : "",
        preferredDate: when,
        designLink: designLink || "",
      },
    });
    res.status(201).json(booking);
  } catch (err) {
    console.error("Booking create error:", err); // 👈 logs the real cause to your terminal
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/mine", protect, async (req: Request, res: Response) => {
  const bookings = await prisma.booking.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(bookings);
});

router.get("/", protect, adminOnly, async (_req: Request, res: Response) => {
  const bookings = await prisma.booking.findMany({
    include: { user: userPublic },
    orderBy: { createdAt: "desc" },
  });
  res.json(bookings);
});

router.patch("/:id/status", protect, adminOnly, async (req: Request, res: Response) => {
  const booking = await prisma.booking.update({
    where: { id: req.params.id },
    data: { status: req.body.status },
    include: { user: userPublic },
  });
  res.json(booking);
});

export default router;