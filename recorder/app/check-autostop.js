// Checks autostop.js's stop decision against event sequences (SAA-184).
//
// Usage:
//   node recorder/app/check-autostop.js           the real rule
//   node recorder/app/check-autostop.js --naive   a deliberately bad rule
//
// Live mode (2026-10-07): the rule now stops the capture, so a case is judged
// on the stop effect decide() collects, not on a log field alone.
//
// MUST STOP: the call ends and the grace window expires with nobody holding
// the mic. Exactly one stop effect, cause 'auto', at last release + GRACE_MS,
// and nothing after it is counted: the capture is over.
//
// MUST NOT: no stop effect at all. Reacquire inside the window (a live call
// that dropped and came back), one of two helper pids releasing, a micwatch
// restart, another app releasing, a manual start, a manual stop inside the
// window, a failed or contradicting holder check, and the 2026-09-09 17:46
// capture in two named forms (the mic held through 14 minutes of silence, and
// a brief release reacquired inside the window). Both 09-09 forms are
// simulated: no mic events were logged then.
//
// Muting does NOT release the mic (Meet 2026-09-29, FaceTime 1188a345), so no
// case models a mute as release + reacquire. The brief-release cases are
// labelled for what they are: a drop that comes back.
//
// A would-stop followed by the mic coming back is no longer observable on the
// same capture; it shows as a later capture and is the cut-short detector in
// autostop-tally.sql.
//
// --naive swaps in "stop on the first trigger release" (no pid set, no grace
// window, no holder check). It must FAIL several MUST NOT cases and the timing
// of the MUST STOP ones. If it doesn't, those cases can't tell a good rule
// from a bad one.
//
// The parse cases cover parseHoldersOnce, the one reader of `micwatch --once`
// output, using the real detectKey read out of main.js.
//
// Exit 0 when every case matches its expectation, 1 otherwise.

'use strict';

const fs = require('fs');
const path = require('path');
const { decide, GRACE_MS, parseHoldersOnce } = require('./autostop.js');

const CHROME = 'com.google.Chrome.helper';
const FACETIME = 'com.apple.avconferenced';
const FATHOM = 'com.fathom.video.helper';
const T0 = Date.parse('2026-09-29T15:00:00Z');
const m = (min, sec = 0) => T0 + (min * 60 + sec) * 1000;
const PATH = { [CHROME]: '/Applications/Google Chrome.app/…/Google Chrome Helper',
               [FACETIME]: '/usr/libexec/avconferenced', [FATHOM]: '/Applications/Fathom.app/…/Fathom Helper' };

const start = (key, pids, t = T0) => ({ type: 'capture_start', t, trigger: key ? { key, name: key } : null, pids });
const on = (key, pid, t) => ({ type: 'in_start', t, key, pid, path: PATH[key], mw_t: new Date(t).toISOString() });
const off = (key, pid, t) => ({ type: 'in_stop', t, key, pid, path: PATH[key], mw_t: new Date(t).toISOString() });
const stop = (t, cause = 'manual') => ({ type: 'stop', t, cause });

const iso = t => new Date(t).toISOString();
const D0909 = Date.parse('2026-09-09T17:46:00Z');
const m0909 = (min, sec = 0) => D0909 + (min * 60 + sec) * 1000;

