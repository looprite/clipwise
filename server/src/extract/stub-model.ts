// Stand-ins for the two paid services, for the checks. Nothing here is used by
// the server.
//
// The Anthropic stub is a fetch, not a replacement client: the real SDK is
// built on it (new Anthropic({ fetch })), so request building, response parsing,
// error classes and abort handling are the real ones. It answers the four calls
// extraction makes (pass 1, pass 2, collapse) with canned tool_use replies, and
// plants a known phrase in every span label and moment title so a check can look
// for it where it must not appear.

import Anthropic from "@anthropic-ai/sdk";
import type { Embedder } from "./embeddings.js";

export type StubCallKind = "pass1" | "pass2" | "collapse";

export type StubSpan = { index: number; label: string; start: number; end: number; startSec: number; endSec: number };

export type StubModelOptions = {
  // How many segments the recording has; pass 1 tiles them into two spans.
  segmentCount: number;
  // Planted in every span label and every moment title.
  phrase: string;
  // Called before each call is answered. May wait (honouring the signal), throw,
  // or change the world (a check takes a job's lease away here).
  // `bodyText` is the request body as sent: the transcript (with speaker names as
  // rendered) is in it.
  onCall?: (call: { kind: StubCallKind; n: number; signal: AbortSignal | null; bodyText: string }) => Promise<void> | void;
  // The `moments` value pass 2 returns for a span; anything but an array is a
  // bad shape. `attempt` counts calls for that span, from 1.
  pass2Moments?: (span: StubSpan, attempt: number) => unknown;
  // Answer every call with this HTTP status and an error body that quotes the
  // phrase, as the real API's error text can.
  failStatus?: number;
};

export type StubModel = {
  client: Anthropic;
  // The fetch the client is built on, for handing to the jobs worker, which builds
  // its own client around it.
  fetch: typeof fetch;
  // Every call answered or refused so far, in order, with its request body.
  calls: StubCallKind[];
  bodies: string[];
};

export function waitFor(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function reply(toolName: string, input: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "tool_use", id: "toolu_stub", name: toolName, input }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json", "request-id": "req_stub" } },
  );
}

export function defaultPass2Moments(span: StubSpan, phrase: string): unknown {
  return [
    {
      kind: "decision",
      title: `${phrase} decision in ${span.label}`,
      summary: `${phrase} summary one`,
      start_sec: span.startSec,
      end_sec: span.endSec,
      is_personnel_assessment: false,
      speakers: ["me"],
    },
    {
      kind: "observation",
      title: `${phrase} observation in ${span.label}`,
      summary: `${phrase} summary two`,
      start_sec: span.startSec,
      end_sec: span.endSec,
      is_personnel_assessment: false,
      speakers: ["them"],
    },
  ];
}

export function makeStubModel(opts: StubModelOptions): StubModel {
  const calls: StubCallKind[] = [];
  const bodies: string[] = [];
  const attempts = new Map<number, number>();
  const n = opts.segmentCount;
  const mid = Math.floor((n - 1) / 2);
  const ranges = n >= 2 ? [[0, mid], [mid + 1, n - 1]] : [[0, 0]];

  const stubFetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    // A real fetch rejects at once when its signal is already aborted; the SDK's
    // retries after an abort then fail the same way instead of being answered.
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const bodyText = String(init?.body ?? "{}");
    const body = JSON.parse(bodyText) as {
      tool_choice?: { name?: string };
      messages?: { content: { text: string }[] }[];
    };
    const tool = body.tool_choice?.name;
    const kind: StubCallKind = tool === "emit_spans" ? "pass1" : tool === "emit_moments" ? "pass2" : "collapse";
    calls.push(kind);
    bodies.push(bodyText);
    await opts.onCall?.({ kind, n: calls.length, signal: init?.signal ?? null, bodyText });
    if (opts.failStatus) {
      return new Response(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `${opts.phrase} quoted back by the API` } }),
        { status: opts.failStatus, headers: { "content-type": "application/json", "request-id": "req_stub_fail" } },
      );
    }
    if (kind === "pass1") {
      return reply("emit_spans", {
        spans: ranges.map(([a, b], i) => ({ label: `${opts.phrase} topic ${i}`, start_segment_index: a, end_segment_index: b })),
      });
    }
    if (kind === "pass2") {
      const text = body.messages?.[0]?.content?.at(-1)?.text ?? "";
      const label = /Span label: (.*)\n/.exec(text)?.[1] ?? "";
      const range = /Segment range: #(\d+) through #(\d+)/.exec(text);
      const clock = /Wall-clock range: (\d+)s to (\d+)s/.exec(text);
      const index = ranges.findIndex(([a]) => String(a) === range?.[1]);
      const span: StubSpan = {
        index,
        label,
        start: Number(range?.[1]),
        end: Number(range?.[2]),
        startSec: Number(clock?.[1]),
        endSec: Number(clock?.[2]),
      };
      const attempt = (attempts.get(index) ?? 0) + 1;
      attempts.set(index, attempt);
      const moments = opts.pass2Moments ? opts.pass2Moments(span, attempt) : defaultPass2Moments(span, opts.phrase);
      return reply("emit_moments", { moments });
    }
    // Collapse: no duplicates.
    return reply("emit_collapse_groups", { groups: [] });
  };

  const client = new Anthropic({ apiKey: "stub-key", fetch: stubFetch as typeof fetch, maxRetries: 0 });
  return { client, fetch: stubFetch as typeof fetch, calls, bodies };
}

export type StubEmbedderOptions = {
  // The first this many calls fail, as Voyage failing would.
  failFirst?: number;
  // Called first on every call; may wait (honouring the signal) or do other work.
  onCall?: (n: number, signal: AbortSignal | undefined) => Promise<void> | void;
};

export function makeStubEmbedder(opts: StubEmbedderOptions = {}): Embedder & { calls: number } {
  const fn = (async (texts: string[], _inputType: "document" | "query", signal?: AbortSignal) => {
    fn.calls++;
    await opts.onCall?.(fn.calls, signal);
    if (fn.calls <= (opts.failFirst ?? 0)) throw new Error("voyage embed 500");
    return texts.map((_, i) => Array.from({ length: 1024 }, (_, k) => ((i + k) % 7) / 7));
  }) as Embedder & { calls: number };
  fn.calls = 0;
  return fn;
}
