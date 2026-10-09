import type { NextFunction, Request, Response, RequestHandler } from "express";
import { z, ZodError, type ZodSchema } from "zod";
import { logError } from "./safe-error.js";

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

// For `router.param("id", ...)`: an id that is not a UUID cannot name a row, and
// handing it to Postgres compared with a uuid column is a 22P02 error, which
// used to reach errorHandler as a 500. It is the same 404 as for an id that
// names nothing, so the answer does not say which.
const UUID = z.string().uuid();
export function uuidParam(notFound: string): (req: Request, res: Response, next: NextFunction, value: string) => void {
  return (_req, _res, next, value) => {
    next(UUID.safeParse(value).success ? undefined : new HttpError(404, notFound));
  };
}

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
