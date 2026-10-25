// What may be written to a log or a status file about an error.
//
// Some errors carry the input that caused them, and here the input can be the
// words of a call:
//   - a Drizzle query error's message is "Failed query: <sql>\nparams: <values>"
//     (drizzle-orm/errors.js), and a Postgres error's message and detail can
//     hold the offending value ("invalid input syntax for type uuid: ...", "Key
//     (col)=(value) already exists");
//   - JSON.parse's SyntaxError quotes the start of its input ("Unexpected token
//     'P', "PURPLE-ELE"... is not valid JSON" on Node 20 and later);
//   - an Anthropic API error's message is built from the API's error text;
//   - a Zod error's message can quote the value it received.
// For those this keeps the class and what identifies the failure without
// quoting anything: SQLSTATE code and schema names (table, column, constraint)
// for the database, the position for JSON, the HTTP status, request id and error
// type for the API, the issue codes and paths for Zod. Any other error keeps its
// message (cut short, with any "params:" tail removed) because ours are written
// by us and name no row. The stack's frames are kept, taken only from after the
// message, so the place of the failure is still findable.
//
// One exception for Anthropic's API (SAA-257): an Anthropic error that is a passing
// condition (passingApiCondition below) keeps its message too, capped. Those
// messages are the API's own words about the account (a spend limit, the credit
// balance, billing, a rate limit, an overload), never the request's content, and
// they are what says why a capture is waiting.

import Anthropic from "@anthropic-ai/sdk";

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  code?: unknown;
  cause?: unknown;
  severity?: unknown;
  routine?: unknown;
  table?: unknown;
  column?: unknown;
  constraint?: unknown;
  status?: unknown;
  requestID?: unknown;
  headers?: unknown;
  type?: unknown;
  error?: unknown;
  issues?: unknown;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

// An API error from an SDK: a numeric status with response headers or a request id.
const isApiError = (e: ErrorLike): boolean => typeof e.status === "number" && (e.requestID !== undefined || e.headers !== undefined);

type ApiBody = { type?: unknown; message?: unknown; error?: { type?: unknown; message?: unknown } };
const apiType = (e: ErrorLike): string | undefined => str(e.type) ?? str((e.error as ApiBody | undefined)?.error?.type) ?? str((e.error as ApiBody | undefined)?.type);
const apiMessage = (e: ErrorLike): string | undefined => str((e.error as ApiBody | undefined)?.error?.message) ?? str((e.error as ApiBody | undefined)?.message);

// A 400 that is a limit on the account, not a fault in the request. The spend
// limit's wording is Anthropic's (docs: api/rate-limits, "Setting your own spend
// limit": the message starts "You have reached your specified API usage limits",
// or "...specified workspace API usage limits"); the tier cap's 429 opens with
// "You have reached your API usage limits". The credit-balance wording is not in
// Anthropic's docs; it is the 400 reported in the wild.
const LIMIT_400 = [/^You have reached your (specified )?(workspace )?API usage limits/, /credit balance is too low/i];

// Anthropic's errors only, by the SDK's own class: another service's error with
// the same shape (a status, headers, a body) is never a passing condition here.
function isPassing(e: ErrorLike): boolean {
  if (!(e instanceof Anthropic.APIError) || typeof e.status !== "number") return false;
  const status = e.status;
  if (status === 402 || status === 429 || (status >= 500 && status <= 599)) return true;
  if (status !== 400 || apiType(e) !== "invalid_request_error") return false;
  const message = apiMessage(e) ?? "";
  return LIMIT_400.some((re) => re.test(message));
}

// Anthropic errors (Anthropic.APIError) that pass on their own, or once the
// account is put right: a 402 billing_error, a 429, any 5xx (529 overloaded
// among them), and a 400 whose message is a spend limit or the credit balance.
// The jobs worker retries these on a long ladder, and describeError keeps their
// message. The error or any of its causes.
export function passingApiCondition(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    if (isPassing(current as ErrorLike)) return true;
    current = (current as ErrorLike).cause;
  }
  return false;
}

