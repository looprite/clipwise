#!/usr/bin/env node
// Day logs older than 30 days are removed, by the date in the name, and nothing
// else is touched (SAA-243 item 7).
//
//   node check-day-logs.js
//   CLIPWISE_CHECK_SOURCE=c5b1408 node check-day-logs.js
//
// Cases 1-8 run pruneDayLogs against temporary folders. c5b1408 has no pruning,
// so with CLIPWISE_CHECK_SOURCE set a STAND-IN that removes nothing is checked
// in its place. Cases 9-11 read main.js and build-app.sh as text: they show the
// prune is called at launch and daily inside a catch, and that the bundle gets
// the module, not that any of it runs.

// Before any Date: a zone with daylight-saving changes on 2026-11-01 and 2027-03-14.
process.env.TZ = 'America/New_York';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REV = process.env.CLIPWISE_CHECK_SOURCE || '';
const fromRev = (file) => execFileSync('git', ['show', `${REV}:recorder/app/${file}`], { cwd: __dirname, encoding: 'utf8' });
const SRC = REV ? fromRev('main.js') : fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const BUILD = REV ? fromRev('build-app.sh') : fs.readFileSync(path.join(__dirname, 'build-app.sh'), 'utf8');
const pruneDayLogs = REV
    ? () => ({ removed: 0, failed: [] })
    : require('./day-logs.js').pruneDayLogs;

// recorder-YYYY-MM-DD.log for the local date `days` calendar days before `now`.
function dayLogName(now, days) {
    const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - days));
    const pad = (n) => String(n).padStart(2, '0');
    return `recorder-${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}.log`;
}

function folder(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-check-day-logs-'));
    for (const f of files) fs.writeFileSync(path.join(dir, f), `${f}\n`);
    return dir;
}
const listing = (dir) => new Map(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

// 1. The plain case: 31, 30 and 29 days, beside everything that is not a day log.
const NOW = new Date(2026, 9, 22, 12, 0);
const D31 = dayLogName(NOW, 31);
const D30 = dayLogName(NOW, 30);
const D29 = dayLogName(NOW, 29);
const STEM = '2026-09-01T10-00-00Z';
const UNTOUCHED = [
    'recovery.log', `pipeline-${STEM}.log`, `mic-${STEM}.log`, `systemtap-${STEM}.log`,
    `manifest-${STEM}.json`, 'recorder-notes.txt', 'recorder-2026-02-31.log', `${D31}.bak`,
    'recorder-2026-9-1.log',
];
const plain = folder([D31, D30, D29, ...UNTOUCHED]);
const plainBefore = listing(plain);
let plainResult, plainThrew = null;
try { plainResult = pruneDayLogs(plain, NOW); } catch (err) { plainThrew = err; }
const plainAfter = listing(plain);

// 2. Across the daylight-saving change: now is after 2026-11-01, the logs before it.
const DST_NOW = new Date(2026, 10, 15, 0, 30);
const DST30 = dayLogName(DST_NOW, 30);
const DST31 = dayLogName(DST_NOW, 31);
const dst = folder([DST30, DST31]);
let dstResult, dstThrew = null;
try { dstResult = pruneDayLogs(dst, DST_NOW); } catch (err) { dstThrew = err; }
const dstAfter = listing(dst);
const offsetBefore = new Date(2026, 9, 15, 12).getTimezoneOffset();
const offsetAfter = DST_NOW.getTimezoneOffset();

// 2b. Across the spring change: now is after 2027-03-14, the logs before it.
const SPRING_NOW = new Date(2027, 2, 20, 0, 30);
const SPRING30 = dayLogName(SPRING_NOW, 30);
const SPRING31 = dayLogName(SPRING_NOW, 31);
const spring = folder([SPRING30, SPRING31]);
let springResult, springThrew = null;
try { springResult = pruneDayLogs(spring, SPRING_NOW); } catch (err) { springThrew = err; }
const springAfter = listing(spring);
const springOffsetBefore = new Date(2027, 1, 17, 12).getTimezoneOffset();
const springOffsetAfter = SPRING_NOW.getTimezoneOffset();

// 3. One old log that cannot be removed (the user-immutable flag), beside two
// that can.
const STUCK = dayLogName(NOW, 40);
const OLD_A = dayLogName(NOW, 35);
const OLD_B = dayLogName(NOW, 45);
const failing = folder([STUCK, OLD_A, OLD_B, D29]);
execFileSync('chflags', ['uchg', path.join(failing, STUCK)]);
let stuckDirectly = null;
try { fs.unlinkSync(path.join(failing, STUCK)); } catch (err) { stuckDirectly = err.code; }
let failResult, failThrew = null;
try { failResult = pruneDayLogs(failing, NOW); } catch (err) { failThrew = err; }
const failAfter = listing(failing);
execFileSync('chflags', ['nouchg', path.join(failing, STUCK)]);

// The launch block and the wrapper, as text.
const wrapper = (/^function pruneDayLogsNow\(\) \{[\s\S]*?^}/m.exec(SRC) || [''])[0];
const launch = (/^app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*?^}\);/m.exec(SRC) || [''])[0];

