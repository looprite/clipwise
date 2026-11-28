// The tools Claude calls, served at /mcp. Each runs a service with the caller's
// AccessContext — the same code, and so the same visibility rules, as the REST
// routes. Both are read-only.
//
// The descriptions are what Claude reads to decide how to use the tools; they
// started as the stdio package's (mcp/src/index.ts) and are kept in step with
// what the tools actually do. Anything a caller needs in order not to draw a
// wrong conclusion (a trimmed result, a page that is not the last, a default
// that narrows the search) is said here and again in the result itself.

import { z } from "zod";
import type { AccessContext } from "../access/context.js";
import { logAccess, logSearchAccess } from "../lib/access-line.js";
import { HttpError } from "../lib/http.js";
import { logError } from "../lib/safe-error.js";
import { displayTitle, formatMinutes, formatTimestamp } from "../lib/transcript-file.js";
import { searchMoments, searchMomentsQuerySchema } from "../services/search-moments.js";
import { searchTranscripts, searchTranscriptsQuerySchema } from "../services/search-transcripts.js";
import { getTranscriptPage } from "../services/transcript.js";
import { DEFAULT_PAGE_CHARS, MAX_PAGE_CHARS, MIN_PAGE_CHARS } from "../services/transcript-page.js";

// Search results are JSON, which costs more tokens per character than prose, and
// Claude Code caps a tool result at 25,000 tokens (claude.ai at ~150,000
// characters). Over this many characters the list is cut from the end and says so.
export const SEARCH_RESULT_CHARS = 60_000;

