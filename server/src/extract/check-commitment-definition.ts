// Check for the commitment definition in pass 2's instructions (SAA-224 11-06,
// "the 66 read"): a person taking something on, or accepting a request, in
// their own words; a suggestion or a request for someone else to act is a
// discussion. Wording only: this checks what the model is told, not what it
// does with it. Real extraction against the database, with the model as
// extract/stub-model.ts.
//
//   d1  pass 2's instructions define a commitment as a person taking something
//       on, or accepting a request, in their own words
//   d2  and say a suggestion, or a request for someone else to act, is a
//       discussion
//   d3  the old definition ("someone commits to do something") is gone
//   d4  control (unchanged): the tool still offers the same seven kinds
//
//   scripts/scratch-db.sh run check-commitment-definition

import { dropAccount, endPool, makeAccount, makeRecording, refuseUnlessScratch } from "./fixtures-for-checks.js";
import { runExtraction } from "./extract.js";
import { makeStubModel } from "./stub-model.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

const NEW_DEFINITION = "a person takes something on, or accepts a request, in their own words";
const DISCUSSION = "A suggestion, or a request for someone else to act, is a discussion";
const OLD_DEFINITION = "someone commits to do something";
const KINDS = ["decision", "discussion", "question", "commitment", "initiative", "observation", "tangent"];

async function main(): Promise<void> {
  await refuseUnlessScratch("check-commitment-definition");
  process.env.ANTHROPIC_API_KEY = "stub-key";
  const fx = await makeAccount("check-commitment-definition");
  try {
    const rec = await makeRecording(fx, { segments: 4 });
    const stub = makeStubModel({ segmentCount: 4, phrase: "check-commitment-definition" });
    await runExtraction(rec, { client: stub.client });
    const pass2 = stub.bodies.filter((_, i) => stub.calls[i] === "pass2");
    const sent = pass2.map((b) => JSON.parse(b) as { system?: string; tools?: Array<{ input_schema?: unknown }> });
    const systems = sent.map((b) => String(b.system ?? ""));
    const enums = sent.map((b) => JSON.stringify(b.tools?.[0]?.input_schema ?? null));
    const all = (pred: (s: string) => boolean, list: string[]) => list.length > 0 && list.every(pred);
    const detail = `${pass2.length} pass 2 call(s)`;

    check("d1: pass 2's instructions define a commitment as a person taking something on, or accepting a request, in their own words", all((s) => s.includes(NEW_DEFINITION), systems), detail);
    check("d2: and say a suggestion, or a request for someone else to act, is a discussion", all((s) => s.includes(DISCUSSION), systems), detail);
    check("d3: the old definition (someone commits to do something) is gone", all((s) => !s.includes(OLD_DEFINITION), systems), detail);
    check(
      "d4: control (unchanged): the tool still offers the same seven kinds",
      all((e) => KINDS.every((k) => e.includes(`"${k}"`)), enums),
      `${detail}; ${enums[0] ?? ""}`.slice(0, 400),
    );
  } finally {
    await dropAccount(fx);
    await endPool();
  }
  console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
