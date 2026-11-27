// Check for search_transcripts (11-27, Jon): a read-only MCP tool that finds
// words in transcript lines, with search_moments' visibility and personal/work
// scope, and get_transcript's numbering and speaker names.
//
// Runs the real MCP server (mcp/server.ts createMcpServer, so the tool table,
// the error path and the server's own log line are the real ones) over the
// SDK's in-memory transport, as two members of a throwaway account. Invented
// people only: Dana Whitlock records every call; Marco Feld is the other member
// and the far end of Dana's calls.
//
//   s1  the tool is listed, read-only, and its description says to read with
//       get_transcript and that it matches words, not meaning
//   s2  a known word is found once, at the right segment number, time and
//       speaker, with two shown lines either side, each exactly as
//       get_transcript prints it (an empty line in between is skipped there
//       and here); a word on Dana's own line names her as get_transcript does
//   s3  ignoring case, every word must be in the same line
//   s4  a made-up word returns 0 hits, totalMatches 0, truncated false
//   s5  Marco can't find a word in Dana's private call; asking for that call by
//       recordingId is recording_not_found, word for word the same as a made-up
//       recordingId; Dana finds it (control)
//   s6  a trashed call is not searched
//   s7  a personal call is not searched unless scope is personal or all;
//       scopeDefaulted is true only when scope is omitted
//   s8  dateFrom/dateTo bound the recording's start
//   s9  limit: 30 matches with limit 10 give 10 hits, totalMatches 30,
//       truncated true; limit 30 and no limit give 30, truncated false
//   s10 a result over the size cap is cut from the end and says so
//       (trimmedForSize, truncated, returned < totalMatches)
//   s11 every successful search writes exactly one access line naming the
//       member and the recordings returned; a refused one writes none; no line
//       written during the run holds a search word, a word of any line, or a
//       title. Control: the words are in what the tool returned.
//
// Writes, so it refuses unless run through scratch-db.sh on a scratch branch:
//
//   scripts/scratch-db.sh run check-search-transcripts

import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AccessContext } from "../access/context.js";
import { db, schema } from "../db/index.js";
import { dropAccount, endPool, makeAccount, refuseUnlessScratch, type Fixture } from "../extract/fixtures-for-checks.js";
import { createMcpServer } from "./server.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail.slice(0, 400)}`}`);
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

type Called = { isError: boolean; text: string; json: any; lines: string[] };

async function connect(ctx: AccessContext): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx).connect(serverSide);
  const client = new Client({ name: "check-search-transcripts", version: "1" });
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

// Words planted in exactly one call each (A4's in many lines of one call).
const KNOWN = "quillberry";
const PRIVATE_WORD = "zanthorpe";
const PERSONAL_WORD = "fennelwick";
const LIMIT_WORD = "limitword";
const BULK_WORD = "bulkword";
const MADE_UP = "nowherexyzzy";

type Line = ["me" | "them", string];

async function addMember(fx: Fixture, email: string): Promise<string> {
  const [m] = await db
    .insert(schema.accountMembers)
    .values({ accountId: fx.accountId, email, role: "member", joinedAt: new Date() })
    .returning();
  return m.id;
}

async function addCall(
  fx: Fixture,
  ownerId: string,
  o: { title: string; visibility: "shared" | "private"; scope: "work" | "personal"; startedAt: string; trashed?: boolean; lines: Line[] },
): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.recordings).values({
    id,
    accountId: fx.accountId,
    ownerMemberId: ownerId,
    slug: `check-${fx.tag}-${id.slice(0, 8)}`,
    title: o.title,
    source: "check",
    sourceId: id,
    status: "ready",
    visibility: o.visibility,
    scope: o.scope,
    startedAt: new Date(o.startedAt),
    durationSec: o.lines.length * 10,
    trashedAt: o.trashed ? new Date() : null,
    metadata: {},
  });
  const [transcript] = await db
    .insert(schema.transcripts)
    .values({ recordingId: id, provider: "check", language: "en", status: "ready" })
    .returning();
  // `me` has no name of its own: it takes the host attendee's, as on a real call.
  const [me] = await db.insert(schema.speakers).values({ recordingId: id, label: "me" }).returning();
  const [them] = await db.insert(schema.speakers).values({ recordingId: id, label: "them", displayName: MARCO }).returning();
  await db.insert(schema.attendees).values({ recordingId: id, name: DANA, isHost: true });
  await db.insert(schema.segments).values(
    o.lines.map(([who, text], i) => ({
      accountId: fx.accountId,
      recordingId: id,
      transcriptId: transcript.id,
      speakerId: who === "me" ? me.id : them.id,
      startSec: i * 10,
      endSec: i * 10 + 9,
      text,
      orderIndex: i,
    })),
  );
  return id;
}

