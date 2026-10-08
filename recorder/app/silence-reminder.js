// "Still recording?" reminder: the decision, with no Electron and no timers, so
// the rule can be exercised against audio sequences and real tap files directly
// (check-silence-reminder.js).
//
// Auto-stop (autostop.js) stops a triggered capture when its app lets go of the
// mic. It cannot help a manual start, a trigger app that never lets go, or
// micwatch dying. This covers those: when the call-audio (tap) track has been
// silent for WINDOW_S of audio time, ask. It NEVER stops anything on its own.
//
// What counts as silent: a chunk whose peak |sample| is below THRESHOLD_DBFS.
// Measured 2026-10-08 on the 110 tap files in the recordings directory (34.5 h),
// with the transcripts' call-audio speech as ground truth:
//   - after the call ended, 722508a2's tap was exact digital zero for 10,762 of
//     10,762 seconds. Every run-on tail and every leading silence of 60 s or more
//     in the corpus was exact zero too, so anything from zero up to -90 dBFS
//     catches exactly the same ones;
//   - a higher threshold only adds firings in the middle of calls: 1, 4, 7, 13
//     and 21 at -90, -80, -70, -60 and -50 dBFS. 8a473889 has a real 116 s
//     stretch below -60 dBFS (79 s below -70) and none below -90;
//   - in-call, the tap is rarely digitally silent for long: of 664 such runs,
//     28 were 20 s or longer and 1 was 60 s or longer (73 s).
// Only the tap counts: the mic is the person's own voice, and "a call that has
// gone quiet" is the remote side's audio. The tap is a global tap (systemtap
// main.swift: processes = [], isExclusive = true), so anything the Mac plays
// counts as sound, including a notification sound; the reminder is therefore
// shown silent.
//
// The rules:
//   - WINDOW_S of audio time with no sound shows ONE reminder.
//   - A reminder is answered Keep, Stop, or not at all. Keep and no answer are
//     both "keep recording": nothing repeats until sound has come back and then
//     WINDOW_S of silence has passed again.
//   - Sound coming back while a reminder is pending withdraws it (response
//     'none', closed_by 'sound_returned'): the call is on again, and a Stop
//     click on a stale reminder would end a live call.
//   - Stop yields one stop effect, cause 'silence-reminder'. A stop of any kind
//     (the tray, auto-stop, a dead child, quit) ends the tracker first: the
//     pending reminder is withdrawn and nothing after that can send a stop.
//
// Time here is audio time: seconds come from bytes read divided by the tap's
// byte rate, so a stalled tap adds none and cannot trigger anything.

'use strict';

const WINDOW_S = 60;
const THRESHOLD_DBFS = -90;
const THRESHOLD_LINEAR = Math.pow(10, THRESHOLD_DBFS / 20);
const STOP_CAUSE = 'silence-reminder';
// Floating-point slack for summing chunk durations such as 49152 / 192000.
const EPS = 1e-9;

const iso = (t) => new Date(t).toISOString();
const round1 = (x) => Math.round(x * 10) / 10;

function initialState(startedAtMs) {
    return {
        startedAt: startedAtMs,
        silentS: 0,
        // False from the moment a reminder is shown until sound is heard again:
        // this is what makes Keep, and no answer, mean "no repeat".
        armed: true,
        pending: null,      // { index } while a reminder is waiting for an answer
        reminders: [],
        ended: false,
    };
}

// Largest |sample| in a buffer of little-endian float32. A NaN is treated as
// sound (Infinity): garbage must never read as silence. Stops early once
// stopAt is reached, since "at least this loud" is all the caller needs.
function peakOfF32(buf, stopAt = Infinity) {
    const len = buf.length - (buf.length % 4);
    const dv = new DataView(buf.buffer, buf.byteOffset, len);
    let peak = 0;
    for (let i = 0; i < len; i += 4) {
        const v = dv.getFloat32(i, true);
        const a = v < 0 ? -v : v;
        if (a !== a) return Infinity;
        if (a > peak) {
            peak = a;
            if (peak >= stopAt) return peak;
        }
    }
    return peak;
}

// The reminder entry being closed. responded_at_s is set only for an answer a
// person gave; closed_by says how a 'none' ended.
function closeReminder(state, index, t, response, closedBy) {
    const reminders = state.reminders.slice();
    const r = { ...reminders[index], response, closed_by: closedBy };
    r.responded_at_s = response === 'keep' || response === 'stop' ? round1((t - state.startedAt) / 1000) : null;
    reminders[index] = r;
    return { reminders, entry: r };
}

