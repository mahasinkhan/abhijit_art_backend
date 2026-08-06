// backend/src/routes/bookingRoutes.ts
import { Router, type Request, type Response } from "express";
import type { BookingStatus } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { protect, adminOnly } from "../middleware/auth.js";

const router = Router();
const userPublic = { select: { name: true, email: true, phone: true } };

/* Prisma serialises Decimal columns as STRINGS. unitRate / discountValue /
   taxPercent are Decimals, so anything doing arithmetic on them client-side
   would break (the "v.toFixed is not a function" class of bug). Coerce on the
   way out so every consumer gets real numbers. */
const toNumOrNull = (v: unknown) => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const serializeBooking = <T extends Record<string, any>>(b: T) => ({
  ...b,
  unitRate: toNumOrNull(b.unitRate),
  discountValue: toNumOrNull(b.discountValue),
  taxPercent: toNumOrNull(b.taxPercent),
});

router.post("/", protect, async (req: Request, res: Response) => {
  try {
    const {
      serviceId,
      serviceName,
      service, // some clients send the whole object, or an id string
      id, // ...or just `id`
      quantity,
      notes,
      contactPhone,
      deliveryMethod,
      address,
      preferredDate,
      designLink,
    } = req.body;

    // ── resolve the service from whatever the client actually sent ──
    // an id may arrive as: serviceId | id | service (string) | service.id | service._id
    const refId =
      serviceId ??
      id ??
      (typeof service === "string" ? service : service?.id ?? service?._id) ??
      null;
    // a name may arrive as: serviceName | service.name
    const refName =
      serviceName ?? (service && typeof service === "object" ? service?.name : null) ?? null;

    let svc = null;
    if (refId) {
      svc = await prisma.service.findUnique({ where: { id: String(refId) } });
    }
    if (!svc && refName) {
      svc = await prisma.service.findFirst({
        where: { name: { equals: String(refName), mode: "insensitive" } },
      });
    }
    // If the name matched no service row (e.g. a Home category like
    // "Signage & Branding"), still record the request by name and leave the
    // service relation unlinked. Requires Booking.serviceId to be OPTIONAL.
    const finalName = svc?.name ?? (refName ? String(refName) : null);
    if (!finalName) {
      console.warn("Booking rejected — no service name/id sent. body keys:", Object.keys(req.body), {
        refId,
        refName,
      });
      return res.status(400).json({ message: "No service specified for this booking." });
    }

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
        serviceId: svc?.id ?? null,
        serviceName: finalName,
        quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
        notes: notes || "",
        contactPhone: contactPhone || req.user!.phone || "",
        deliveryMethod: method,
        address: method === "delivery" ? address || "" : "",
        preferredDate: when,
        designLink: designLink || "",
      },
    });
    res.status(201).json(serializeBooking(booking));
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
  res.json(bookings.map(serializeBooking));
});

router.get("/", protect, adminOnly, async (_req: Request, res: Response) => {
  const bookings = await prisma.booking.findMany({
    include: { user: userPublic },
    orderBy: { createdAt: "desc" },
  });
  res.json(bookings.map(serializeBooking));
});

/* ── status change ─────────────────────────────────────────────
   RULE: a booking cannot be moved to "confirmed" or "completed"
   until the order's total value is set. The admin dashboard sends
   { status, totalAmount } together when confirming; if a total is
   already stored on the booking, status alone is enough.
   totalAmount may also be sent on its own alongside any status to
   correct a previously entered value.

   PRICE BREAKDOWN: the admin's confirm dialog also sends how the
   total was reached — unitRate, subtotal, discount and GST — so the
   client's invoice can print real Discount/GST lines instead of
   zeroes. When a full breakdown arrives, the stored total is DERIVED
   from it (subtotal − discountAmount + taxAmount) rather than trusted
   from the client, which guarantees the printed lines always add up
   to the printed total.
   ──────────────────────────────────────────────────────────── */
router.patch("/:id/status", protect, adminOnly, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const status = String(req.body.status || "").toLowerCase() as BookingStatus;
    const allowed: BookingStatus[] = ["pending", "confirmed", "completed", "cancelled"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status." });
    }

    const existing = await prisma.booking.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Booking not found." });

    // parse totalAmount if the client sent one
    let amount: number | null = null;
    if (req.body.totalAmount !== undefined && req.body.totalAmount !== null && req.body.totalAmount !== "") {
      const n = Number(req.body.totalAmount);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ message: "Total amount must be a positive number." });
      }
      amount = Math.round(n);
    }

    /* ── optional price breakdown ── */
    const money = (v: unknown): number | null => {
      if (v === undefined || v === null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;   // whole ₹, like totalAmount
    };
    const dec = (v: unknown): number | null => {
      if (v === undefined || v === null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; // 2dp
    };

    const unitRate = dec(req.body.unitRate);
    const subtotal = money(req.body.subtotal);
    const discountAmount = money(req.body.discountAmount);
    const discountValue = dec(req.body.discountValue);
    const taxAmount = money(req.body.taxAmount);
    const taxPercent = dec(req.body.taxPercent);
    const discountType =
      req.body.discountType === "percent" || req.body.discountType === "amount"
        ? String(req.body.discountType)
        : null;

    const hasBreakdown = subtotal != null;

    if (hasBreakdown) {
      const derived = Math.max(subtotal - (discountAmount ?? 0), 0) + (taxAmount ?? 0);
      if (derived <= 0) {
        return res.status(400).json({ message: "The price breakdown works out to zero." });
      }
      if (amount != null && amount !== derived) {
        // never store a total the printed lines don't sum to
        console.warn(
          `Booking ${id}: totalAmount ${amount} != breakdown ${derived} — using the breakdown.`,
        );
      }
      amount = derived;
    }

    // guard: total value must exist before confirming / completing
    const hasTotal = amount != null || (existing.totalAmount != null && existing.totalAmount > 0);
    if ((status === "confirmed" || status === "completed") && !hasTotal) {
      return res
        .status(400)
        .json({ message: "Enter the order's total value before marking it " + status + "." });
    }

    const booking = await prisma.booking.update({
      where: { id },
      data: {
        status,
        ...(amount != null ? { totalAmount: amount } : {}),
        ...(hasBreakdown
          ? {
              unitRate,
              subtotal,
              discountType,
              discountValue,
              discountAmount,
              taxPercent,
              taxAmount,
            }
          : {}),
      },
      include: { user: userPublic },
    });
    res.json(serializeBooking(booking));
  } catch (err) {
    console.error("Booking status error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ── client rating ──────────────────────────────────────────────
   Booking.rating already exists and BookingDetails.tsx has always
   called this endpoint — it just wasn't implemented, so the stars
   silently reset on reload. Owner-only: a client may rate their own
   booking, and only once it's completed.
   ──────────────────────────────────────────────────────────── */
router.patch("/:id/rating", protect, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const n = Number(req.body.rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return res.status(400).json({ message: "Rating must be a whole number from 1 to 5." });
    }

    const existing = await prisma.booking.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Booking not found." });

    // only the client who placed it may rate it (admins included for support)
    if (existing.userId !== req.user!.id && req.user!.role !== "admin") {
      return res.status(403).json({ message: "You can only rate your own bookings." });
    }
    if (existing.status !== "completed") {
      return res.status(400).json({ message: "You can rate this once the order is completed." });
    }

    const booking = await prisma.booking.update({ where: { id }, data: { rating: n } });
    res.json(serializeBooking(booking));
  } catch (err) {
    console.error("Booking rating error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;