const CASES = [
    { name: 'call ends (Meet): release, window expires, nobody holds', expect: 'stop', at: m(30) + GRACE_MS,
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(30)), stop(m(35))] },
    { name: 'call ends (FaceTime key): same shape, avconferenced', expect: 'stop', at: m(20) + GRACE_MS,
      events: [start(FACETIME, [412]), off(FACETIME, 412, m(20)), stop(m(24))] },
    { name: '722508a2 shape: release 14:16:50, stop at 14:18:50 (120s later)', expect: 'stop',
      at: Date.parse('2026-10-06T14:16:50.792Z') + GRACE_MS,
      events: [start(FACETIME, [804], Date.parse('2026-10-06T13:50:26.895Z')),
               off(FACETIME, 804, Date.parse('2026-10-06T14:16:50.792Z')),
               stop(Date.parse('2026-10-06T17:16:21.635Z'))],
      detail: b => b.pending_since === '2026-10-06T14:16:50.792Z' && b.stopped_at === '2026-10-06T14:18:50.792Z' },
    { name: 'two Chrome helpers, both release: window starts at the last', expect: 'stop', at: m(25) + GRACE_MS,
      events: [start(CHROME, [1337, 1338]), off(CHROME, 1338, m(20)), off(CHROME, 1337, m(25)), stop(m(40))] },
    { name: 'leave and rejoin, then end: only the final release stops', expect: 'stop', at: m(30) + GRACE_MS,
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(10)), on(CHROME, 1400, m(10, 40)),
               off(CHROME, 1400, m(30)), stop(m(35))] },
    { name: 'auto-stop, then the trigger reacquires: ignored, capture is over (detector territory)',
      expect: 'stop', at: m(10) + GRACE_MS,
      detail: b => b.events_after_would_stop.in_start === 0 && b.stop_cause === 'auto',
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(10)), on(CHROME, 1400, m(15)), stop(m(40))] },
    { name: 'manual Stop at the very instant of expiry: one stop, auto first', expect: 'stop', at: m(30) + GRACE_MS,
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(30)), stop(m(30) + GRACE_MS)] },

    { name: 'reacquire inside the window (a drop that came back), stopped by hand later', expect: 'none',
      detail: b => { const c = b.cancellations && b.cancellations[0];
          return !!c && c.opened_at === iso(m(10)) && c.cancelled_at === iso(m(11)) && c.reason === 'reacquire'; },
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(10)), on(CHROME, 1400, m(11)), stop(m(40))] },
    { name: 'FaceTime key: brief release, reacquired in 10s (not a mute: mute never releases)', expect: 'none',
      events: [start(FACETIME, [412]), off(FACETIME, 412, m(5)), on(FACETIME, 412, m(5, 10)), stop(m(30))] },
    { name: 'reacquire at 119s, one second before expiry', expect: 'none',
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(10)), on(CHROME, 1337, m(11, 59)), stop(m(40))] },
    { name: 'two Chrome helper pids, one releases', expect: 'none',
      events: [start(CHROME, [1337, 1338]), off(CHROME, 1338, m(10)), stop(m(30))] },
    { name: 'micwatch restarts inside the window', expect: 'none',
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(10)),
               { type: 'detector_exit', t: m(10, 30), code: null, signal: 'SIGKILL' },
               { type: 'detector_ready', t: m(10, 33) }, stop(m(40))] },
    { name: 'another app (Fathom) releases, trigger still holds', expect: 'none',
      events: [start(CHROME, [1337]), on(FATHOM, 900, m(1)), off(FATHOM, 900, m(20)), stop(m(30))] },
    { name: 'manually started capture, Chrome releases', expect: 'none',
      detail: b => b.would_stop_null_reason === 'manual_start',
      events: [start(null, []), on(CHROME, 1337, m(1)), off(CHROME, 1337, m(20)), stop(m(30))] },
    { name: '09-09 17:46 (a): mic held, 14 min of silence, no events', expect: 'none',
      detail: b => b.would_stop_null_reason === 'trigger_still_holding',
      events: [start(CHROME, [1337], D0909), stop(m0909(14))] },
    { name: '09-09 17:46 (b): brief release at 4 min, reacquired inside 120s', expect: 'none',
      detail: b => b.cancellations.length === 1 && b.cancellations[0].reason === 'reacquire',
      events: [start(CHROME, [1337], D0909), off(CHROME, 1337, m0909(4)), on(CHROME, 1337, m0909(4, 45)),
               stop(m0909(14))] },
    { name: 'stopped by hand inside the window: cause manual, no auto stop', expect: 'none',
      detail: b => b.stop_cause === 'manual' && !!b.window_open_at_stop,
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(29)), stop(m(30))] },
    { name: 'Meet: release, manual stop 5s later (09-28 shape)', expect: 'none',
      detail: b => !!b.window_open_at_stop && b.window_open_at_stop.opened_at === iso(m(30))
          && b.window_open_at_stop.stopped_after_ms === 5000 && b.stop_cause === 'manual',
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(30)), stop(m(30, 5))] },
    { name: 'one of two helpers released, manual stop 5s later', expect: 'none',
      detail: b => b.window_open_at_stop === null,
      events: [start(CHROME, [1337, 1338]), off(CHROME, 1338, m(30)), stop(m(30, 5))] },
    { name: 'expiry check finds trigger still holding (missed in_start)', expect: 'none',
      holdersAt: () => [CHROME],
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(10)), stop(m(40))] },
    { name: 'expiry check fails (micwatch --once error)', expect: 'none',
      holdersAt: () => null,
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(10)), stop(m(40))] },
];

// Stops on the first trigger release, nothing else.
function naive(events) {
    const s = events.find(e => e.type === 'capture_start');
    const key = s && s.trigger && s.trigger.key;
    const rel = key && events.find(e => e.type === 'in_stop' && e.key === key);
    return {
        stopEffects: rel ? [{ t: rel.t, cause: 'auto' }] : [],
        block: { would_stop_at: rel ? iso(rel.t) : null, stop_cause: rel ? 'auto' : null,
                 would_stop_null_reason: rel ? null : 'no release' },
    };
}