// ev: { type: 'audio', t, seconds, peak } | { type: 'response', t, response: 'keep'|'stop' }
//   | { type: 'expire', t } | { type: 'end', t, cause }
// out: { kind: 'show', index } | { kind: 'withdraw' } | { kind: 'stop', cause } | { kind: 'log', entry }
function step(state, ev) {
    const out = [];
    if (state.ended) return { state, out };
    const s = { ...state };

    if (ev.type === 'audio') {
        if (ev.peak >= THRESHOLD_LINEAR) {
            s.silentS = 0;
            s.armed = true;
            if (s.pending) {
                const c = closeReminder(s, s.pending.index, ev.t, 'none', 'sound_returned');
                s.reminders = c.reminders; s.pending = null;
                out.push({ kind: 'withdraw' });
                out.push({ kind: 'log', entry: { event: 'silence_reminder_response', t: iso(ev.t), index: c.entry.index, response: 'none', closed_by: 'sound_returned' } });
            }
        } else {
            s.silentS += ev.seconds;
            if (s.armed && !s.pending && s.silentS + EPS >= WINDOW_S) {
                const index = s.reminders.length;
                const entry = {
                    index,
                    shown_at_s: round1((ev.t - s.startedAt) / 1000),
                    shown_at: iso(ev.t),
                    silent_for_s: round1(s.silentS),
                    response: null, responded_at_s: null, closed_by: null,
                };
                s.reminders = s.reminders.concat([entry]);
                s.pending = { index };
                s.armed = false;
                out.push({ kind: 'show', index });
                out.push({ kind: 'log', entry: { event: 'silence_reminder_shown', t: entry.shown_at, index, shown_at_s: entry.shown_at_s, silent_for_s: entry.silent_for_s } });
            }
        }
        return { state: s, out };
    }

    if (ev.type === 'response') {
        // A click on a reminder that is no longer pending (answered, withdrawn,
        // or its capture stopped) does nothing, and in particular cannot stop.
        if (!s.pending || (ev.response !== 'keep' && ev.response !== 'stop')) return { state, out };
        const index = s.pending.index;
        const c = closeReminder(s, index, ev.t, ev.response, 'notification');
        s.reminders = c.reminders; s.pending = null;
        out.push({ kind: 'withdraw' });
        out.push({ kind: 'log', entry: { event: 'silence_reminder_response', t: iso(ev.t), index, response: ev.response, responded_at_s: c.entry.responded_at_s } });
        if (ev.response === 'stop') out.push({ kind: 'stop', cause: STOP_CAUSE });
        return { state: s, out };
    }

    if (ev.type === 'expire') {
        if (!s.pending) return { state, out };
        const index = s.pending.index;
        const c = closeReminder(s, index, ev.t, 'none', 'no_answer');
        s.reminders = c.reminders; s.pending = null;
        out.push({ kind: 'withdraw' });
        out.push({ kind: 'log', entry: { event: 'silence_reminder_response', t: iso(ev.t), index, response: 'none', closed_by: 'no_answer' } });
        return { state: s, out };
    }

    if (ev.type === 'end') {
        s.ended = true;
        if (s.pending) {
            const index = s.pending.index;
            const c = closeReminder(s, index, ev.t, 'none', `capture_stopped:${ev.cause}`);
            s.reminders = c.reminders; s.pending = null;
            out.push({ kind: 'withdraw' });
            out.push({ kind: 'log', entry: { event: 'silence_reminder_response', t: iso(ev.t), index, response: 'none', closed_by: `capture_stopped:${ev.cause}` } });
        }
        return { state: s, out };
    }

    return { state, out };
}

// One chunk of raw tap bytes, as main.js reads them and as the check replays
// real files: the same peak, the same seconds, the same step.
function feedBytes(state, buf, t, bytesPerSecond) {
    return step(state, {
        type: 'audio', t,
        seconds: buf.length / bytesPerSecond,
        peak: peakOfF32(buf, THRESHOLD_LINEAR),
    });
}

// What goes into the manifest's autostop block (and from there into
// recordings.metadata.autostop): the settings, whether the detector ran, and
// each reminder with its response. Present on every capture the detector ran
// for, with an empty list when nothing was shown, so "none shown" is
// distinguishable from a capture that predates this.
function silenceBlock(state, offReason = null) {
    return {
        silence_window_s: WINDOW_S,
        silence_threshold_dbfs: THRESHOLD_DBFS,
        silence_detector_off: offReason,
        silence_reminders: state.reminders.map((r) => ({ ...r })),
    };
}

module.exports = {
    WINDOW_S, THRESHOLD_DBFS, THRESHOLD_LINEAR, STOP_CAUSE,
    initialState, step, feedBytes, peakOfF32, silenceBlock,
};