// A1's lines. #5 is empty: get_transcript numbers it but doesn't show it.
const A1_LINES: Line[] = [
  ["me", "Thanks for joining, let's start with the agenda."],
  ["them", "Sounds good, I have the numbers ready."],
  ["me", "First item is the pricing page."],
  ["them", "The draft is in the shared folder."],
  ["me", "I read it this morning."],
  ["me", ""],
  ["them", `The ${KNOWN} tier needs a new pricing table.`],
  ["me", "Agreed, can you update it by Friday?"],
  ["them", "Yes, I will."],
  ["me", "Next, the launch email."],
  ["them", "That one is ready."],
  ["me", "Great, that's everything."],
];

async function main(): Promise<void> {
  await refuseUnlessScratch("check-search-transcripts");
  const fx = await makeAccount("check-search-transcripts");
  try {
    const marcoId = await addMember(fx, `marco-${fx.tag}@clipwise.test`);
    const dana: AccessContext = { accountId: fx.accountId, memberId: fx.memberId, role: "member", authUserId: randomUUID(), email: `dana-${fx.tag}@clipwise.test`, scope: [] };
    const marco: AccessContext = { accountId: fx.accountId, memberId: marcoId, role: "member", authUserId: randomUUID(), email: `marco-${fx.tag}@clipwise.test`, scope: [] };

    const a1 = await addCall(fx, fx.memberId, { title: "Pricing review", visibility: "shared", scope: "work", startedAt: "2026-11-20T15:00:00Z", lines: A1_LINES });
    const a2 = await addCall(fx, fx.memberId, {
      title: "Plan notes",
      visibility: "private",
      scope: "work",
      startedAt: "2026-11-18T15:00:00Z",
      lines: [["me", "Two things today."], ["them", `We should drop ${PRIVATE_WORD} from the plan.`], ["me", "Fine by me."]],
    });
    const a3 = await addCall(fx, fx.memberId, {
      title: "Family catch-up",
      visibility: "private",
      scope: "personal",
      startedAt: "2026-11-17T15:00:00Z",
      lines: [["me", "How was the trip?"], ["them", `The ${PERSONAL_WORD} cottage was lovely.`], ["me", "Glad to hear it."]],
    });
    const long = "x".repeat(400);
    await addCall(fx, fx.memberId, {
      title: "Long review",
      visibility: "shared",
      scope: "work",
      startedAt: "2026-11-16T15:00:00Z",
      lines: [
        ...Array.from({ length: 30 }, (_, i): Line => [i % 2 === 0 ? "me" : "them", `${LIMIT_WORD} line ${i}`]),
        ...Array.from({ length: 120 }, (_, i): Line => [i % 2 === 0 ? "me" : "them", `${BULK_WORD} line ${i} ${long}`]),
      ],
    });
    const a5 = await addCall(fx, fx.memberId, {
      title: "Trashed call",
      visibility: "shared",
      scope: "work",
      startedAt: "2026-11-21T15:00:00Z",
      trashed: true,
      lines: [["them", `A ${KNOWN} line in a trashed call.`]],
    });

    const cd = await connect(dana);
    const cm = await connect(marco);
    const hitsOf = (r: Called): any[] => (Array.isArray(r.json?.hits) ? r.json.hits : []);

    // s1
    const listed = await during(() => cd.listTools());
    const tool = listed.result.tools.find((t) => t.name === "search_transcripts");
    const desc = String(tool?.description ?? "");
    check(
      "s1: search_transcripts is listed, read-only, and its description says to read with get_transcript and that it matches words, not meaning",
      !!tool && tool.annotations?.readOnlyHint === true && desc.includes("get_transcript") && desc.includes("words, not meaning"),
      tool ? desc.slice(0, 300) : `tools: ${listed.result.tools.map((t) => t.name).join(", ")}`,
    );

    // s2: the hit against get_transcript's own lines.
    const tr = await call(cd, "get_transcript", { recordingId: a1 });
    const trLine = (n: number) => tr.text.split("\n").find((l) => l.startsWith(`[#${n} `)) ?? `(no #${n})`;
    check("control: get_transcript shows A1 with the known word, and leaves #5 out", tr.text.includes(KNOWN) && !tr.text.includes("[#5 "), tr.text.slice(0, 300));
    const known = await call(cd, "search_transcripts", { query: KNOWN });
    const h = hitsOf(known)[0];
    check(
      "s2: a known word is one hit in A1, at #6, 1:00, said by Marco Feld",
      hitsOf(known).length === 1 && known.json?.totalMatches === 1 && h?.recordingId === a1 && h?.recordingTitle === "Pricing review" && h?.segment === 6 && h?.time === "1:00" && h?.speaker === MARCO && h?.startedAt === "2026-11-20T15:00:00.000Z",
      known.text,
    );
    check(
      "s2: the hit's line and the two shown lines either side are exactly get_transcript's (#3, #4 before; #7, #8 after)",
      h?.line === trLine(6) && JSON.stringify(h?.before) === JSON.stringify([trLine(3), trLine(4)]) && JSON.stringify(h?.after) === JSON.stringify([trLine(7), trLine(8)]),
      JSON.stringify({ line: h?.line, before: h?.before, after: h?.after }),
    );
    const own = await call(cd, "search_transcripts", { query: "agenda" });
    const o = hitsOf(own)[0];
    check(
      "s2: a word on one of Dana's own lines is a hit at #0 said by Dana Whitlock, exactly as get_transcript shows it (no lines before, #1 and #2 after)",
      hitsOf(own).length === 1 && o?.segment === 0 && o?.speaker === DANA && o?.line === trLine(0) && trLine(0).includes(`] ${DANA}: `) && JSON.stringify(o?.before) === "[]" && JSON.stringify(o?.after) === JSON.stringify([trLine(1), trLine(2)]),
      JSON.stringify(o ?? own.text),
    );
    const asMarco = await call(cm, "search_transcripts", { query: KNOWN });
    check("s2: the other member finds it too in Dana's shared work call (control for s5)", hitsOf(asMarco).length === 1 && hitsOf(asMarco)[0]?.recordingId === a1, asMarco.text);

    // s3
    const both = await call(cd, "search_transcripts", { query: `${KNOWN.toUpperCase()} Pricing` });
    const split = await call(cd, "search_transcripts", { query: `${KNOWN} launch` });
    check("s3: every word, ignoring case, in the same line: 'QUILLBERRY Pricing' finds #6", hitsOf(both).length === 1 && hitsOf(both)[0]?.segment === 6, both.text);
    check("s3: words in two different lines don't match ('quillberry launch' is 0)", !split.isError && hitsOf(split).length === 0 && split.json?.totalMatches === 0, split.text);

    // s4
    const none = await call(cd, "search_transcripts", { query: MADE_UP, scope: "all" });
    check("s4: a made-up word returns 0 hits, totalMatches 0, truncated false", !none.isError && Array.isArray(none.json?.hits) && hitsOf(none).length === 0 && none.json?.totalMatches === 0 && none.json?.truncated === false, none.text);

    // s5
    const priv = await call(cm, "search_transcripts", { query: PRIVATE_WORD, scope: "all" });
    const privOwner = await call(cd, "search_transcripts", { query: PRIVATE_WORD, scope: "all" });
    check("s5: the other member can't find a word in Dana's private call", !priv.isError && hitsOf(priv).length === 0 && priv.json?.totalMatches === 0, priv.text);
    check("s5 control: Dana finds it in her own private call", hitsOf(privOwner).length === 1 && hitsOf(privOwner)[0]?.recordingId === a2, privOwner.text);
    const byId = await call(cm, "search_transcripts", { query: PRIVATE_WORD, recordingId: a2, scope: "all" });
    const madeUpId = await call(cm, "search_transcripts", { query: PRIVATE_WORD, recordingId: randomUUID(), scope: "all" });
    const byIdOwner = await call(cd, "search_transcripts", { query: PRIVATE_WORD, recordingId: a2, scope: "all" });
    check(
      "s5: asking for that call by recordingId is recording_not_found, the same text as a made-up recordingId",
      byId.isError && byId.text.includes("recording_not_found") && byId.text === madeUpId.text && madeUpId.isError,
      `${byId.text} | ${madeUpId.text}`,
    );
    check("s5 control: Dana can ask for it by recordingId", !byIdOwner.isError && hitsOf(byIdOwner).length === 1, byIdOwner.text);

    // s6
    const allKnown = await call(cd, "search_transcripts", { query: KNOWN, scope: "all" });
    check("s6: a trashed call is not searched (only A1 has the known word)", hitsOf(allKnown).length === 1 && hitsOf(allKnown)[0]?.recordingId === a1 && !allKnown.text.includes(a5), allKnown.text);

    // s7
    const pDefault = await call(cd, "search_transcripts", { query: PERSONAL_WORD });
    const pWork = await call(cd, "search_transcripts", { query: PERSONAL_WORD, scope: "work" });
    const pPersonal = await call(cd, "search_transcripts", { query: PERSONAL_WORD, scope: "personal" });
    const pAll = await call(cd, "search_transcripts", { query: PERSONAL_WORD, scope: "all" });
    check("s7: with scope omitted, a personal call isn't searched: 0 hits, scope work, scopeDefaulted true", hitsOf(pDefault).length === 0 && pDefault.json?.scope === "work" && pDefault.json?.scopeDefaulted === true, pDefault.text);
    check("s7: scope work: 0 hits, scopeDefaulted false", hitsOf(pWork).length === 0 && pWork.json?.scope === "work" && pWork.json?.scopeDefaulted === false, pWork.text);
    check("s7: scope personal and scope all find it, scopeDefaulted false", hitsOf(pPersonal).length === 1 && hitsOf(pPersonal)[0]?.recordingId === a3 && pPersonal.json?.scopeDefaulted === false && hitsOf(pAll).length === 1 && pAll.json?.scope === "all", `${pPersonal.text} | ${pAll.text}`);

    // s8
    const after = await call(cd, "search_transcripts", { query: KNOWN, dateFrom: "2026-11-21T00:00:00Z" });
    const before = await call(cd, "search_transcripts", { query: KNOWN, dateTo: "2026-11-19T00:00:00Z" });
    const inside = await call(cd, "search_transcripts", { query: KNOWN, dateFrom: "2026-11-19T00:00:00Z", dateTo: "2026-11-21T00:00:00Z" });
    check("s8: dateFrom/dateTo bound the recording's start", hitsOf(after).length === 0 && hitsOf(before).length === 0 && hitsOf(inside).length === 1, `${after.text} | ${before.text} | ${inside.text}`);

    // s9
    const l10 = await call(cd, "search_transcripts", { query: LIMIT_WORD, limit: 10 });
    const l30 = await call(cd, "search_transcripts", { query: LIMIT_WORD, limit: 30 });
    const lDefault = await call(cd, "search_transcripts", { query: LIMIT_WORD });
    check("s9: limit 10 of 30 matches: 10 hits, totalMatches 30, truncated true", hitsOf(l10).length === 10 && l10.json?.totalMatches === 30 && l10.json?.truncated === true, l10.text.slice(0, 300));
    check("s9: limit 30 and no limit: 30 hits, truncated false", hitsOf(l30).length === 30 && l30.json?.truncated === false && hitsOf(lDefault).length === 30 && lDefault.json?.truncated === false, `${l30.json?.totalMatches} ${lDefault.json?.totalMatches}`);
    check("s9: limit 10 gives the first 10 lines in order (#0 to #9)", JSON.stringify(hitsOf(l10).map((x) => x.segment)) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), JSON.stringify(hitsOf(l10).map((x) => x.segment)));

    // s10
    const big = await call(cd, "search_transcripts", { query: BULK_WORD, limit: 200 });
    check(
      "s10: a result over the size cap is cut from the end and says so",
      big.text.length <= 60_000 && big.json?.trimmedForSize === true && big.json?.truncated === true && big.json?.totalMatches === 120 && hitsOf(big).length === big.json?.returned && hitsOf(big).length >= 1 && hitsOf(big).length < 120,
      `${big.text.length}ch trimmed=${big.json?.trimmedForSize} returned=${big.json?.returned} total=${big.json?.totalMatches}`,
    );

    // s11
    const accessLines = (r: Called) => r.lines.filter((l) => l.startsWith("access: "));
    check(
      "s11: a successful search writes exactly one access line, naming the member and the recording returned",
      accessLines(known).length === 1 && accessLines(known)[0] === `access: member=${fx.memberId} route=mcp.search_transcripts recordings=1 ids=${a1}`,
      JSON.stringify(known.lines),
    );
    check(
      "s11: a search that returns nothing writes one line with ids=none; a refused one writes none",
      accessLines(none).length === 1 && accessLines(none)[0] === `access: member=${fx.memberId} route=mcp.search_transcripts recordings=0 ids=none` && accessLines(byId).length === 0,
      `${JSON.stringify(none.lines)} | ${JSON.stringify(byId.lines)}`,
    );
    const forbidden = [
      KNOWN, PRIVATE_WORD, PERSONAL_WORD, LIMIT_WORD, BULK_WORD, MADE_UP, "agenda", "pricing", "Pricing review", "Plan notes", "Family catch-up",
      ...A1_LINES.map(([, t]) => t).filter((t) => t.length > 12),
    ].map((w) => w.toLowerCase());
    const all = captured.join("").toLowerCase();
    const leaked = forbidden.filter((w) => all.includes(w));
    check("s11: no line written during the run holds a search word, a word of a line, or a title", leaked.length === 0, `leaked: ${leaked.join(", ")}`);
    check("s11 control: those words reached the tool and came back in its results", known.text.includes(KNOWN) && privOwner.text.includes(PRIVATE_WORD) && pAll.text.includes(PERSONAL_WORD));
    check("s11 control: the capture saw the server's own lines", captured.some((l) => l.includes("mcp: search_transcripts member=") || l.includes("mcp: get_transcript member=")), String(captured.length));

    await cd.close();
    await cm.close();
  } finally {
    await dropAccount(fx);
    await endPool();
  }
  console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`check-search-transcripts: ${err instanceof Error ? err.name : "error"}`);
  process.exit(1);
});