const DESC = {
  searchMomentsTool:
    "Search the moments extracted from the team's calls: decisions, commitments, objections, questions, observations. It searches the calls you recorded and the calls your teammates have shared with the team; a call someone else keeps private is never included, and nothing in a result says that one exists. Two retrieval paths (kept separate rather than fused): `query` for lexical/substring matching, `semanticQuery` for cosine-similarity retrieval over embeddings. Pass one or the other, not both. Returns moment metadata plus the recording title so you can cite where the moment came from; semantic results also include a similarity score and the producing embedding model. The response carries `totalMatches` (the true count before `limit` cut it down) and `truncated` (true when `totalMatches` exceeds the returned list). Check `truncated` before concluding something is absent or rare — on a truncated result that conclusion is unsound, and raising `limit` or narrowing the query (e.g. adding `recordingId`) is required first. A result larger than about 60,000 characters is cut from the end to fit what a client can take in; when that happens `trimmedForSize` is true and `truncated` is true — narrow the query rather than concluding the rest is absent. The response also carries `scope` (the personal/work filter that actually ran) and `scopeDefaulted` (true when `scope` was not passed and \"work\" was applied automatically) — a caller drawing a conclusion like \"there's nothing about X\" should check this before treating it as evidence about personal calls too. A third mode, `index`, enumerates recordings themselves — which meetings existed, with attendees and moment counts by kind, no moment content — for questions like \"what happened last week\" or \"every 1:1 with X\"; see the `index` parameter.",
  query:
    "Lexical search. Case-insensitive substring match against moment title/summary. Best for exact terms — names, product names, dollar figures — where similarity cannot separate them even in principle. A multi-word query ANDs a substring match per word (each word can land in title or summary independently); words need not be contiguous or in order.",
  semanticQuery:
    "Semantic search. Free-text question or description; results are ranked by cosine similarity against moment embeddings. Best for interpretation-heavy queries (what did we decide about X, who pushed back on Y). Returns up to `limit` results with a per-result `similarity` score in [-1,1]. Results always fill up to the limit regardless of relevance because there is no distance floor — you MUST read the similarity score to judge whether a low-ranked result is actually a match, otherwise you will treat unrelated moments as answers. Mutually exclusive with `query` — pass one or the other, not both.",
  recordingId: "Restrict to a single recording (UUID).",
  kind: 'Restrict to a specific moment kind (e.g. "decision", "commitment"). Case-insensitive. An unknown kind is refused with an error listing the kinds that exist in the calls you can see, rather than silently returning zero results.',
  attendee:
    "Restrict to recordings this person was on. Case-insensitive substring match against the attendee's name — who was in the meeting, not who the moment talks about, so a call where they never came up still matches and a call where they were only mentioned does not. Composes with `query` or `semanticQuery` (both filters apply) and works on its own. Only recordings whose attendee list was captured can match; one with no attendee rows is invisible to this filter rather than an error.",
  limit: "Max results. Defaults to 50.",
  scope:
    'Personal-vs-work filter. One of "work" (default), "personal", or "all". Defaults to "work" when omitted — pass "personal" explicitly to reach your own personal calls (other people\'s personal calls are never visible), or "all" to search across both. The response echoes back which scope actually ran.',
  index:
    "Recording-level enumeration instead of a moment search. Mutually exclusive with `query`/`semanticQuery` — pass this alone, optionally with `attendee`, `dateFrom`/`dateTo`, `scope` and `recordingId` to narrow which recordings are listed. Use this to answer \"what happened over this period\" or \"list every 1:1 with X\" — questions about which meetings existed, not what was said in them. Returns `recordings` instead of `moments`: each entry has the recording id (needed for get_transcript — otherwise a UUID is only discoverable by accident from a moment result), title, startedAt, durationSec, attendees (guests, not the host), momentCounts (an object keyed by moment kind, e.g. {\"decision\": 2, \"observation\": 5} — a kind with zero moments is simply absent, not present as 0) and totalMoments. Carries no moment title/summary text — this is an index, not a content view; follow up with a regular query scoped to a specific recordingId to read what was actually said. Still respects `truncated`/`totalMatches` and the personal/work `scope` default exactly like a moment search.",
  dateFrom:
    'Only recordings started at or after this ISO 8601 datetime (e.g. "2026-09-07T00:00:00Z") — bounds `index` results and moment-search results alike. Combine with dateTo to bound a window; either alone is a valid half-open range.',
  dateTo: "Only recordings started at or before this ISO 8601 datetime — bounds `index` results and moment-search results alike. See dateFrom.",

  searchTranscriptsTool:
    "Search over the transcript lines of the team's calls, by words (`query`) or by meaning (`semanticQuery`); pass one, not both. It searches the calls you recorded and the calls your teammates have shared with the team; a call someone else keeps private is never searched, and nothing in a result says that one exists. " +
    "With `query`: every line where all its words were said, ignoring case, within that one line: the call's recordingId, title and startedAt, the segment number, the time into the call, the speaker as get_transcript shows them, the line itself and the two lines either side. " +
    "Use it to find which calls and where, then read around each hit with get_transcript (fromSegment a few below the hit's segment, or fromSec) before concluding what was said, decided or agreed: two lines of context can mislead. " +
    "`query` matches words, not meaning: a miss is not evidence that something wasn't discussed, because people may have put it in other words. Try other wordings, or `semanticQuery`. Speaker names are not searched, only what was said. " +
    "With `semanticQuery`: the passages nearest in meaning, nearest first, each a few lines (segment to lastSegment) exactly as get_transcript prints them, with a similarity score and the embedding model; overlapping passages of one call are returned once. Every passage is ranked, so there is no count of matches: read the similarity, and read around a passage with get_transcript (fromSegment=segment). `callsSearched` and `callsNotYetSearchable` say how many calls in scope could and couldn't be searched this way yet; a call not yet searchable is not evidence of absence. " +
    "With `query` the response carries `totalMatches` (the true count before `limit`) and `truncated`; check `truncated` before concluding something is absent or rare. A result larger than about 60,000 characters is cut from the end, with `trimmedForSize` and `truncated` true; narrow the query (recordingId, dateFrom/dateTo) rather than concluding the rest is absent. " +
    "`scope` defaults to \"work\" (`scopeDefaulted` is then true): pass \"personal\" or \"all\" to search your own personal calls, also when you pass recordingId.",
  stQuery: "The words to find. Every word must appear, ignoring case, in the same line; a word matches inside a longer one (\"price\" finds \"pricing\").",
  stSemanticQuery: "Search by meaning instead of words: a question or a description of what was discussed (\"when the harvest date moved\"). Returns passages nearest in meaning. Pass this or `query`, not both.",
  stRecordingId: "Search one call only (UUID). A call you can't see is reported as not found.",
  stLimit: "Max hits. With `query`: defaults to 50, at most 200. With `semanticQuery`: defaults to 10, at most 50.",
  stScope: 'Personal-vs-work filter: "work" (default), "personal" or "all". Other people\'s personal calls are never searched. The response echoes the scope that ran.',
  stDateFrom: 'Only calls started at or after this ISO 8601 datetime (e.g. "2026-11-01T00:00:00Z").',
  stDateTo: "Only calls started at or before this ISO 8601 datetime.",

  getTranscriptTool:
    `Read a recording's transcript as text, one line per segment: \`[#12 3:04] Speaker: what was said\` (segment number, time into the call, speaker). Long transcripts are returned a page at a time, about ${DEFAULT_PAGE_CHARS.toLocaleString("en-US")} characters by default. The result's first lines say which segments are shown and whether there is more; when there is, they give the exact arguments for the next page (\`fromSegment\`). Keep asking for the next page until the result says it is the last one before concluding something was or was not said. To read around a moment from search_moments, pass its startSec as \`fromSec\`. Only recordings you recorded or that were shared with the team can be read; anything else is reported as not found.`,
  getTranscriptRecordingId: "The recording to read (UUID).",
  fromSegment: "Start at this segment number (the N in [#N ...]). Use the value a previous page gave as its next page. Takes precedence over fromSec.",
  fromSec: "Start at the first segment still running at this many seconds into the call — for jumping to a moment's startSec.",
  toSec: "Stop before the first segment starting at or after this many seconds into the call.",
  maxChars: `Page size in characters, ${MIN_PAGE_CHARS.toLocaleString("en-US")}–${MAX_PAGE_CHARS.toLocaleString("en-US")} (default ${DEFAULT_PAGE_CHARS.toLocaleString("en-US")}). Lines are never cut in half; a page always has at least one.`,
} as const;

