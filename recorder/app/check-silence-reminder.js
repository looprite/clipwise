// Checks silence-reminder.js, the "Still recording?" decision, and how main.js
// wires it.
//
// Usage:
//   node recorder/app/check-silence-reminder.js                the real rule
//   node recorder/app/check-silence-reminder.js --naive        re-arms without sound
//   node recorder/app/check-silence-reminder.js --naive-end    a stop does not end the tracker
//
// Four groups:
//
//   RULE. Audio sequences in, effects out: the 60s window and its boundary, the
//   -90 dBFS threshold, Keep / no answer / Stop, and the re-arm rule (Keep, then
//   still silent: no repeat; Keep, sound, then 60s of silence: a repeat).
//
//   STOPS. Auto-stop, any stop, or sound returning while a reminder is pending
//   withdraws it, and after that no click can send a Stop; a Stop answer sends
//   exactly one.
//
//   WIRING. Static checks on main.js and build-app.sh: the reminder's Stop goes
//   through stopRecording with the module's cause, the notification is silent
//   with Keep before Stop, the tracker is ended inside autostopFinish (every
//   stop path), the tap is read only while recording, and nothing in the
//   section looks at the mic.
//
//   REPLAY. The real raw tap files, streamed in 250 ms pieces through the same
//   peak/seconds/step main.js uses. They live in the recordings directory
//   (CLIPWISE_REPLAY_DIR to point elsewhere) and are never copied into the repo;
//   a case whose file is missing is SKIPPED and says so.
//     722508a2 must fire about 60s after the call ended (the trigger's last
//     release, 1583.9s into the capture; the tap then stayed digitally silent
//     for 3 hours until it was stopped by hand).
//     8501012e and 8a473889, normal calls, are expected not to fire at all.
//     2026-09-21T14-30-30Z has one real 73s stretch of digital silence in the
//     middle of a call: it is expected to fire there, once. That is the kind of
//     firing the rule allows and a person answers Keep to.
//
// --naive re-arms without waiting for sound, so Keep and no-answer both repeat;
// --naive-end ignores the end of the capture, so a pending reminder survives it
// and a later Stop click sends a stop. Each must FAIL cases. If it doesn't, those
// cases can't tell a good rule from a bad one.
//
// Exit 0 when every case matches its expectation (SKIPs are reported, not
// failed), 1 otherwise.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const SR = require('./silence-reminder.js');

const MODE = process.argv.includes('--naive') ? 'rearm' : process.argv.includes('--naive-end') ? 'end' : 'real';
const stepFn =
    MODE === 'rearm' ? (st, ev) => SR.step(ev.type === 'audio' ? { ...st, armed: true } : st, ev)
  : MODE === 'end'   ? (st, ev) => (ev.type === 'end' ? { state: st, out: [] } : SR.step(st, ev))
  : SR.step;

const T0 = Date.parse('2026-10-08T10:00:00Z');
const QUIET = 0;          // digital silence
const LOUD = 0.1;         // about -20 dBFS

