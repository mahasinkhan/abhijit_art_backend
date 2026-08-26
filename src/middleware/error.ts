// backend/src/middleware/error.ts
import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * An error that already carries its HTTP status + a client-safe message.
 * Services and controllers `throw` these instead of each route hand-writing
 * res.status(...).json(...). The central errorHandler below turns them into
 * the response.
 *
 *   throw ApiError.notFound("Item not found.");
 *   throw ApiError.badRequest("Quantity must be positive.");
 */
export class ApiError extends Error {
  status: number;
  detail?: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }

  static badRequest(msg: string, detail?: unknown) { return new ApiError(400, msg, detail); }
  static unauthorized(msg = "Not authorised") { return new ApiError(401, msg); }
  static forbidden(msg = "Forbidden") { return new ApiError(403, msg); }
  static notFound(msg = "Not found") { return new ApiError(404, msg); }
  static conflict(msg: string) { return new ApiError(409, msg); }
}

type AsyncFn = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

/**
 * Wrap an async route/controller so a thrown error or rejected promise is
 * forwarded to the central errorHandler via next(). This replaces the
 * try/catch that every handler used to repeat.
 *
 *   router.get("/items", asyncHandler(ctrl.listItems));
 */
export const asyncHandler =
  (fn: AsyncFn): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

/** 404 for any route that didn't match — mount AFTER all routers. */
export const notFound = (req: Request, res: Response) => {
  res.status(404).json({ message: `Not found: ${req.method} ${req.originalUrl}` });
};

/**
 * Central error handler — the LAST `app.use(...)` in server.ts, after the
 * routers and notFound. One place shapes every error into JSON, so no handler
 * ever has to.
 */
export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction, // required 4-arg signature so Express treats this as an error handler
) => {
  // intentional, known errors → their own status + message
  if (err instanceof ApiError) {
    return res
      .status(err.status)
      .json({ message: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}) });
  }

  // common Prisma errors translated to clean client messages
  const code = (err as { code?: string })?.code;
  if (code === "P2002") return res.status(409).json({ message: "That value already exists." });
  if (code === "P2025") return res.status(404).json({ message: "Record not found." });

  // anything else is unexpected → log the real thing, send a generic message
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Server error" });
};