// Check for fallbackTitleFor (SAA-135, SAA-230): the title a call gets when no
// calendar event names it, built from the people the member said were on it.
// Pure: no database, no network. Every name here is invented.
//
//   f1  a 1:1 with a named person: "Call with Ada Quill"
//   f2  two named guests: "Call with Ben Marlow and Cara Voss"
//   f3  three named guests: the first two, then "and 1 other"
//   f4  four named guests: the first two, then "and 2 others"
//   f5  nobody named: "Call"
//   f6  only the recorder's own labels, blanks and nulls: "Call"
//   f7  a personal call follows the same rule: "Call with Etta Quill"
//   f8  the host's own row is never in the title
//   f9  the same name twice, in another case or with spaces, counts once
//
//   npx tsx src/ingest/check-fallback-title.ts

import { fallbackTitleFor } from "./fallback-title.js";

let failures = 0;
function check(name: string, got: string, want: string): void {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n     want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
  if (!ok) failures++;
}

const guest = (name: string | null) => ({ name, isHost: false });
const host = (name: string | null) => ({ name, isHost: true });
const HOST = "Hal Brennan";

check("f1: a 1:1 with a named person", fallbackTitleFor([host(HOST), guest("Ada Quill")]), "Call with Ada Quill");
check("f2: two named guests", fallbackTitleFor([host(HOST), guest("Ben Marlow"), guest("Cara Voss")]), "Call with Ben Marlow and Cara Voss");
check(
  "f3: three named guests",
  fallbackTitleFor([guest("Ben Marlow"), guest("Cara Voss"), guest("Dov Ellery")]),
  "Call with Ben Marlow, Cara Voss and 1 other",
);
check(
  "f4: four named guests",
  fallbackTitleFor([guest("Ben Marlow"), guest("Cara Voss"), guest("Dov Ellery"), guest("Fen Okafor")]),
  "Call with Ben Marlow, Cara Voss and 2 others",
);
check("f5: nobody named", fallbackTitleFor([host(HOST)]), "Call");
check(
  "f6: only the recorder's own labels, blanks and nulls",
  fallbackTitleFor([guest(null), guest(""), guest("  "), guest("them"), guest("Voice 2"), guest("Unnamed voice 1"), guest("Unattributed")]),
  "Call",
);
check("f7: a personal call follows the same rule", fallbackTitleFor([host(HOST), guest("Etta Quill")]), "Call with Etta Quill");
check("f8: the host's own row is never in the title", fallbackTitleFor([host(HOST), host("Gil Arden")]), "Call");
check(
  "f9: the same name twice counts once",
  fallbackTitleFor([guest("Ada Quill"), guest(" ada quill "), guest("Ben Marlow")]),
  "Call with Ada Quill and Ben Marlow",
);

console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
