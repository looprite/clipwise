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

// What body-parser (express.json) raises for a request body it cannot use. They
// carry a status and a `type`, and their message and `.body` can quote the
// request, so the answer is a constant per type and the error is not logged.
const BODY_PARSER_ERRORS: Record<string, { status: number; error: string }> = {
  "entity.parse.failed": { status: 400, error: "invalid_json" },
  "entity.too.large": { status: 413, error: "payload_too_large" },
  "encoding.unsupported": { status: 415, error: "unsupported_encoding" },
  "charset.unsupported": { status: 415, error: "unsupported_charset" },
  "request.aborted": { status: 400, error: "request_aborted" },
  "request.size.invalid": { status: 400, error: "invalid_request" },
};

function bodyParserError(err: unknown): { status: number; error: string } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const type = (err as { type?: unknown }).type;
  return typeof type === "string" && Object.hasOwn(BODY_PARSER_ERRORS, type) ? BODY_PARSER_ERRORS[type] : undefined;
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
  const body = bodyParserError(err);
  if (body) {
    res.status(body.status).json({ error: body.error });
    return;
  }
  // The route pattern, not the URL: no query string, nothing the caller typed.
  // The error itself goes through logError, which leaves out anything a query,
  // a JSON body or an API response carried (lib/safe-error.ts).
  logError(`${req.method} ${req.baseUrl}${req.route?.path ?? ""}`, err);
  res.status(500).json({ error: "internal_error" });
};
