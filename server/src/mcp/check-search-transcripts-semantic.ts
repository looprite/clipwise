// SAA-370 step 2: search_transcripts' meaning mode, `semanticQuery`, over
// transcript windows (transcript_windows, written by the embed_lines job).
//
// Runs the real MCP server (createMcpServer) over the SDK's in-memory transport,
// as two members of a throwaway account, like check-search-transcripts. Invented
// people only: Dana Whitlock records most calls; Marco Feld is the other member
// and the far end of Dana's calls. Windows are written here directly, in the
// design's shape (8 shown lines stepping 4, rule lines8-step4, model voyage-4),
// with a bag-of-words vector; Voyage is a stub at the fetch boundary that gives
// a query the same kind of vector, so ranking is predictable.
//
//   m1  search_transcripts lists semanticQuery, and its description says it
//       searches by meaning
//   m2  "plum orchard harvest" finds A1 first: the hit's segment..lastSegment
//       holds #6, its lines are exactly get_transcript's lines for that range
//       (the empty #5 left out), with similarity and embeddingModel voyage-4
//   m3  the search sent Voyage one request: [the query], input_type query,
//       model voyage-4
//   m4  query and semanticQuery together, or neither, is an error
//   m5  Marco can't find Dana's private call by meaning; asking for it by
//       recordingId is recording_not_found, the same text as a made-up id; Dana
//       finds it (control)
//   m6  a trashed call is not searched
//   m7  a personal call is not searched unless scope is personal or all;
//       scopeDefaulted is true only when scope is omitted
//   m8  overlapping windows of one call are one hit: no two hits of a call
//       overlap
//   m9  limit: omitted gives 10, 3 gives 3, 51 is an error
//   m10 coverage: callsSearched and callsNotYetSearchable count the calls in
//       scope with and without windows
//   m11 a member whose calls hold few of the windows nearest the query still gets
//       a full page (10 hits), whichever plan the planner picks (the vector
//       index, or the recording_id index and an exact sort)
//   m12 a speaker renamed after the windows were made: the hit shows the new
//       name, and the windows are unchanged
//   m13 every successful search writes exactly one access line, route
//       mcp.search_transcripts.semantic, naming the member and the recordings
//       returned; a refused one writes none; no line written holds the query, a
//       word of a line or a title. Control: the words came back in results
//
// The whole run has enable_seqscan off on every connection. That doesn't put the
// planner on the HNSW index: on scratch (11-28) it took transcript_windows_
// recording_idx and sorted exactly. So m11 checks the page is full, not which
// index served it.
//
// Proof by breaking, once the build exists (each should turn its case FAIL):
//   m3  embed the query with input_type "document"
//   m5  drop recordingVisibleTo from the semantic path
//   m8  drop the overlap de-duplication
//
// Writes, so it refuses unless run through scratch-db.sh on a scratch branch:
//
//   scripts/scratch-db.sh run check-search-transcripts-semantic

import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import type { AccessContext } from "../access/context.js";
import { db, pool, schema } from "../db/index.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch, type Fixture } from "../extract/fixtures-for-checks.js";
import { createMcpServer } from "./server.js";

const WHO = "check-search-transcripts-semantic";
const ROUTE = "mcp.search_transcripts.semantic";
const WINDOW_RULE = "lines8-step4";
const MODEL = "voyage-4";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail.slice(0, 500)}`}`);
  if (!ok) failures++;
}