const useNaive = process.argv.includes('--naive');
const rel = (isoStr, t0) => {
    if (!isoStr) return 'null';
    const s = Math.round((Date.parse(isoStr) - t0) / 1000);
    return `+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

console.log(`rule: ${useNaive ? 'NAIVE (first release, no window, no pid set, no holder check)' : `autostop.js, live, grace ${GRACE_MS / 1000}s`}`);
let fails = 0;
for (const c of CASES) {
    const r = useNaive ? naive(c.events) : decide(c.events, c.holdersAt ? { holdersAt: c.holdersAt } : {});
    const b = r.block;
    const t0 = c.events[0].t;
    let ok;
    if (c.expect === 'stop') {
        ok = r.stopEffects.length === 1 && r.stopEffects[0].cause === 'auto'
            && b.would_stop_at === iso(c.at) && b.stop_cause === 'auto';
    } else {
        ok = r.stopEffects.length === 0 && b.would_stop_at === null && b.stop_cause !== 'auto';
    }
    // detail asserts fields of the real block; naive builds only enough of one
    // to be judged on whether it stops, so it is not held to them.
    if (ok && c.detail && !useNaive && !c.detail(b)) ok = false;
    if (!ok) fails++;
    const exp = c.expect === 'stop' ? `must stop at ${rel(iso(c.at), t0)}` : 'must not stop';
    const got = b.would_stop_at ? `auto stop ${rel(b.would_stop_at, t0)} x${r.stopEffects.length}` : `no stop (${b.would_stop_null_reason})`;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${exp.padEnd(19)}  ${got.padEnd(44)}  ${c.name}`);
}
console.log(`\nrule cases: ${CASES.length - fails}/${CASES.length} as expected`);

// --- parseHoldersOnce: the reader of `micwatch --once` ---------------------
// detectKey is read out of main.js and evaluated, so these cases exercise the
// real one rather than a copy that could drift from it.
let detectKey = null;
try {
    const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const mm = /function detectKey\(ev\) \{[\s\S]*?\n\}/.exec(src);
    detectKey = mm ? eval('(' + mm[0] + ')') : null; // eslint-disable-line no-eval
} catch { /* leaves detectKey null: every parse case then fails loudly */ }

const L = o => JSON.stringify(o);
const BIN = '/Applications/Clipwise.app/Contents/Resources/bin/';
const inNow = (pid, bundle, exe, p) => L({ event: 'in_now', pid, bundle, exe, path: p });
const PARSE = [
    { name: 'bundle ID wins: Chrome helper keyed by its bundle', out: inNow(1337, CHROME, 'Google Chrome Helper', PATH[CHROME]) + '\n',
      check: r => r.error === null && r.keys.length === 1 && r.keys[0] === CHROME && r.holders[0].exe === 'Google Chrome Helper' },
    { name: 'empty bundle -> exe:<name> (miccap, systemtap: the 722508a2 expiry)',
      out: inNow(5101, '', 'miccap', BIN + 'miccap') + '\n' + inNow(5102, '', 'systemtap', BIN + 'systemtap') + '\n',
      check: r => r.error === null && JSON.stringify(r.keys) === '["exe:miccap","exe:systemtap"]' },
    { name: 'other events are ignored (ready, in_start)',
      out: L({ event: 'ready', poll_ms: 500 }) + '\n' + L({ event: 'in_start', pid: 9, bundle: CHROME, exe: 'h' }) + '\n'
          + inNow(5101, '', 'miccap', BIN + 'miccap') + '\n',
      check: r => r.error === null && JSON.stringify(r.keys) === '["exe:miccap"]' },
    { name: 'unparseable line -> keys null, whole result unusable',
      out: inNow(5101, '', 'miccap', BIN + 'miccap') + '\n{oops\n',
      check: r => r.keys === null && r.holders === null && /^unparsed line: \{oops$/.test(r.error) },
    { name: 'a line that parses to null -> unusable, as before the refactor',
      out: 'null\n', check: r => r.keys === null && /^unparsed line: null$/.test(r.error) },
    { name: 'empty stdout -> keys [] (nothing holds the mic), no error',
      out: '', check: r => r.error === null && Array.isArray(r.keys) && r.keys.length === 0 && r.holders.length === 0 },
    { name: 'two pids under one bundle -> one key, two holders',
      out: inNow(1, CHROME, 'h', '/p') + '\n' + inNow(2, CHROME, 'h', '/p') + '\n',
      check: r => r.keys.length === 1 && r.holders.length === 2 },
    { name: 'missing fields do not throw',
      out: L({ event: 'in_now', pid: 9 }) + '\n',
      check: r => r.error === null && r.keys.length === 0 && r.holders[0].exe === null && r.holders[0].path === null },
];
let parseFails = 0;
for (const c of PARSE) {
    let ok = false;
    try { ok = !!detectKey && !!c.check(parseHoldersOnce(c.out, detectKey)); } catch { ok = false; }
    if (!ok) parseFails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  parse  ${c.name}`);
}
console.log(`parse cases: ${PARSE.length - parseFails}/${PARSE.length} as expected${detectKey ? '' : '  (detectKey NOT found in main.js)'}`);

const total = CASES.length + PARSE.length;
console.log(`\n${total - fails - parseFails}/${total} as expected`);
process.exit(fails || parseFails ? 1 : 0);
