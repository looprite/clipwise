import type { NextFunction, Request, Response, RequestHandler } from "express";
import { ZodError, type ZodSchema } from "zod";
import { logError } from "./safe-error.js";

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export function parseBody<T>(schema: ZodSchema<T>, req: Request): T {
  return schema.parse(req.body);
}

export function parseQuery<T>(schema: ZodSchema<T>, req: Request): T {
  return schema.parse(req.query);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "invalid_request", issues: err.issues });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, detail: err.detail });
    return;
  }
  // The route pattern, not the URL: no query string, nothing the caller typed.
  // The error itself goes through logError, which leaves out anything a query,
  // a JSON body or an API response carried (lib/safe-error.ts).
  logError(`${req.method} ${req.baseUrl}${req.route?.path ?? ""}`, err);
  res.status(500).json({ error: "internal_error" });
};