// A capture's audio and answers, in order. `now` is audio time since T0.
class Sim {
    constructor() { this.st = SR.initialState(T0); this.now = 0; this.effects = []; this.logs = []; }
    _apply(r) {
        this.st = r.state;
        for (const o of r.out) (o.kind === 'log' ? this.logs : this.effects).push(o);
    }
    audio(seconds, peak, chunk = 0.25) {
        let left = seconds;
        while (left > 1e-9) {
            const c = Math.min(chunk, left);
            this.now += c; left -= c;
            this._apply(stepFn(this.st, { type: 'audio', t: T0 + this.now * 1000, seconds: c, peak }));
        }
        return this;
    }
    respond(response) { this._apply(stepFn(this.st, { type: 'response', t: T0 + this.now * 1000, response })); return this; }
    expire() { this._apply(stepFn(this.st, { type: 'expire', t: T0 + this.now * 1000 })); return this; }
    end(cause) { this._apply(stepFn(this.st, { type: 'end', t: T0 + this.now * 1000, cause })); return this; }
    n(kind) { return this.effects.filter((o) => o.kind === kind).length; }
    get reminders() { return this.st.reminders; }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cases = [];
const add = (group, name, fn) => cases.push({ group, name, fn });

// --- RULE ---------------------------------------------------------------

add('RULE', '59.75s of silence: no reminder; the chunk that reaches 60.0s: exactly one', () => {
    const s = new Sim().audio(59.75, QUIET);
    if (s.n('show') !== 0) return `shown at ${s.now}s`;
    s.audio(0.25, QUIET);
    return s.n('show') === 1 ? null : `${s.n('show')} shown`;
});
add('RULE', 'sound at 30s resets the count: not shown at 60s, shown 60s after the sound', () => {
    const s = new Sim().audio(30, QUIET).audio(0.25, LOUD).audio(59.75, QUIET);
    if (s.n('show') !== 0) return 'shown before 60s of new silence';
    s.audio(0.25, QUIET);
    return s.n('show') === 1 ? null : 'not shown at 60s of new silence';
});
add('RULE', 'threshold: peak just under -90 dBFS is silent, just over is sound', () => {
    const under = new Sim().audio(60, SR.THRESHOLD_LINEAR * 0.99);
    const over = new Sim().audio(60, SR.THRESHOLD_LINEAR * 1.01);
    return under.n('show') === 1 && over.n('show') === 0 ? null : `under shown ${under.n('show')}, over shown ${over.n('show')}`;
});
add('RULE', 'the window is 60s and the threshold -90 dBFS', () =>
    SR.WINDOW_S === 60 && SR.THRESHOLD_DBFS === -90 ? null : `${SR.WINDOW_S}s, ${SR.THRESHOLD_DBFS} dBFS`);
add('RULE', 'the same audio in 0.25s, 1s and odd-sized chunks shows one reminder at the same moment', () => {
    const at = (chunk) => { const s = new Sim().audio(75, QUIET, chunk); return [s.n('show'), s.reminders[0] && s.reminders[0].shown_at_s]; };
    const a = at(0.25), b = at(1), c = at(0.256);
    return a[0] === 1 && b[0] === 1 && c[0] === 1 && Math.abs(a[1] - b[1]) <= 1 && Math.abs(a[1] - c[1]) <= 1 ? null : JSON.stringify([a, b, c]);
});
add('RULE', 'Keep, then still silent for 10 more minutes: no repeat', () => {
    const s = new Sim().audio(60, QUIET).respond('keep').audio(600, QUIET);
    return s.n('show') === 1 && s.n('stop') === 0 ? null : `${s.n('show')} shown, ${s.n('stop')} stops`;
});
add('RULE', 'Keep, sound, 59.75s of silence: nothing; then 60s: a second reminder', () => {
    const s = new Sim().audio(60, QUIET).respond('keep').audio(5, LOUD).audio(59.75, QUIET);
    if (s.n('show') !== 1) return `${s.n('show')} shown before 60s`;
    s.audio(0.25, QUIET);
    return s.n('show') === 2 && s.reminders.length === 2 ? null : `${s.n('show')} shown`;
});
add('RULE', 'no answer (withdrawn after the TTL), still silent: no repeat and no stop', () => {
    const s = new Sim().audio(60, QUIET).expire().audio(600, QUIET);
    return s.n('show') === 1 && s.n('stop') === 0 && s.reminders[0].response === 'none' && s.reminders[0].closed_by === 'no_answer'
        ? null : JSON.stringify(s.reminders[0]);
});
add('RULE', 'no answer, then sound and 60s of silence: a second reminder', () => {
    const s = new Sim().audio(60, QUIET).expire().audio(5, LOUD).audio(60, QUIET);
    return s.n('show') === 2 ? null : `${s.n('show')} shown`;
});
add('RULE', 'the reminder never stops anything by itself: 3 hours of silence, no answer, no stop', () => {
    const s = new Sim().audio(60, QUIET, 1).expire().audio(3 * 3600, QUIET, 1);
    return s.n('stop') === 0 ? null : `${s.n('stop')} stops`;
});

// --- STOPS --------------------------------------------------------------

add('STOPS', 'Stop answer: exactly one stop effect, cause silence-reminder, reminder logged as stop', () => {
    const s = new Sim().audio(60, QUIET).respond('stop');
    const stops = s.effects.filter((o) => o.kind === 'stop');
    return stops.length === 1 && stops[0].cause === 'silence-reminder' && s.reminders[0].response === 'stop' && s.reminders[0].responded_at_s != null
        ? null : JSON.stringify({ stops, r: s.reminders[0] });
});
add('STOPS', 'a second Stop click, or a late Keep, after the answer sends nothing', () => {
    const s = new Sim().audio(60, QUIET).respond('stop').respond('stop').respond('keep');
    return s.n('stop') === 1 ? null : `${s.n('stop')} stops`;
});
add('STOPS', 'the stop that Stop causes ends the tracker (cause silence-reminder): no second stop', () => {
    const s = new Sim().audio(60, QUIET).respond('stop').end('silence-reminder').respond('stop');
    return s.n('stop') === 1 ? null : `${s.n('stop')} stops`;
});
add('STOPS', 'auto-stop while a reminder is pending: withdrawn, logged none/capture_stopped:auto, a later Stop click sends no stop', () => {
    const s = new Sim().audio(60, QUIET).end('auto').respond('stop');
    const r = s.reminders[0];
    return s.n('stop') === 0 && s.n('withdraw') === 1 && r.response === 'none' && r.closed_by === 'capture_stopped:auto'
        ? null : JSON.stringify({ stops: s.n('stop'), withdraws: s.n('withdraw'), r });
});
add('STOPS', 'a manual stop while a reminder is pending: same, no stop sent', () => {
    const s = new Sim().audio(60, QUIET).end('manual').respond('stop');
    return s.n('stop') === 0 && s.reminders[0].closed_by === 'capture_stopped:manual' ? null : JSON.stringify(s.reminders[0]);
});
add('STOPS', 'sound returns while pending: withdrawn as none/sound_returned, a late Stop click cannot end the live call', () => {
    const s = new Sim().audio(60, QUIET).audio(0.25, LOUD).respond('stop');
    const r = s.reminders[0];
    return s.n('stop') === 0 && s.n('withdraw') === 1 && r.response === 'none' && r.closed_by === 'sound_returned'
        ? null : JSON.stringify({ stops: s.n('stop'), r });
});
add('STOPS', 'after the capture ends, audio, answers and the TTL do nothing', () => {
    const s = new Sim().end('manual');
    s.audio(300, QUIET).respond('stop').expire();
    return s.effects.length === 0 && s.reminders.length === 0 ? null : JSON.stringify(s.effects);
});
add('STOPS', 'a stop with no reminder pending has nothing to withdraw', () => {
    const s = new Sim().audio(10, QUIET).end('manual');
    return s.n('withdraw') === 0 && s.n('stop') === 0 ? null : 'effects on an idle end';
});

// --- BLOCK, PEAK --------------------------------------------------------

add('BLOCK', 'block: settings, detector state and each reminder with its response, shown_at_s into the capture', () => {
    const s = new Sim().audio(70, QUIET).respond('keep').audio(30, LOUD).audio(60, QUIET).expire().end('manual');
    const b = SR.silenceBlock(s.st, null);
    const ok = b.silence_window_s === 60 && b.silence_threshold_dbfs === -90 && b.silence_detector_off === null
        && b.silence_reminders.length === 2
        && b.silence_reminders[0].response === 'keep' && b.silence_reminders[0].shown_at_s === 60 && b.silence_reminders[0].responded_at_s === 70
        && b.silence_reminders[1].response === 'none' && b.silence_reminders[1].closed_by === 'no_answer' && b.silence_reminders[1].shown_at_s === 160;
    return ok ? null : JSON.stringify(b);
});
add('BLOCK', 'a capture where nothing was shown still carries an empty list, and a disabled detector says why', () => {
    const b = SR.silenceBlock(new Sim().audio(5, LOUD).st, null);
    const off = SR.silenceBlock(SR.initialState(T0), 'tap is not 32-bit float');
    return Array.isArray(b.silence_reminders) && b.silence_reminders.length === 0 && off.silence_detector_off === 'tap is not 32-bit float'
        ? null : JSON.stringify([b, off]);
});
add('PEAK', 'peakOfF32: largest |sample|; negatives count; a trailing partial sample is ignored', () => {
    const f = Float32Array.from([0.1, -0.5, 0.2]);
    const buf = Buffer.concat([Buffer.from(f.buffer), Buffer.from([1, 2])]);
    return SR.peakOfF32(buf) === Math.fround(0.5) ? null : String(SR.peakOfF32(buf));
});
add('PEAK', 'peakOfF32: NaN reads as sound (never silence); empty is 0; stopAt returns early', () => {
    const nan = Buffer.from(Float32Array.from([0, NaN, 0]).buffer);
    const early = Buffer.from(Float32Array.from([0.5, 0.9]).buffer);
    return SR.peakOfF32(nan) === Infinity && SR.peakOfF32(Buffer.alloc(0)) === 0 && SR.peakOfF32(early, 0.4) === Math.fround(0.5)
        ? null : `${SR.peakOfF32(nan)} ${SR.peakOfF32(Buffer.alloc(0))} ${SR.peakOfF32(early, 0.4)}`;
});
add('PEAK', 'feedBytes: seconds come from bytes over the byte rate; silence in 4 chunks of 15s reaches 60s', () => {
    const bps = 48000 * 4;
    let st = SR.initialState(T0), shown = 0;
    for (let i = 0; i < 4; i++) {
        const r = SR.feedBytes(st, Buffer.alloc(15 * bps), T0 + (i + 1) * 15000, bps);
        st = r.state; shown += r.out.filter((o) => o.kind === 'show').length;
    }
    return shown === 1 ? null : `${shown} shown`;
});

// --- WIRING -------------------------------------------------------------

const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'build-app.sh'), 'utf8');
const section = mainSrc.slice(mainSrc.indexOf('// --- "Still recording?"'), mainSrc.indexOf('function autostopFinish'));
const fn = (name) => { const i = mainSrc.indexOf(`function ${name}(`); return i < 0 ? '' : mainSrc.slice(i, mainSrc.indexOf('\n}\n', i)); };