function className(e: ErrorLike): string {
  const ctor = (e as { constructor?: { name?: unknown } }).constructor?.name;
  return str(ctor) ?? str(e.name) ?? "Error";
}

function describeOne(e: ErrorLike): string {
  const name = className(e);
  const parts = [name];
  const code = str(e.code);
  if (code) parts.push(`code=${code}`);

  // Drizzle's wrapper, or a Postgres server error (pg's DatabaseError has a
  // severity and routine); a connection failure or timeout has neither.
  if (name === "DrizzleQueryError" || e.severity !== undefined || e.routine !== undefined) {
    for (const k of ["table", "column", "constraint"] as const) {
      const v = str(e[k]);
      if (v) parts.push(`${k}=${v}`);
    }
    return parts.join(" ");
  }

  if (name === "SyntaxError") {
    const position = /\bposition (\d+)/.exec(str(e.message) ?? "")?.[1];
    if (position) parts.push(`position=${position}`);
    return parts.join(" ");
  }

  if (isApiError(e)) {
    parts.push(`status=${e.status}`);
    const requestID = str(e.requestID);
    if (requestID) parts.push(`request_id=${requestID}`);
    const type = apiType(e);
    if (type) parts.push(`type=${type}`);
    const message = isPassing(e) ? apiMessage(e) : undefined;
    if (message) parts.push(`message=${JSON.stringify(message.replace(/\s+/g, " ").trim().slice(0, 300))}`);
    return parts.join(" ");
  }

  if (name === "ZodError" && Array.isArray(e.issues)) {
    const issues = (e.issues as Array<{ code?: unknown; path?: unknown }>)
      .slice(0, 5)
      .map((i) => `${str(i.code) ?? "?"}@${Array.isArray(i.path) ? i.path.join(".") || "(input)" : "?"}`);
    parts.push(`issues=${issues.join(",")}`);
    return parts.join(" ");
  }

  // A plain Error keeps its message exactly as written, with no class prefix:
  // callers and checks match on those messages ("recording <id> not found").
  const message = str(e.message);
  if (message) {
    if (name === "Error") parts.shift();
    parts.push(message.split(/\r?\n\s*params:/)[0].slice(0, 300));
  }
  return parts.join(" ");
}

// The error's class alone (jobs.error_class): "BadRequestError", "Error",
// "EmbeddingIncompleteError". Nothing of its message.
export function errorClassOf(err: unknown): string {
  if (typeof err !== "object" || err === null) return `non-Error(${typeof err})`;
  return className(err as ErrorLike).slice(0, 128);
}

export function describeError(err: unknown, opts: { frames?: boolean } = {}): string {
  if (typeof err !== "object" || err === null) return `non-Error thrown (${typeof err})`;
  const chain: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    chain.push(describeOne(current as ErrorLike));
    current = (current as ErrorLike).cause;
  }
  let out = chain.join(" <- ");
  // A stack starts with the error's message, which can span lines and hold the
  // input, so frames are taken only from what follows the message. If the
  // message cannot be found in the stack, no frames.
  const stack = opts.frames === false ? undefined : str((err as ErrorLike).stack);
  if (stack) {
    const message = typeof (err as ErrorLike).message === "string" ? ((err as ErrorLike).message as string) : "";
    const at = message === "" ? 0 : stack.indexOf(message);
    if (at >= 0) {
      const tail = stack.slice(at + message.length);
      const frames = tail.split("\n").filter((l) => /^\s+at /.test(l)).slice(0, 4).map((l) => l.trim());
      if (frames.length > 0) out += `\n    ${frames.join("\n    ")}`;
    }
  }
  return out;
}

// One line, no stack frames. For stderr or result lines that the recorder reads:
// main.js shows the LAST line of a script's stderr as the reason a step failed
// (recorder/app/main.js, the save-transcript and trash handlers), so the reason
// has to be the last line.
export function describeErrorLine(err: unknown): string {
  return describeError(err, { frames: false }).replace(/\s+/g, " ").trim();
}

export function logError(context: string, err: unknown): void {
  console.error(`${context}: ${describeError(err)}`);
}