const searchInput = z.object({
  query: z.string().optional(),
  semanticQuery: z.string().optional(),
  recordingId: z.string().uuid().optional(),
  kind: z.string().optional(),
  attendee: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  scope: z.enum(["work", "personal", "all"]).optional(),
  index: z.boolean().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

const searchTranscriptsInput = z.object({
  query: z.string().optional(),
  semanticQuery: z.string().optional(),
  recordingId: z.string().uuid().optional(),
  scope: z.enum(["work", "personal", "all"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

const transcriptInput = z.object({
  recordingId: z.string().uuid(),
  fromSegment: z.number().int().min(0).optional(),
  fromSec: z.number().min(0).optional(),
  toSec: z.number().min(0).optional(),
  maxChars: z.number().int().optional(),
});

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run: (ctx: AccessContext, args: unknown) => Promise<string>;
};

// Cuts a search result from the end until its compact JSON fits, always keeping
// at least one entry, and says so in the result so nobody reads a short list as
// a complete one. Every response shape: moments, recordings in index mode, and
// search_transcripts' hits.
export function fitToBudget(result: Record<string, unknown>, maxChars: number): string {
  const key = Array.isArray(result.moments) ? "moments" : Array.isArray(result.recordings) ? "recordings" : Array.isArray(result.hits) ? "hits" : null;
  const whole = JSON.stringify(result);
  if (key === null || whole.length <= maxChars) return whole;
  const items = result[key] as unknown[];
  const build = (k: number) =>
    JSON.stringify({
      ...result,
      [key]: items.slice(0, k),
      truncated: true,
      trimmedForSize: true,
      returned: k,
      note: `Cut to the first ${k} of ${items.length} results to fit a tool result; totalMatches is the full count. Narrow the query (recordingId, kind, dateFrom/dateTo, attendee) or lower limit.`,
    });
  let lo = 1;
  let hi = items.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(mid).length <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return build(lo);
}

function describeWhen(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "undated";
}

export const TOOLS: ToolDef[] = [
  {
    name: "search_moments",
    title: "Search call moments",
    description: DESC.searchMomentsTool,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: DESC.query },
        semanticQuery: { type: "string", description: DESC.semanticQuery },
        recordingId: { type: "string", description: DESC.recordingId },
        kind: { type: "string", description: DESC.kind },
        attendee: { type: "string", description: DESC.attendee },
        limit: { type: "number", description: DESC.limit },
        scope: { type: "string", enum: ["work", "personal", "all"], description: DESC.scope },
        index: { type: "boolean", description: DESC.index },
        dateFrom: { type: "string", description: DESC.dateFrom },
        dateTo: { type: "string", description: DESC.dateTo },
      },
    },
    run: async (ctx, args) => {
      const input = searchInput.parse(args ?? {});
      const query = searchMomentsQuerySchema.parse({
        q: input.query,
        semantic_q: input.semanticQuery,
        recordingId: input.recordingId,
        kind: input.kind,
        attendee: input.attendee,
        limit: input.limit,
        scope: input.scope,
        index: input.index,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
      });
      const sent = fitToBudget((await searchMoments(ctx, query)) as Record<string, unknown>, SEARCH_RESULT_CHARS);
      // What was sent, after any cut for size: those are the recordings read.
      logSearchAccess(ctx.memberId, "mcp.search_moments", JSON.parse(sent));
      return sent;
    },
  },
  {
    name: "search_transcripts",
    title: "Search call transcripts",
    description: DESC.searchTranscriptsTool,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: DESC.stQuery },
        semanticQuery: { type: "string", description: DESC.stSemanticQuery },
        recordingId: { type: "string", description: DESC.stRecordingId },
        limit: { type: "number", description: DESC.stLimit },
        scope: { type: "string", enum: ["work", "personal", "all"], description: DESC.stScope },
        dateFrom: { type: "string", description: DESC.stDateFrom },
        dateTo: { type: "string", description: DESC.stDateTo },
      },
    },
    run: async (ctx, args) => {
      const input = searchTranscriptsInput.parse(args ?? {});
      const query = searchTranscriptsQuerySchema.parse(input);
      const sent = fitToBudget((await searchTranscripts(ctx, query)) as Record<string, unknown>, SEARCH_RESULT_CHARS);
      // What was sent, after any cut for size: those are the recordings read.
      // Ids and a count only; never the words searched for.
      logSearchAccess(ctx.memberId, query.semanticQuery !== undefined ? "mcp.search_transcripts.semantic" : "mcp.search_transcripts", JSON.parse(sent));
      return sent;
    },
  },
  {
    name: "get_transcript",
    title: "Read a call transcript",
    description: DESC.getTranscriptTool,
    inputSchema: {
      type: "object",
      properties: {
        recordingId: { type: "string", description: DESC.getTranscriptRecordingId },
        fromSegment: { type: "number", description: DESC.fromSegment },
        fromSec: { type: "number", description: DESC.fromSec },
        toSec: { type: "number", description: DESC.toSec },
        maxChars: { type: "number", description: DESC.maxChars },
      },
      required: ["recordingId"],
    },
    run: async (ctx, args) => {
      const input = transcriptInput.parse(args ?? {});
      const { title, startedAt, durationSec, page } = await getTranscriptPage(ctx, input.recordingId, input);
      logAccess(ctx.memberId, "mcp.get_transcript", input.recordingId);
      const lastEnd = durationSec && durationSec > 0 ? durationSec : null;
      const head = [
        `Transcript: ${displayTitle(title)} — ${describeWhen(startedAt)}${lastEnd ? ` · ${formatMinutes(lastEnd)}` : ""}`,
        page.shown === 0
          ? page.totalSegments === 0
            ? "This recording has no transcript lines."
            : "No segments in the range asked for."
          : `Showing segments #${page.first}–#${page.last} of ${page.totalSegments} (${page.shown} with text; the whole transcript is ${page.totalChars.toLocaleString("en-US")} characters).`,
        page.next
          ? `NOT THE LAST PAGE. Next: call get_transcript with recordingId="${input.recordingId}" and fromSegment=${page.next.fromSegment} (starts at ${formatTimestamp(page.next.fromSec)}).`
          : page.shown > 0
            ? "This is the last page of what was asked for."
            : "",
        "---",
      ].filter((l) => l !== "");
      return `${head.join("\n")}\n${page.text}`;
    },
  },
];

// What a tool refusal looks like to Claude: a message, not an HTTP status.
export function toolErrorText(err: unknown): string {
  if (err instanceof z.ZodError) {
    return `invalid_arguments: ${err.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ")}`;
  }
  if (err instanceof HttpError) {
    return err.detail === undefined ? err.message : `${err.message}: ${JSON.stringify(err.detail)}`;
  }
  logError("mcp tool failed", err);
  return "internal_error";
}
