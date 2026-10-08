// Check for lib/safe-error.ts and the places that log errors. No database.
//
// A known phrase stands for the words of a call. It is put into real error
// objects of every kind that can carry input (a Drizzle query error, a Postgres
// error, a JSON.parse failure, an Anthropic API error, a Zod error, a Voyage
// failure), each is sent through the real errorHandler with console.error
// captured, and the phrase must not appear in what was logged. Each case has a
// control: what the old code printed (console.error(err), which is
// util.inspect) DOES contain the phrase, so the check is not passing because the
// phrase never reached the error.
//
//   npx tsx src/lib/check-safe-error.ts

import Anthropic from "@anthropic-ai/sdk";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { DatabaseError } from "pg";
import { inspect } from "node:util";
import { z } from "zod";
import { errorHandler } from "./http.js";
import { describeError, describeErrorLine } from "./safe-error.js";
import { embed } from "./voyage.js";

const PHRASE = "PURPLE-ELEPHANT-4417";
// JSON.parse quotes the first ten characters of its input, not the whole phrase.
const QUOTED = PHRASE.slice(0, 10);

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

function capture(fn: () => void): string {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" "));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

// Through the real handler, with a request shaped like Express's.
function throughHandler(err: unknown): { logged: string; status: number } {
  let status = 0;
  const res = {
    status(s: number) { status = s; return this; },
    json() { return this; },
  };
  const req = { method: "POST", baseUrl: "/accounts/abc/recordings", route: { path: "/:id/transcript" } };
  const logged = capture(() => (errorHandler as any)(err, req, res, () => {}));
  return { logged, status };
}

function pgError(): DatabaseError {
  const e = new DatabaseError(`invalid input syntax for type uuid: "${PHRASE}"`, 0, "error");
  e.severity = "ERROR";
  e.code = "22P02";
  e.detail = `Key (text)=(${PHRASE}) already exists.`;
  e.table = "segments";
  e.column = "text";
  e.constraint = "segments_pkey";
  e.routine = "string_to_uuid";
  return e;
}

