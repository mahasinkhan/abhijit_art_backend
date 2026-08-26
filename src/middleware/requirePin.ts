// backend/src/middleware/requirePin.ts
import type { Request, Response, NextFunction } from "express";
import { isPinSet, verifyPin } from "../utils/security.js";
import { ApiError } from "./error.js";

/**
 * Security gate for state-changing actions: the billing PIN must be set, and
 * the PIN sent with the request must match. This used to be pasted at the top
 * of every write handler as `if (await requirePin(req, res)) return;`. Now it's
 * one middleware you drop into the route chain before the controller:
 *
 *   router.post("/items", requirePin, asyncHandler(ctrl.createItem));
 *   router.delete("/items/:id", requirePin, asyncHandler(ctrl.deleteItem));
 *
 * The PIN comes from req.body.pin. axios DELETEs send it as { data: { pin } },
 * which also lands in the body, so the same read works for every method.
 * On failure it throws an ApiError; the central errorHandler turns that into
 * the 409 / 403 response — no res handling here.
 */
export const requirePin = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const pin = String(req.body?.pin ?? "").trim();

    if (!(await isPinSet())) {
      throw ApiError.conflict("Set a security PIN in Settings before making changes.");
    }
    if (!(await verifyPin(pin))) {
      throw ApiError.forbidden("Incorrect PIN.");
    }

    next();
  } catch (err) {
    next(err);
  }
};