add('WIRING', 'the only stop the reminder sends is the module\'s own effect, through stopRecording', () => {
    const apply = fn('silenceApply');
    return /o\.kind === 'stop'\) stopRecording\(o\.cause\)/.test(apply) && SR.STOP_CAUSE === 'silence-reminder'
        && (section.match(/stopRecording\(/g) || []).length === 1 ? null : 'stop is sent from somewhere else, or with another cause';
});
add('WIRING', 'the notification is silent, titled "Still recording?", Keep before Stop, with no osascript fallback', () => {
    const show = fn('silenceShow');
    const k = show.indexOf("text: 'Keep'"), st = show.indexOf("text: 'Stop'");
    if (!/silent:\s*true/.test(show)) return 'not silent';
    if (!/title = 'Still recording\?'/.test(show)) return 'wrong title';
    if (k < 0 || st < 0 || k > st) return 'Keep is not first';
    if (/notifyFallback\(/.test(show)) return 'falls back to osascript';
    return null;
});
add('WIRING', 'Keep is action 0 and Stop is action 1; an answer for an ended capture is ignored', () => {
    const show = fn('silenceShow');
    return /index === 0 \? 'keep' : 'stop'/.test(show) && /if \(session !== s\) return;/.test(show) ? null : 'mapping or guard missing';
});
add('WIRING', 'every stop path ends the tracker: autostopFinish calls silenceEnd first, and stopRecording and quitApp both call autostopFinish', () => {
    const fin = fn('autostopFinish');
    const first = fin.indexOf('silenceEnd(s, cause)'), guard = fin.indexOf('if (!a) return;');
    return first >= 0 && first < guard && /autostopFinish\(session, stopCause\)/.test(fn('stopRecording')) && /autostopFinish\(session, 'quit'\)/.test(fn('quitApp'))
        ? null : 'a stop path skips silenceEnd';
});
add('WIRING', 'the tap is read from pollTick only while the state is recording', () => {
    const poll = fn('pollTick');
    return /if \(state === 'recording'\) silenceTick\(s, tapSize\)/.test(poll) ? null : 'silenceTick is not gated on recording';
});
add('WIRING', 'tap only: the section never touches the mic track', () =>
    /paths\.mic|micSize|growth\.mic/.test(section) ? 'the reminder section reads the mic' : null);
add('WIRING', 'the block is merged into autostop\'s, and build-app.sh bundles the module', () =>
    /Object\.assign\(block, silenceReminder\.silenceBlock\(s\.silence\.st, s\.silence\.off\)\)/.test(fn('autostopFinish'))
    && /cp "\$APP_SRC\/silence-reminder\.js" "\$C\/Resources\/app\/silence-reminder\.js"/.test(buildSrc)
        ? null : 'block merge or bundle copy missing');
add('WIRING', 'a read or format problem turns the detector off for that capture and cannot throw out of pollTick', () => {
    const tick = fn('silenceTick');
    return /catch \(err\) \{\s*silenceDisable\(s, String\(err\)\);/.test(tick) && /is not 32-bit float/.test(tick) ? null : 'no containment';
});

// --- REPLAY -------------------------------------------------------------

const DIR = process.env.CLIPWISE_REPLAY_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Clipwise', 'recordings');
const BPS = 48000 * 4;
const CHUNK = BPS / 4; // 250 ms, the poll interval

function callEndS(stem) {
    let t0 = null, last = null;
    for (const line of fs.readFileSync(path.join(DIR, `autostop-${stem}.log`), 'utf8').split('\n')) {
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.event === 'capture_start') t0 = Date.parse(j.t);
        if (j.event === 'in_stop') last = Date.parse(j.received_t);
    }
    return t0 != null && last != null ? (last - t0) / 1000 : null;
}

// Streams the file through the same feedBytes main.js uses; no answers are given.
function replay(stem) {
    const file = path.join(DIR, `system-${stem}.f32le.pcm`);
    if (!fs.existsSync(file)) return null;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CHUNK);
    let st = SR.initialState(0), off = 0;
    for (;;) {
        const got = fs.readSync(fd, buf, 0, CHUNK, off);
        const use = got - (got % 4);
        if (use <= 0) break;
        off += use;
        st = SR.feedBytes(st, buf.subarray(0, use), (off / BPS) * 1000, BPS).state;
        if (got < CHUNK) break;
    }
    fs.closeSync(fd);
    return { seconds: off / BPS, reminders: st.reminders };
}
const info = [];
add('REPLAY', '722508a2: fires about 60s after the call ended, not before', () => {
    const stem = '2026-10-06T13-50-26Z';
    const r = replay(stem);
    if (!r) return 'SKIP';
    const end = callEndS(stem);
    const first = r.reminders[0];
    if (!first) return `never fired in ${r.seconds.toFixed(0)}s`;
    info.push(`722508a2: call ended at ${end.toFixed(1)}s (trigger's last release), reminder shown at ${first.shown_at_s}s = ${(first.shown_at_s - end).toFixed(1)}s after; ${r.reminders.length} reminder(s) in ${r.seconds.toFixed(0)}s of tap`);
    return first.shown_at_s >= end + 55 && first.shown_at_s <= end + 75 && r.reminders.length === 1 ? null : `shown at ${first.shown_at_s}s, call ended ${end.toFixed(1)}s, ${r.reminders.length} reminders`;
});
for (const [id, stem] of [['8501012e', '2026-10-05T17-01-07Z'], ['8a473889', '2026-10-06T19-08-31Z']]) {
    add('REPLAY', `${id}, a normal call: no reminder during it`, () => {
        const r = replay(stem);
        if (!r) return 'SKIP';
        info.push(`${id}: ${r.reminders.length} reminder(s) in ${r.seconds.toFixed(0)}s of tap${r.reminders.length ? ' at ' + r.reminders.map((x) => x.shown_at_s + 's').join(', ') : ''}`);
        return r.reminders.length === 0 ? null : `fired at ${r.reminders.map((x) => x.shown_at_s + 's').join(', ')}`;
    });
}
add('REPLAY', '2026-09-21T14-30-30Z: one real 73s digital silence in the middle of a call fires once, there (allowed)', () => {
    const r = replay('2026-09-21T14-30-30Z');
    if (!r) return 'SKIP';
    info.push(`2026-09-21T14-30-30Z: ${r.reminders.length} reminder(s) in ${r.seconds.toFixed(0)}s of tap${r.reminders.length ? ' at ' + r.reminders.map((x) => x.shown_at_s + 's').join(', ') : ''} (the silent stretch starts at 432s)`);
    return r.reminders.length === 1 && r.reminders[0].shown_at_s >= 489 && r.reminders[0].shown_at_s <= 497 ? null : `fired at ${r.reminders.map((x) => x.shown_at_s + 's').join(', ') || 'never'}`;
});

// --- run ----------------------------------------------------------------

console.log(`rule: ${MODE === 'real' ? 'silence-reminder.js' : MODE === 'rearm' ? 'NAIVE (re-arms without sound)' : 'NAIVE (a stop does not end the tracker)'}`);
let fails = 0, skips = 0;
for (const c of cases) {
    let why;
    try { why = c.fn(); } catch (e) { why = `threw ${String(e && e.stack || e)}`; }
    const tag = why === null ? 'PASS' : why === 'SKIP' ? 'SKIP' : 'FAIL';
    if (tag === 'FAIL') fails++;
    if (tag === 'SKIP') skips++;
    console.log(`${tag}  [${c.group}] ${c.name}${tag === 'FAIL' ? ' — ' + why : tag === 'SKIP' ? ' — recordings not found in ' + DIR : ''}`);
}
if (info.length) { console.log('\nreplay results:'); for (const l of info) console.log('  ' + l); }
const ran = cases.length - skips;
console.log(`\n${ran - fails}/${ran} as expected${skips ? ` (${skips} skipped)` : ''}${MODE === 'real' ? '' : ` — ${fails} FAILED, as a bad rule should`}`);
process.exit(fails ? 1 : 0);