async function main(): Promise<void> {
  // A Voyage failure through the real embed(), fetch stubbed to answer with a
  // body that quotes the input, as an API's error text can.
  const realFetch = globalThis.fetch;
  process.env.VOYAGE_API_KEY = "test-key-not-real";
  globalThis.fetch = (async () => new Response(`{"detail":"input rejected: ${PHRASE}"}`, { status: 400 })) as typeof fetch;
  let voyageErr: unknown;
  try {
    await embed([PHRASE], "document");
  } catch (e) {
    voyageErr = e;
  } finally {
    globalThis.fetch = realFetch;
  }

  const drizzle = new DrizzleQueryError("insert into segments (text) values ($1)", [PHRASE, "x"], pgError());
  const drizzleMultiline = new DrizzleQueryError("insert into segments (text) values ($1)", [`first line\n    at ${PHRASE} (meeting.txt:1:1)`], new Error("socket closed"));
  const jsonStart = (() => { try { JSON.parse(`${PHRASE} said this`); } catch (e) { return e; } })();
  const jsonMiddle = (() => { try { JSON.parse(`{"text": "${PHRASE}", oops}`); } catch (e) { return e; } })();
  const api = new Anthropic.APIError(400, { type: "error", error: { type: "invalid_request_error", message: `bad content: ${PHRASE}` } }, undefined, new Headers({ "request-id": "req_test_123" }));
  const zod = (() => { try { z.enum(["a", "b"]).parse(PHRASE); } catch (e) { return e; } })();

  // `control`: what the old code would have printed. Omitted where the error
  // carries no input to begin with (JSON.parse in the middle of a text gives a
  // position only); replaced for Voyage, whose message the source fix changed.
  // `handled`: errorHandler answers the error itself (Zod: 400, not logged).
  const oldVoyageMessage = new Error(`voyage embed 400: {"detail":"input rejected: ${PHRASE}"}`);
  const cases: Array<{ name: string; err: unknown; keeps: string[]; control?: unknown | null; handled?: boolean }> = [
    { name: "Drizzle query error (params hold the phrase), wrapping a Postgres error", err: drizzle, keeps: ["DrizzleQueryError", "22P02", "segments"] },
    { name: "Drizzle query error whose params span lines and start a line with 'at'", err: drizzleMultiline, keeps: ["DrizzleQueryError"] },
    { name: "Postgres error alone (message and detail hold the phrase)", err: pgError(), keeps: ["DatabaseError", "22P02", "table=segments", "constraint=segments_pkey"] },
    { name: "JSON.parse failure, phrase at the start of the input", err: jsonStart, keeps: ["SyntaxError"] },
    { name: "JSON.parse failure, phrase in the middle of the input", err: jsonMiddle, keeps: ["SyntaxError", "position="], control: null },
    { name: "Anthropic API error (message quotes the input)", err: api, keeps: ["APIError", "status=400", "request_id=req_test_123", "type=invalid_request_error"] },
    { name: "Zod error (message quotes the received value)", err: zod, keeps: ["ZodError", "invalid_enum_value"], handled: true },
    { name: "Voyage failure through the real embed()", err: voyageErr, keeps: ["voyage embed 400"], control: oldVoyageMessage },
  ];

  for (const c of cases) {
    const line = describeErrorLine(c.err);
    if (c.control !== null) {
      const controlText = inspect(c.control ?? c.err);
      const controlHasIt = controlText.includes(PHRASE) || controlText.includes(QUOTED);
      check(`control: the old output (console.error(err)) for "${c.name}" contains the phrase`, controlHasIt);
    } else {
      check(`(no control for "${c.name}": the message gives a position only, so there is nothing to leak)`, !inspect(c.err).includes(PHRASE));
    }

    const { logged, status } = throughHandler(c.err);
    if (c.handled) {
      // The handler answers this itself (400) and logs nothing; the helper is
      // still checked on it below, and keeps its identifying parts.
      check(`errorHandler answers "${c.name}" with 400 and logs nothing`, status === 400 && logged === "", `status ${status}, LOGGED: ${logged.slice(0, 200)}`);
      check(`  ...and describeErrorLine keeps ${c.keeps.join(", ")}`, c.keeps.every((k) => line.includes(k)), `LINE: ${line}`);
    } else {
      const leaked = logged.includes(PHRASE) || logged.includes(QUOTED);
      check(`errorHandler logs "${c.name}" without the phrase`, !leaked && logged.length > 0, leaked ? `LOGGED: ${logged.slice(0, 400)}` : "nothing logged");
      check(`  ...and keeps ${c.keeps.join(", ")}`, c.keeps.every((k) => logged.includes(k)), `LOGGED: ${logged.slice(0, 400)}`);
      check(`  ...and names the route`, logged.includes("POST /accounts/abc/recordings/:id/transcript"), `LOGGED: ${logged.slice(0, 200)}`);
      check(`  ...and answers 500`, status === 500);
    }

    check(`  describeErrorLine is one line without the phrase`, !line.includes("\n") && !line.includes(PHRASE) && !line.includes(QUOTED), `LINE: ${line.slice(0, 300)}`);
    const full = describeError(c.err);
    check(`  describeError (with frames) has no phrase`, !full.includes(PHRASE) && !full.includes(QUOTED), `FULL: ${full.slice(0, 300)}`);
  }

  // What callers and checks match on must survive unchanged.
  const notFound = new Error("recording 11111111-2222-3333-4444-555555555555 not found");
  check("a plain Error keeps its message exactly (check-trash matches /not found/)", describeErrorLine(notFound) === notFound.message, describeErrorLine(notFound));
  check("a plain Error's frames never replace the reason as the last line of the one-line form", describeErrorLine(notFound).endsWith("not found"));
  const diarizeFailed = new Error("diarize tool failed: exit 1");
  check("'diarize tool failed' still appears (check-early-sidecar matches it)", describeErrorLine(diarizeFailed).includes("diarize tool failed"));
  check("a non-Error thrown value is not echoed", !describeError(PHRASE).includes(PHRASE) && describeError(PHRASE).includes("string"));

  console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("check crashed:", describeError(e));
  process.exitCode = 1;
});
