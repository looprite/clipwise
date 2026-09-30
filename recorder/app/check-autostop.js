// Checks autostop.js's would-stop decision against event sequences (SAA-184).
//
// Usage:
//   node recorder/app/check-autostop.js           the real rule
//   node recorder/app/check-autostop.js --naive   a deliberately bad rule
//
// Two kinds of case. MUST STOP: the call ends and the grace window expires
// with nobody holding the mic. MUST NOT: reacquire inside the window, one of
// two helper pids releasing, a micwatch restart, another app releasing, a
// manual start, the 2026-09-09 17:46 shape, and a few more. The 09-09 case is
// simulated: no mic events were logged then (SAA-184, 2026-09-29).
//
// Measurement cases: a person presses Stop within seconds of hanging up, which
// cancels the window, so would_stop_at stays null even when the rule is right.
// `matched` mirrors the tally SQL (autostop-tally.sql): would_stop_at set and the
// trigger's mic not back after it, or a window still open at a manual stop.
// `detail` checks fields of the block that the tally reads.
//
// --naive swaps in "would stop on the first trigger release" (no pid set, no
// grace window, no holder check). It must FAIL several MUST NOT cases. If it
// doesn't, those cases can't tell a good rule from a bad one.
//
// Exit 0 when every case matches its expectation, 1 otherwise.

'use strict';

const { decide, GRACE_MS } = require('./autostop.js');

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
// A would-stop followed by the mic coming back never counts; a missing
// events_after_would_stop counts as 0, as in the SQL's coalesce.
const reacquiredAfterWouldStop = b => ((b.events_after_would_stop && b.events_after_would_stop.in_start) || 0) > 0;
const matched = b => !!((b.would_stop_at && !reacquiredAfterWouldStop(b))
    || (b.window_open_at_stop && b.stop_cause === 'manual'));

const CASES = [
    { name: 'call ends (Meet): release, window expires, nobody holds', expect: 'stop', at: m(30) + GRACE_MS,
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(30)), stop(m(35))] },
    { name: 'call ends (FaceTime key): same shape, avconferenced', expect: 'stop', at: m(20) + GRACE_MS,
      events: [start(FACETIME, [412]), off(FACETIME, 412, m(20)), stop(m(24))] },
    { name: 'two Chrome helpers, both release: window starts at the last', expect: 'stop', at: m(25) + GRACE_MS,
      events: [start(CHROME, [1337, 1338]), off(CHROME, 1338, m(20)), off(CHROME, 1337, m(25)), stop(m(40))] },
    { name: 'leave and rejoin, then end: only the final release stops', expect: 'stop', at: m(30) + GRACE_MS,
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(10)), on(CHROME, 1400, m(10, 40)),
               off(CHROME, 1400, m(30)), stop(m(35))] },

    { name: 'leave and rejoin within the window, stopped by hand later', expect: 'none', matched: false,
      detail: b => { const c = b.cancellations && b.cancellations[0];
          return !!c && c.opened_at === iso(m(10)) && c.cancelled_at === iso(m(11)) && c.reason === 'reacquire'; },
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(10)), on(CHROME, 1400, m(11)), stop(m(40))] },
    { name: 'mute releases then reacquires (10s), call continues', expect: 'none',
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
      events: [start(null, []), on(CHROME, 1337, m(1)), off(CHROME, 1337, m(20)), stop(m(30))] },
    { name: '09-09 17:46 shape: 14 min, speech ends at 4, mic still held', expect: 'none',
      events: [start(CHROME, [1337], Date.parse('2026-09-09T17:46:00Z')),
               stop(Date.parse('2026-09-09T18:00:00Z'))] },
    { name: 'stopped by hand inside the window', expect: 'none', matched: true,
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(29)), stop(m(30))] },
    { name: 'Meet: release, manual stop 5s later (09-28 shape): matched', expect: 'none', matched: true,
      detail: b => !!b.window_open_at_stop && b.window_open_at_stop.opened_at === iso(m(30))
          && b.window_open_at_stop.stopped_after_ms === 5000 && b.stop_cause === 'manual',
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(30)), stop(m(30, 5))] },
    { name: 'FaceTime: release, manual stop 5s later: matched', expect: 'none', matched: true,
      events: [start(FACETIME, [412]), off(FACETIME, 412, m(20)), stop(m(20, 5))] },
    { name: 'one of two helpers released, manual stop 5s later: not matched', expect: 'none', matched: false,
      detail: b => b.window_open_at_stop === null,
      events: [start(CHROME, [1337, 1338]), off(CHROME, 1338, m(30)), stop(m(30, 5))] },
    { name: 'would-stop fires, mic comes back after: reacquire not counted', expect: 'stop', at: m(10) + GRACE_MS, matched: false,
      detail: b => b.events_after_would_stop.in_start === 1 && b.events_after_would_stop.in_stop === 0,
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(10)), on(CHROME, 1400, m(15)), stop(m(40))] },
    { name: 'expiry check finds trigger still holding (missed in_start)', expect: 'none',
      holdersAt: () => [CHROME],
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(10)), stop(m(40))] },
    { name: 'expiry check fails (micwatch --once error)', expect: 'none',
      holdersAt: () => null,
      events: [start(CHROME, [1337]), off(CHROME, 1337, m(10)), stop(m(40))] },
];

// Would stop on the first trigger release, nothing else.
function naive(events) {
    const s = events.find(e => e.type === 'capture_start');
    const key = s && s.trigger && s.trigger.key;
    const rel = key && events.find(e => e.type === 'in_stop' && e.key === key);
    return { block: { would_stop_at: rel ? new Date(rel.t).toISOString() : null, would_stop_null_reason: rel ? null : 'no release' } };
}

const useNaive = process.argv.includes('--naive');
const rel = (iso, t0) => {
    if (!iso) return 'null';
    const s = Math.round((Date.parse(iso) - t0) / 1000);
    return `+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

console.log(`rule: ${useNaive ? 'NAIVE (first release, no window, no pid set, no holder check)' : `autostop.js, grace ${GRACE_MS / 1000}s`}`);
let fails = 0;
for (const c of CASES) {
    const r = useNaive ? naive(c.events) : decide(c.events, c.holdersAt ? { holdersAt: c.holdersAt } : {});
    const b = r.block;
    const t0 = c.events[0].t;
    let ok;
    if (c.expect === 'stop') ok = b.would_stop_at === new Date(c.at).toISOString();
    else ok = b.would_stop_at === null;
    if (ok && c.matched !== undefined && !(c.matched === matched(b))) ok = false;
    if (ok && c.detail && !c.detail(b)) ok = false;
    if (!ok) fails++;
    const exp = c.expect === 'stop' ? `must stop at ${rel(new Date(c.at).toISOString(), t0)}` : 'must not stop';
    const got = b.would_stop_at ? `would_stop_at ${rel(b.would_stop_at, t0)}` : `null (${b.would_stop_null_reason})`;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${exp.padEnd(19)}  ${got.padEnd(44)}  ${c.name}`);
}
console.log(`\n${CASES.length - fails}/${CASES.length} as expected`);
process.exit(fails ? 1 : 0);
