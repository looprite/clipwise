// Regression check for endPoolWhenAuthSettled (auth/auth.ts): a script that
// calls getAuth() and then ends the pool must not leave Better Auth's
// initialisation running against a closed pool.
//
// getAuth() starts the init (a database read, then seeding the OAuth resources)
// and returns at once. This check calls it, with the init in flight, then the
// function under test, and fails if "Cannot use a pool after calling end" was
// logged, if the init did not resolve, or if the pool is not ended.
//
// Control (must fail): CLIPWISE_CHECK_CONTROL=bare-end ends the pool with
// pool.end() right after getAuth(), as migrate.ts used to.
//
// It writes to the database it is pointed at (the init seeds resource rows), so
// it needs a scratch database:
//   scratch-db.sh run check-pool-close

import { getAuth, endPoolWhenAuthSettled } from "./auth.js";
import { pool } from "../db/index.js";

if (process.env.CLIPWISE_CHECK_SCRATCH_DB !== "1") {
  process.stderr.write("check-pool-close: refusing to run — it writes to the database. Use scratch-db.sh run check-pool-close.\n");
  process.exit(2);
}
const CONTROL = process.env.CLIPWISE_CHECK_CONTROL ?? "";
if (CONTROL !== "" && CONTROL !== "bare-end") {
  process.stderr.write(`check-pool-close: unknown CLIPWISE_CHECK_CONTROL ${JSON.stringify(CONTROL)}\n`);
  process.exit(2);
}

let logged = "";
const realErr = console.error;
console.error = (...a: unknown[]) => {
  logged += a.map(String).join(" ") + "\n";
  realErr(...a);
};

const auth = getAuth();
let initState = "pending";
auth.$context.then(
  () => (initState = "resolved"),
  () => (initState = "rejected"),
);
// In flight = it has not settled by the next tick of the event loop. If the init
// were already done this would say so and the check would fail, because then it
// would not be testing what it claims to.
const inFlight =
  (await Promise.race([
    auth.$context.then(() => "settled", () => "settled"),
    new Promise((r) => setImmediate(() => r("pending"))),
  ])) === "pending";

if (CONTROL === "bare-end") await pool.end();
else await endPoolWhenAuthSettled();
// Let anything the init still had queued run before reading the log.
await new Promise((r) => setTimeout(r, 1500));

let failed = 0;
function check(ok: boolean, name: string): void {
  if (!ok) failed++;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}\n`);
}
check(inFlight, "the init was still in flight when the pool was ended (the case under test)");
check(!/Cannot use a pool after calling end/.test(logged), "no 'Cannot use a pool after calling end' was logged");
check(initState === "resolved", `the init resolved (it is ${initState})`);
check((pool as unknown as { ended: boolean }).ended === true, "the pool is ended");
process.stdout.write(`\n${4 - failed}/4 passed\n`);
process.exit(failed === 0 ? 0 : 1);