const CASES = [
    ['plain: the log dated 31 days ago is removed, and nothing throws', () =>
        plainThrew === null && !plainAfter.has(D31)],
    ['plain: the logs dated 30 and 29 days ago are kept, byte for byte', () =>
        [D30, D29].every((f) => plainAfter.get(f) === plainBefore.get(f))],
    ['plain (control): recovery.log, every other log and file, a .bak and two names that are not real dates are untouched', () =>
        UNTOUCHED.every((f) => plainAfter.get(f) === plainBefore.get(f))],
    ['plain: it reports 1 removed and no failures', () =>
        plainResult && plainResult.removed === 1 && plainResult.failed.length === 0],
    [`daylight saving: now ${DST_NOW.toString().slice(0, 21)}, the log at 30 days (${DST30}) kept, at 31 days (${DST31}) removed`, () =>
        offsetBefore !== offsetAfter && dstThrew === null && dstAfter.has(DST30) && !dstAfter.has(DST31)
        && dstResult.removed === 1],
    [`daylight saving, spring: now ${SPRING_NOW.toString().slice(0, 21)}, the log at 30 days (${SPRING30}) kept, at 31 days (${SPRING31}) removed`, () =>
        springOffsetBefore !== springOffsetAfter && springThrew === null && springAfter.has(SPRING30) && !springAfter.has(SPRING31)
        && springResult.removed === 1],
    ['a log that cannot be removed (control: unlinking it directly fails)', () =>
        typeof stuckDirectly === 'string'],
    ['a log that cannot be removed: nothing throws, the two other old logs go, it stays, the 29-day log stays, its code is reported', () =>
        failThrew === null && !failAfter.has(OLD_A) && !failAfter.has(OLD_B) && failAfter.has(STUCK) && failAfter.has(D29)
        && failResult.removed === 2 && failResult.failed.length === 1 && failResult.failed[0] === stuckDirectly],
    ['main.js (text): the wrapper calls pruneDayLogs(OUTDIR) inside a try and logs a failure by its code only', () =>
        /try \{[\s\S]*pruneDayLogs\(OUTDIR\)[\s\S]*\} catch \(err\) \{\s*console\.error\(`\[clipwise-recorder\] day logs: prune failed — \$\{err\.code \|\| err\.name\}`\);/.test(wrapper)
        && wrapper.includes('day logs: prune failed — ${code}')],
    ['main.js (text): at launch it prunes once, then every 24 hours', () =>
        /pruneDayLogsNow\(\);\s*setInterval\(pruneDayLogsNow, DAY_LOG_PRUNE_INTERVAL_MS\);/.test(launch)
        && SRC.includes('const DAY_LOG_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;')],
    ['build-app.sh (text): copies day-logs.js into the bundle (main.js requires it)', () =>
        BUILD.includes('cp "$APP_SRC/day-logs.js" "$C/Resources/app/day-logs.js"')],
];

console.log(`source: ${REV ? `${REV} main.js and build-app.sh; pruneDayLogs: STAND-IN that removes nothing (c5b1408 has none)` : 'day-logs.js, main.js and build-app.sh in the checkout'}`);
console.log('expected to fail on c5b1408: cases 1, 4, 5, 6, 8, 9, 10 and 11, and nothing else');
console.log(`TZ=${process.env.TZ}; UTC offset 2026-10-15 ${-offsetBefore / 60} h, 2026-11-15 ${-offsetAfter / 60} h; 2027-02-17 ${-springOffsetBefore / 60} h, 2027-03-20 ${-springOffsetAfter / 60} h`);
console.log(`plain: now ${NOW.toString().slice(0, 21)}; 31 ${D31}, 30 ${D30}, 29 ${D29}; result ${JSON.stringify(plainResult)}; left: ${[...plainAfter.keys()].sort().join(', ')}`);
console.log(`daylight saving: result ${JSON.stringify(dstResult)}; left: ${[...dstAfter.keys()].sort().join(', ')}`);
console.log(`daylight saving, spring: result ${JSON.stringify(springResult)}; left: ${[...springAfter.keys()].sort().join(', ')}`);
console.log(`cannot remove: unlinking ${STUCK} directly -> ${stuckDirectly}; result ${JSON.stringify(failResult)}; left: ${[...failAfter.keys()].sort().join(', ')}`);
if (plainThrew || dstThrew || springThrew || failThrew) console.log(`threw: ${String(plainThrew || dstThrew || springThrew || failThrew)}`);
let fails = 0;
CASES.forEach(([name, fn], i) => {
    let ok = false;
    try { ok = !!fn(); } catch { ok = false; }
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${i + 1}. ${name}`);
});
for (const dir of [plain, dst, spring, failing]) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${CASES.length - fails}/${CASES.length} as expected`);
process.exit(fails ? 1 : 0);
