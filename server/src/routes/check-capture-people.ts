// DB-less check of the people rules in routes/capture-people.ts (SAA-260 step 1):
// normalizeName and nameKey (what two names are compared by), escapeLike (the
// search's LIKE pattern), decideCreate (step 2's same-name rule) and
// displayNameFor (the host's name). Every rule has its control: an input one
// change away that comes out the other way.
//
// No database: DATABASE_URL is set to a loopback port nothing listens on before
// anything is imported (db/index.ts requires one at import and connects only on
// a query), so a query made by mistake fails instead of reaching a database.
// The module is imported inside main(), so on code without it every case is
// reported as a FAIL rather than the file failing to load.
//
//   DOTENV_CONFIG_PATH=/dev/null npx --no-install tsx src/routes/check-capture-people.ts

process.env.DATABASE_URL = "postgres://check:check@127.0.0.1:1/none";

type Mod = typeof import("./capture-people.js");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

const cases: Array<[string, (m: Mod) => [boolean, string]]> = [
  // --- normalizeName / nameKey ----------------------------------------------
  ["name: trimmed, and a run of spaces, tabs or newlines is one space", (m) => {
    const got = m.normalizeName("  Ann \t\n  Lee  ");
    return [got === "Ann Lee", JSON.stringify(got)];
  }],
  ["name: control: a name with nothing to tidy comes back as it was", (m) => {
    const got = m.normalizeName("Ann Lee");
    return [got === "Ann Lee", JSON.stringify(got)];
  }],
  ["name: case and spacing do not make two names different (nameKey)", (m) => {
    const a = m.nameKey("ann  LEE"), b = m.nameKey(" Ann Lee ");
    return [a !== null && a === b, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`];
  }],
  ["name: control: a different letter does (Wiliam is not William)", (m) => {
    const a = m.nameKey("Wiliam Example"), b = m.nameKey("William Example");
    return [a !== b, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`];
  }],
  ["name: spaces inside a word are not ignored (AnnLee is not Ann Lee)", (m) => {
    return [m.nameKey("AnnLee") !== m.nameKey("Ann Lee"), `${m.nameKey("AnnLee")} / ${m.nameKey("Ann Lee")}`];
  }],
  ["name: the same letters written two Unicode ways are one name (NFC)", (m) => {
    const composed: string = "Jos\u00e9", decomposed: string = "Jose\u0301";
    // Guard: the two raw strings must differ, or this case proves nothing.
    if (composed === decomposed) return [false, "the composed and decomposed literals are equal before normalizing"];
    return [m.nameKey(composed) === m.nameKey(decomposed), `raw lengths ${composed.length} / ${decomposed.length}; nameKey lengths ${m.nameKey(composed)?.length} / ${m.nameKey(decomposed)?.length}`];
  }],
  ["name: one with an @ is refused (null)", (m) => [m.normalizeName("ann@example.test") === null, String(m.normalizeName("ann@example.test"))]],
  ["name: control: the same text without the @ is kept", (m) => [m.normalizeName("ann example.test") === "ann example.test", String(m.normalizeName("ann example.test"))]],
  ["name: empty, only spaces, or not a string is refused (null)", (m) => {
    const got = [m.normalizeName(""), m.normalizeName("   "), m.normalizeName(null), m.normalizeName(42)];
    return [got.every((g) => g === null), JSON.stringify(got)];
  }],
  ["name: longer than 256 after tidying is refused; 256 is kept (control)", (m) => {
    const over = m.normalizeName("a".repeat(257)), at = m.normalizeName(`  ${"a".repeat(256)}  `);
    return [over === null && at?.length === 256, `257 → ${over === null ? "null" : over.length}, 256 → ${at?.length}`];
  }],

  // --- escapeLike -----------------------------------------------------------
  ["like: %, _ and \\ are escaped so they match only themselves", (m) => {
    const got = m.escapeLike("50%_a\\b");
    return [got === "50\\%\\_a\\\\b", JSON.stringify(got)];
  }],
  ["like: control: plain text is unchanged", (m) => [m.escapeLike("Ann Lee") === "Ann Lee", JSON.stringify(m.escapeLike("Ann Lee"))]],

  // --- decideCreate ---------------------------------------------------------
  ["create: no one with the name, create one", (m) => {
    const d = m.decideCreate([]);
    return [d.kind === "create", JSON.stringify(d)];
  }],
  ["create: exactly one, use that person", (m) => {
    const d = m.decideCreate([{ id: "p1" }]);
    return [d.kind === "reuse" && d.personId === "p1", JSON.stringify(d)];
  }],
  ["create: the same person listed twice is still exactly one", (m) => {
    const d = m.decideCreate([{ id: "p1" }, { id: "p1" }]);
    return [d.kind === "reuse" && d.personId === "p1", JSON.stringify(d)];
  }],
  ["create: two or more, link nobody and create nothing", (m) => {
    const d = m.decideCreate([{ id: "p1" }, { id: "p2" }]);
    return [d.kind === "leave_unlinked" && d.count === 2, JSON.stringify(d)];
  }],

  // --- displayNameFor -------------------------------------------------------
  ["host: the stored name, trimmed", (m) => [m.displayNameFor("  Jon Example ") === "Jon Example", String(m.displayNameFor("  Jon Example "))]],
  ["host: empty, only spaces, or null is null", (m) => {
    const got = [m.displayNameFor(""), m.displayNameFor("  "), m.displayNameFor(null), m.displayNameFor(undefined)];
    return [got.every((g) => g === null), JSON.stringify(got)];
  }],
  ["host: an address is null", (m) => [m.displayNameFor("jd@example.test") === null, String(m.displayNameFor("jd@example.test"))]],
  ["host: control: the same text without the @ is the name", (m) => [m.displayNameFor("jd example.test") === "jd example.test", String(m.displayNameFor("jd example.test"))]],
];

async function main(): Promise<void> {
  let mod: Mod | null = null;
  let why = "";
  try {
    mod = await import("./capture-people.js");
  } catch (err) {
    why = `module not present (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`;
  }
  for (const [name, run] of cases) {
    if (!mod) {
      check(name, false, why);
      continue;
    }
    let result: [boolean, string];
    try {
      result = run(mod);
    } catch (err) {
      result = [false, `threw ${err instanceof Error ? err.message : String(err)}`];
    }
    check(name, result[0], result[1]);
  }
  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