// Everything the tool and the server write while a call runs.
const captured: string[] = [];
async function during<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const mine: string[] = [];
  const grab = ((chunk: unknown) => {
    const s = String(chunk);
    captured.push(s);
    mine.push(...s.split("\n").filter(Boolean));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = grab;
  process.stderr.write = grab;
  try {
    return { result: await fn(), lines: mine };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

// ---- Voyage, stubbed at the fetch boundary -------------------------------------
type VoyageReq = { input: string[]; input_type: string; model: string };
const voyageRequests: VoyageReq[] = [];
function vectorOf(text: string): number[] {
  const v = new Array<number>(1024).fill(0);
  v[0] = 0.01;
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 2166136261;
    for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    v[1 + (h % 1023)] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}
const literal = (v: number[]): string => `[${v.join(",")}]`;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.voyageai.com/")) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? "{}")) as VoyageReq;
  voyageRequests.push(body);
  return new Response(
    JSON.stringify({ object: "list", data: body.input.map((t, i) => ({ object: "embedding", embedding: vectorOf(t), index: i })), model: body.model, usage: { total_tokens: 1 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

type Called = { isError: boolean; text: string; json: any; lines: string[] };
async function connect(ctx: AccessContext): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx).connect(serverSide);
  const client = new Client({ name: WHO, version: "1" });
  await client.connect(clientSide);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Called> {
  const { result, lines } = await during(() => client.callTool({ name, arguments: args }));
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  const text = String(content[0]?.text ?? "");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: (result as { isError?: boolean }).isError === true, text, json, lines };
}

const DANA = "Dana Whitlock";
const MARCO = "Marco Feld";
const MARCO_RENAMED = "Marco Feldane";

const Q_ORCHARD = "plum orchard harvest";
const Q_PRIVATE = "zanthorpe ledger";
const Q_PERSONAL = "fennelwick cottage";

type Line = ["me" | "them", string];
const collapse = (t: string): string => t.replace(/\s+/g, " ").trim();
function windowsOf(texts: string[]): Array<{ first: number; last: number; text: string }> {
  const shown = texts.flatMap((t, i) => (collapse(t) === "" ? [] : [i]));
  const m = shown.length;
  const out: Array<{ first: number; last: number; text: string }> = [];
  if (m === 0) return out;
  for (let s = 0; ; s += 4) {
    const e = Math.min(s + 7, m - 1);
    out.push({ first: shown[s], last: shown[e], text: shown.slice(s, e + 1).map((i) => collapse(texts[i])).join("\n") });
    if (e === m - 1) break;
  }
  return out;
}

async function addMember(fx: Fixture, email: string): Promise<string> {
  const [m] = await db.insert(schema.accountMembers).values({ accountId: fx.accountId, email, role: "member", joinedAt: new Date() }).returning();
  return m.id;
}

let hasTable = false;
async function addCall(
  fx: Fixture,
  ownerId: string,
  o: { title: string; visibility: "shared" | "private"; scope: "work" | "personal"; startedAt: string; trashed?: boolean; windows?: boolean; lines: Line[] },
): Promise<{ id: string; themSpeakerId: string }> {
  const id = randomUUID();
  await db.insert(schema.recordings).values({
    id, accountId: fx.accountId, ownerMemberId: ownerId, slug: `check-${fx.tag}-${id.slice(0, 8)}`, title: o.title, source: "check", sourceId: id,
    status: "ready", visibility: o.visibility, scope: o.scope, startedAt: new Date(o.startedAt), durationSec: o.lines.length * 10, trashedAt: o.trashed ? new Date() : null, metadata: {},
  });
  const [transcript] = await db.insert(schema.transcripts).values({ recordingId: id, provider: "check", language: "en", status: "ready" }).returning();
  const [me] = await db.insert(schema.speakers).values({ recordingId: id, label: "me" }).returning();
  const [them] = await db.insert(schema.speakers).values({ recordingId: id, label: "them", displayName: MARCO }).returning();
  await db.insert(schema.attendees).values({ recordingId: id, name: DANA, isHost: true });
  await db.insert(schema.segments).values(
    o.lines.map(([who, text], i) => ({ accountId: fx.accountId, recordingId: id, transcriptId: transcript.id, speakerId: who === "me" ? me.id : them.id, startSec: i * 10, endSec: i * 10 + 9, text, orderIndex: i })),
  );
  if (hasTable && o.windows !== false) {
    for (const w of windowsOf(o.lines.map(([, t]) => t))) {
      await pool.query(
        `insert into transcript_windows (account_id, recording_id, transcript_id, first_segment, last_segment, embedding, embedding_model, window_rule)
         values ($1, $2, $3, $4, $5, $6::vector, $7, $8)`,
        [fx.accountId, id, transcript.id, w.first, w.last, literal(vectorOf(w.text)), MODEL, WINDOW_RULE],
      );
    }
  }
  return { id, themSpeakerId: them.id };
}

// A1's lines. #5 is empty: get_transcript numbers it but doesn't show it.
const A1_LINES: Line[] = [
  ["me", "Thanks for joining, let's start with the agenda."],
  ["them", "Sounds good, I have the numbers ready."],
  ["me", "First item is the supplier contract."],
  ["them", "The draft is in the shared folder."],
  ["me", "I read it this morning."],
  ["me", ""],
  ["them", "The plum orchard harvest moves to October this year."],
  ["me", "Agreed, can you tell the packers by Friday?"],
  ["them", "Yes, I will."],
  ["me", "Next, the launch email."],
  ["them", "That one is ready."],
  ["me", "Great, that's everything."],
];
// No word of Q_ORCHARD ("plum", "orchard", "harvest"), so no filler window is
// nearer that query than A1's.
const filler = (n: number, tag: string): Line[] => Array.from({ length: n }, (_, i): Line => [i % 2 === 0 ? "me" : "them", `${tag} note ${i}: the walnut crates and the loading rota`]);

async function main(): Promise<void> {
  // Before any connection exists, so every connection the run opens gets it.
  pool.on("connect", (c) => {
    c.query("set enable_seqscan = off").catch(() => undefined);
  });
  await refuseUnlessScratch(WHO);
  process.env.VOYAGE_API_KEY = "stub-voyage-key";
  hasTable = (await pool.query<{ t: string | null }>(`select to_regclass('public.transcript_windows')::text as t`)).rows[0].t !== null;
  check("transcript_windows exists (fixtures get windows only if it does)", hasTable);
  const fx = await makeAccount(WHO);
  try {
    const marcoId = await addMember(fx, `marco-${fx.tag}@clipwise.test`);
    const dana: AccessContext = { accountId: fx.accountId, memberId: fx.memberId, role: "member", authUserId: randomUUID(), email: `dana-${fx.tag}@clipwise.test`, scope: [] };
    const marco: AccessContext = { accountId: fx.accountId, memberId: marcoId, role: "member", authUserId: randomUUID(), email: `marco-${fx.tag}@clipwise.test`, scope: [] };

    const a1 = await addCall(fx, fx.memberId, { title: "Orchard planning", visibility: "shared", scope: "work", startedAt: "2026-11-20T15:00:00Z", lines: A1_LINES });
    const a2 = await addCall(fx, fx.memberId, {
      title: "Budget notes", visibility: "private", scope: "work", startedAt: "2026-11-18T15:00:00Z",
      lines: [["me", "Two things today."], ["them", "The zanthorpe ledger needs closing before the audit."], ["me", "Fine by me."]],
    });
    const a3 = await addCall(fx, fx.memberId, {
      title: "Family weekend", visibility: "private", scope: "personal", startedAt: "2026-11-17T15:00:00Z",
      lines: [["me", "How was the trip?"], ["them", "The fennelwick cottage was lovely."], ["me", "Glad to hear it."]],
    });
    const a5 = await addCall(fx, fx.memberId, { title: "Trashed call", visibility: "shared", scope: "work", startedAt: "2026-11-21T15:00:00Z", trashed: true, lines: [["them", "The plum orchard harvest in a trashed call."]] });
    const a6 = await addCall(fx, fx.memberId, { title: "Unindexed call", visibility: "shared", scope: "work", startedAt: "2026-11-19T15:00:00Z", windows: false, lines: [["me", "This call has no windows yet."], ["them", "Then search by meaning can't see it."]] });
    const fillers = [];
    for (let k = 0; k < 4; k++) {
      fillers.push(await addCall(fx, fx.memberId, { title: `Filler ${k}`, visibility: "shared", scope: "work", startedAt: `2026-11-1${k}T15:00:00Z`, lines: filler(40, `rota${k}`) }));
    }
    // Marco's private call: many windows nearer the query than anything Dana can see.
    const m1 = await addCall(fx, marcoId, {
      title: "Archive", visibility: "private", scope: "work", startedAt: "2026-11-22T15:00:00Z",
      lines: Array.from({ length: 400 }, (_, i): Line => [i % 2 === 0 ? "me" : "them", `plum orchard harvest ${i % 3 === 0 ? "plum" : "orchard"}`]),
    });

    const cd = await connect(dana);
    const cm = await connect(marco);
    const hitsOf = (r: Called): any[] => (Array.isArray(r.json?.hits) ? r.json.hits : []);

    // m1
    const listed = await during(() => cd.listTools());
    const tool = listed.result.tools.find((t) => t.name === "search_transcripts");
    const props = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    check("m1 search_transcripts lists semanticQuery, and says it searches by meaning", !!tool && "semanticQuery" in props && /meaning/i.test(String((props.semanticQuery as { description?: string })?.description ?? "")), JSON.stringify(Object.keys(props)));

    // m2, m3
    const tr = await call(cd, "get_transcript", { recordingId: a1.id });
    const trLine = (n: number) => tr.text.split("\n").find((l) => l.startsWith(`[#${n} `)) ?? null;
    check("m2 control: get_transcript shows A1 and leaves #5 out", tr.text.includes("plum orchard") && trLine(5) === null, tr.text.slice(0, 200));
    const before = voyageRequests.length;
    const orchard = await call(cd, "search_transcripts", { semanticQuery: Q_ORCHARD });
    const sent = voyageRequests.slice(before);
    const h = hitsOf(orchard)[0];
    const rangeLines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => trLine(from + i)).filter((l): l is string => l !== null);
    check("m2 the top hit is A1, its range holds #6", !orchard.isError && h?.recordingId === a1.id && h?.recordingTitle === "Orchard planning" && h.segment <= 6 && 6 <= h.lastSegment, orchard.text);
    check("m2 its lines are exactly get_transcript's for segment..lastSegment, #5 left out", !!h && JSON.stringify(h.lines) === JSON.stringify(rangeLines(h.segment, h.lastSegment)) && !JSON.stringify(h.lines).includes("[#5 "), JSON.stringify(h?.lines));
    check("m2 it carries a similarity and embeddingModel voyage-4", typeof h?.similarity === "number" && h.similarity > 0 && h.similarity <= 1.0001 && h?.embeddingModel === MODEL, JSON.stringify({ similarity: h?.similarity, model: h?.embeddingModel }));
    check("m3 one Voyage request: [the query], input_type query, model voyage-4", sent.length === 1 && JSON.stringify(sent[0].input) === JSON.stringify([Q_ORCHARD]) && sent[0].input_type === "query" && sent[0].model === MODEL, JSON.stringify(sent));

    // m4
    const both = await call(cd, "search_transcripts", { query: "orchard", semanticQuery: Q_ORCHARD });
    const neither = await call(cd, "search_transcripts", {});
    check("m4 query and semanticQuery together is an error that names semanticQuery", both.isError && both.text.includes("semanticQuery"), both.text.slice(0, 200));
    check("m4 neither is an error that names semanticQuery", neither.isError && neither.text.includes("semanticQuery"), neither.text.slice(0, 200));

    // m5
    const priv = await call(cm, "search_transcripts", { semanticQuery: Q_PRIVATE, scope: "all" });
    const privOwner = await call(cd, "search_transcripts", { semanticQuery: Q_PRIVATE, scope: "all" });
    check("m5 Marco gets no hit in Dana's private call", !priv.isError && Array.isArray(priv.json?.hits) && !priv.text.includes(a2.id), priv.text.slice(0, 300));
    check("m5 control: Dana's top hit is her private call", hitsOf(privOwner)[0]?.recordingId === a2.id, privOwner.text.slice(0, 300));
    const byId = await call(cm, "search_transcripts", { semanticQuery: Q_PRIVATE, recordingId: a2.id, scope: "all" });
    const madeUp = await call(cm, "search_transcripts", { semanticQuery: Q_PRIVATE, recordingId: randomUUID(), scope: "all" });
    check("m5 by recordingId it is recording_not_found, the same text as a made-up id", byId.isError && byId.text.includes("recording_not_found") && byId.text === madeUp.text, `${byId.text} | ${madeUp.text}`);

    // m6
    const allOrchard = await call(cd, "search_transcripts", { semanticQuery: Q_ORCHARD, scope: "all", limit: 50 });
    check("m6 a trashed call is not searched", !allOrchard.isError && hitsOf(allOrchard).length > 0 && !allOrchard.text.includes(a5.id), allOrchard.text.slice(0, 200));

    // m7
    const pDefault = await call(cd, "search_transcripts", { semanticQuery: Q_PERSONAL });
    const pPersonal = await call(cd, "search_transcripts", { semanticQuery: Q_PERSONAL, scope: "personal" });
    check("m7 scope omitted: the personal call isn't searched, scope work, scopeDefaulted true", !pDefault.isError && !pDefault.text.includes(a3.id) && pDefault.json?.scope === "work" && pDefault.json?.scopeDefaulted === true, pDefault.text.slice(0, 300));
    check("m7 scope personal: its top hit is the personal call, scopeDefaulted false", hitsOf(pPersonal)[0]?.recordingId === a3.id && pPersonal.json?.scopeDefaulted === false, pPersonal.text.slice(0, 300));

    // m8
    const overlaps = (hs: any[]) =>
      hs.some((x, i) => hs.some((y, j) => j > i && x.recordingId === y.recordingId && x.segment <= y.lastSegment && y.segment <= x.lastSegment));
    check("m8 no two hits of one call overlap", hitsOf(allOrchard).length > 0 && !overlaps(hitsOf(allOrchard)), JSON.stringify(hitsOf(allOrchard).map((x) => [x.recordingId?.slice(0, 8), x.segment, x.lastSegment])));
    check("m8 A1 is one hit, though both its windows hold the words", hitsOf(allOrchard).filter((x) => x.recordingId === a1.id).length === 1, String(hitsOf(allOrchard).filter((x) => x.recordingId === a1.id).length));

    // m9, m11
    const l3 = await call(cd, "search_transcripts", { semanticQuery: Q_ORCHARD, limit: 3 });
    const l51 = await call(cd, "search_transcripts", { semanticQuery: Q_ORCHARD, limit: 51 });
    check("m9 limit 3 gives 3 hits", hitsOf(l3).length === 3, String(hitsOf(l3).length));
    check("m9 limit 51 is an error about limit", l51.isError && l51.text.includes("limit"), l51.text.slice(0, 200));
    check("m9 m11 limit omitted gives a full page of 10, though most windows nearest the query are Marco's private ones", hitsOf(orchard).length === 10, String(hitsOf(orchard).length));
    check("m11 none of those hits is Marco's private call", !orchard.text.includes(m1.id));

    // m10
    check(
      "m10 Dana, scope work: callsSearched 6 (A1, A2, four fillers), callsNotYetSearchable 1 (the unindexed call)",
      orchard.json?.callsSearched === 6 && orchard.json?.callsNotYetSearchable === 1,
      JSON.stringify({ callsSearched: orchard.json?.callsSearched, callsNotYetSearchable: orchard.json?.callsNotYetSearchable }),
    );
    const asMarco = await call(cm, "search_transcripts", { semanticQuery: Q_ORCHARD });
    check(
      "m10 Marco, scope work: callsSearched 6 (A1, four fillers, his own), callsNotYetSearchable 1",
      asMarco.json?.callsSearched === 6 && asMarco.json?.callsNotYetSearchable === 1,
      JSON.stringify({ callsSearched: asMarco.json?.callsSearched, callsNotYetSearchable: asMarco.json?.callsNotYetSearchable }),
    );
    void a6;
    void fillers;

    // m12
    const winBefore = hasTable ? (await pool.query(`select id, embedding::text as v from transcript_windows where recording_id = $1 order by first_segment`, [a1.id])).rows : [];
    await db.update(schema.speakers).set({ displayName: MARCO_RENAMED }).where(eq(schema.speakers.id, a1.themSpeakerId));
    const renamed = await call(cd, "search_transcripts", { semanticQuery: Q_ORCHARD, recordingId: a1.id });
    const hr = hitsOf(renamed)[0];
    const winAfter = hasTable ? (await pool.query(`select id, embedding::text as v from transcript_windows where recording_id = $1 order by first_segment`, [a1.id])).rows : [];
    check("m12 after a rename, the hit's lines show the new name", !!hr && JSON.stringify(hr.lines).includes(`] ${MARCO_RENAMED}: `) && !JSON.stringify(hr.lines).includes(`] ${MARCO}: `), JSON.stringify(hr?.lines));
    check("m12 the windows are unchanged", winBefore.length > 0 && JSON.stringify(winBefore) === JSON.stringify(winAfter));

    // m13
    const accessLines = (r: Called) => r.lines.filter((l) => l.startsWith("access: "));
    const ids = [...new Set(hitsOf(orchard).map((x) => x.recordingId))];
    check(
      "m13 a search writes one access line: route mcp.search_transcripts.semantic, the member, the recordings returned",
      accessLines(orchard).length === 1 && ids.length > 0 && accessLines(orchard)[0] === `access: member=${fx.memberId} route=${ROUTE} recordings=${ids.length} ids=${ids.join(",")}`,
      JSON.stringify(orchard.lines),
    );
    check("m13 a refused search writes none", accessLines(byId).length === 0 && accessLines(both).length === 0, `${JSON.stringify(byId.lines)} | ${JSON.stringify(both.lines)}`);
    const forbidden = [Q_ORCHARD, Q_PRIVATE, Q_PERSONAL, "zanthorpe", "fennelwick", "packers", "Orchard planning", "Budget notes", "Family weekend", ...A1_LINES.map(([, t]) => t).filter((t) => t.length > 12)].map((w) => w.toLowerCase());
    const all = captured.join("").toLowerCase();
    const leaked = forbidden.filter((w) => all.includes(w));
    check("m13 no line written during the run holds the query, a word of a line, or a title", leaked.length === 0, `leaked: ${leaked.join(", ")}`);
    check("m13 control: those words came back in results", privOwner.text.includes("zanthorpe") && pPersonal.text.includes("fennelwick") && orchard.text.includes("packers"));

    await cd.close();
    await cm.close();
  } finally {
    await dropAccount(fx);
    await endPool();
  }
  console.log(`\n${failures === 0 ? `${WHO}: all passed` : `${WHO}: ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${WHO}: crashed: ${err instanceof Error ? `${err.name}: ${err.message.split("\n")[0].slice(0, 200)}` : "error"}`);
  process.exit(1);
});
