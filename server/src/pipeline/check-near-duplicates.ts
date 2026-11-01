// DB-less check of near-duplicates.ts (SAA-169; by name key since SAA-260 step
// 4), the rule check-name-duplicates.ts runs over an account's attendee and
// people names. Every rule has its control: an input one change away that comes
// out the other way.
//
// No database: DATABASE_URL is set to a loopback port nothing listens on before
// anything is imported (near-duplicates.ts imports capture-people.ts, which
// imports db/index.ts; that requires one at import and connects only on a
// query), so a query made by mistake fails instead of reaching a database. The
// module is imported inside main(), so on code without it every case is
// reported as a FAIL rather than the file failing to load.
//
//   DOTENV_CONFIG_PATH=/dev/null npx --no-install tsx src/pipeline/check-near-duplicates.ts

process.env.DATABASE_URL = "postgres://check:check@127.0.0.1:1/none";

type Mod = typeof import("./near-duplicates.js");

// Written as escapes so the two stay two different strings in the file.
const RENEE_COMPOSED: string = "Ren\u00e9e Lee";
const RENEE_DECOMPOSED: string = "Rene\u0301e Lee";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

// The rule before step 4, for the controls: lowercased only, no name key.
function pairsLowercaseOnly(m: Mod, names: string[]): Array<{ a: string; b: string; distance: number }> {
  const sorted = [...new Set(names)].sort();
  const out: Array<{ a: string; b: string; distance: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const distance = m.levenshtein(sorted[i].toLowerCase(), sorted[j].toLowerCase());
      if (distance > 0 && distance <= m.NEAR_DUPLICATE_MAX_DISTANCE) out.push({ a: sorted[i], b: sorted[j], distance });
    }
  }
  return out;
}

const cases: Array<[string, (m: Mod) => [boolean, string]]> = [
  ["pairs: two names one or two edits apart are a pair (SAA-169's own two)", (m) => {
    const r = m.nearDuplicates(["Lillian Dwyer", "Liillan Dwyer", "Manuel Casella", "Manual Casella"]);
    const got = r.pairs.map((p) => `${p.a}/${p.b}/${p.distance}`).sort();
    return [JSON.stringify(got) === JSON.stringify(["Liillan Dwyer/Lillian Dwyer/2", "Manual Casella/Manuel Casella/1"]), JSON.stringify(r)];
  }],
  ["pairs: control: unrelated names, more than two edits apart, are not", (m) => {
    const r = m.nearDuplicates(["Lillian Dwyer", "Dana Lee", "Bob Sample"]);
    return [r.pairs.length === 0 && r.distinctCount === 3, JSON.stringify(r)];
  }],
  ["key: spellings that share a name key (case, spacing) are one name, not a pair", (m) => {
    const r = m.nearDuplicates(["Ann Example", "ann  example", " ann  example ", "ANN EXAMPLE"]);
    return [r.pairs.length === 0 && r.distinctCount === 1, JSON.stringify(r)];
  }],
  ["key: control: \"Ann Example\" and \"ann  example\" (one extra space), compared lowercased only (the rule before), are a pair", (m) => {
    const got = pairsLowercaseOnly(m, ["Ann Example", "ann  example"]);
    return [got.length === 1 && got[0].distance === 1, JSON.stringify(got)];
  }],
  ["key: guard: the composed and decomposed Ren\u00e9e literals differ before normalising", () => {
    return [RENEE_COMPOSED !== RENEE_DECOMPOSED && RENEE_COMPOSED.length === 9 && RENEE_DECOMPOSED.length === 10, `${RENEE_COMPOSED.length} ${RENEE_DECOMPOSED.length}`];
  }],
  ["key: Unicode NFC: a composed and a decomposed é are one name", (m) => {
    const r = m.nearDuplicates([RENEE_COMPOSED, RENEE_DECOMPOSED]);
    return [r.pairs.length === 0 && r.distinctCount === 1, JSON.stringify(r)];
  }],
  ["key: control: compared without NFC, the two are a pair", (m) => {
    const got = pairsLowercaseOnly(m, [RENEE_COMPOSED, RENEE_DECOMPOSED]);
    return [got.length === 1, JSON.stringify(got)];
  }],
  ["key: a name with no key (an address, or empty) is left out", (m) => {
    const r = m.nearDuplicates(["ann@example.test", "", "   ", "Ann Example", null, 7]);
    return [r.distinctCount === 1 && r.pairs.length === 0, JSON.stringify(r)];
  }],
  ["key: control: the same list with the address replaced by a plain name (\"Ann Exampel\") counts it and pairs it, where the address gave 1 and none", (m) => {
    const withAddress = m.nearDuplicates(["ann@example.test", "", "   ", "Ann Example", null, 7]);
    const withName = m.nearDuplicates(["Ann Exampel", "", "   ", "Ann Example", null, 7]);
    const ok = withAddress.distinctCount === 1 && withAddress.pairs.length === 0
      && withName.distinctCount === 2 && withName.pairs.length === 1;
    return [ok, `with the address ${JSON.stringify(withAddress)}; with the name ${JSON.stringify(withName)}`];
  }],
  ["sameKey: a key stored under two or more spellings is listed, the spellings as stored and sorted", (m) => {
    const r = m.nearDuplicates(["Ann Example", " ann  example ", "Bob Sample", "Ann Example"]);
    const want = [{ key: "ann example", spellings: [" ann  example ", "Ann Example"] }];
    return [JSON.stringify(r.sameKey) === JSON.stringify(want) && r.pairs.length === 0, JSON.stringify(r)];
  }],
  ["sameKey: control: one spelling per key gives no sameKey entry", (m) => {
    const r = m.nearDuplicates(["Ann Example", "Ann Example", "Bob Sample"]);
    return [r.sameKey.length === 0 && r.distinctCount === 2, JSON.stringify(r)];
  }],
  ["pairs: a pair is shown by each key's first stored spelling, and a sameKey key can still pair", (m) => {
    const r = m.nearDuplicates(["Lillian Dwyer", "lillian  dwyer", "Liillan Dwyer"]);
    const ok = r.distinctCount === 2 && r.pairs.length === 1 && r.pairs[0].a === "Liillan Dwyer" && r.pairs[0].b === "Lillian Dwyer"
      && r.sameKey.length === 1 && JSON.stringify(r.sameKey[0].spellings) === JSON.stringify(["Lillian Dwyer", "lillian  dwyer"]);
    return [ok, JSON.stringify(r)];
  }],
];

async function main(): Promise<void> {
  let m: Mod | null = null;
  try {
    m = await import("./near-duplicates.js");
  } catch (err) {
    console.log(`near-duplicates.ts did not load: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  for (const [name, fn] of cases) {
    if (!m) { check(name, false, "module not loaded"); continue; }
    let result: [boolean, string];
    try { result = fn(m); } catch (err) { result = [false, `threw ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`]; }
    check(name, result[0], result[1]);
  }
  console.log(failures === 0 ? `\ncheck-near-duplicates: ${cases.length}/${cases.length} passed` : `\ncheck-near-duplicates: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
