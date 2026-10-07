// Auto-stop decision (SAA-184) — live.
//
// Pulled out of main.js, like identity-answer.js and voice-naming-wait.js, so
// the rule can be exercised against event sequences directly — no Electron,
// no micwatch, no timers — rather than only through a live call.
//
// The signal is the trigger application releasing the microphone (micwatch's
// in_stop), not silence. Measured 2026-09-28/29 on Chrome/Meet: the helper
// releases at hang-up, and muting in Meet does not release it; the same holds
// for FaceTime (1188a345, 2026-09-30). A long quiet stretch is not an event.
//
// Live for every app that triggers a capture (Jon, 2026-10-07), replacing the
// per-app rollout of 5 real calls each. Which apps trigger a capture at all is
// already the person's own per-app "record" decision; there is no second table
// here.
//
// The rule, biased toward staying on because a capture cut short is not
// recoverable and one that runs long is:
//
//   - Only the application that started the capture counts. A manually
//     started capture has no trigger and never auto-stops.
//   - A release counts only when the trigger's LAST process lets go. Chrome
//     can run more than one helper pid under one bundle ID; one of two
//     releasing is not the call ending.
//   - The last release opens a GRACE_MS window. A reacquire, a stop of any
//     kind, a new capture, or micwatch exiting or restarting cancels it.
//     The first release never stops anything: it opens the window, and the
//     stop can only come at expiry. GRACE_MS is 5s (Jon, 2026-10-07; it was
//     120s). Muting and switching mic or headphones do not release the mic
//     (tested), so the window only has to clear the timing floor, which is
//     micwatch's poll: POLL_SECONDS = 1.0 (micwatch.swift:41; the daily log
//     reads "poll 1000ms"). micwatch emits in_start/in_stop only when two
//     consecutive polls differ, so a release or reacquire is stamped to within
//     a second, and one shorter than a poll is never seen. 5s is five polls.
//     The fresh micwatch --once read at expiry looks at the mic as it is then,
//     so a reacquire the stream has not delivered yet is still caught.
//     To be adjusted from what the logs show.
//     722508a2 released at 14:16:50 and, under the old 120s window, the
//     decision fell at 14:18:50; at 5s it would have fallen at 14:16:55.
//   - At expiry a fresh holder check (micwatch --once) runs. Only if it shows
//     the trigger no longer holding the microphone does step() ask for a stop.
//     A failed check is not a pass.
//   - The first decision is final for the capture.
//
// step() returns records. The one effect that stops anything is
// {kind:'stop', cause:'auto'}, emitted only from the expiry holder check;
// main.js carries it out through stopRecording('auto'), after confirming the
// capture it belongs to is still the running one.

'use strict';

const GRACE_MS = 5 * 1000;

function iso(ms) {
    return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function initialState() {
    return {
        phase: 'idle',        // 'idle' | 'manual' | 'watching' | 'done'
        trigger: null,        // { key, name }
        pids: [],             // trigger's pids currently holding the mic
        pending: null,        // { since, deadline, token, checking }
        nextToken: 1,
        wouldStop: null,      // { at, pendingSince }
        cancellations: [],    // [{ at, reason }]
        counts: { in_start: 0, in_stop: 0 },
        afterWouldStop: { in_start: 0, in_stop: 0 }, // trigger events once would-stop fired
        windowAtStop: null,   // { openedAt, expiresAt, checking } if a window was open at stop
        stopped: null,        // { at, cause }
    };
}

// Copy-on-write so step() never mutates what it was given.
function clone(s) {
    return {
        ...s,
        pids: s.pids.slice(),
        pending: s.pending ? { ...s.pending } : null,
        cancellations: s.cancellations.slice(),
        counts: { ...s.counts },
        afterWouldStop: { ...s.afterWouldStop },
        windowAtStop: s.windowAtStop ? { ...s.windowAtStop } : null,
    };
}

function cancel(s, out, t, reason) {
    if (!s.pending) return;
    out.push({ kind: 'cancel_timer', token: s.pending.token });
    out.push({ kind: 'log', entry: {
        event: 'pending_cancelled', t: iso(t), reason,
        pending_since: iso(s.pending.since),
        after_ms: t - s.pending.since,
    } });
    s.cancellations.push({ opened_at: iso(s.pending.since), cancelled_at: iso(t), reason });
    s.pending = null;
}

// ev.type is one of:
//   capture_start { t, trigger: {key,name}|null, pids: [pid] }
//   in_start / in_stop { t, key, pid, path, mw_t }
//   detector_ready { t }            micwatch (re)started
//   detector_exit  { t, code, signal }
//   expiry  { t, token }            the grace timer fired
//   holders { t, token, keys: [key]|null, error }   micwatch --once result
//   stop    { t, cause }            'manual' | 'child_exit' | 'start_timeout' | 'quit'
//
// A window is one grace period: it opens at the trigger's last release and ends
// in a cancellation (each recorded with opened_at, cancelled_at, reason) or a
// would-stop. A stop that finds one open records it as window_open_at_stop.
function step(prev, ev) {
    const s = clone(prev);
    const out = [];
    const t = ev.t;

    switch (ev.type) {
    case 'capture_start': {
        if (s.phase === 'watching' || s.phase === 'manual') cancel(s, out, t, 'new_capture');
        const fresh = initialState();
        fresh.nextToken = s.nextToken;
        if (!ev.trigger || !ev.trigger.key) {
            fresh.phase = 'manual';
            out.push({ kind: 'log', entry: { event: 'capture_start', t: iso(t), trigger_key: null,
                note: 'manual start: never auto-stops' } });
        } else {
            fresh.phase = 'watching';
            fresh.trigger = {
                key: ev.trigger.key, name: ev.trigger.name || null,
                exe: ev.trigger.exe || null, path: ev.trigger.path || null,
            };
            fresh.pids = [...new Set(ev.pids || [])];
            // Which process triggered this, as micwatch saw it: the first real
            // Slack or Zoom call shows here whether it was recognised and what
            // it is called (SAA-184 item 4).
            out.push({ kind: 'log', entry: { event: 'capture_start', t: iso(t),
                trigger_key: fresh.trigger.key, trigger_name: fresh.trigger.name,
                trigger_exe: fresh.trigger.exe, trigger_path: fresh.trigger.path,
                pids: fresh.pids, pid_info: ev.pidInfo || [], grace_ms: GRACE_MS } });
        }
        return { state: fresh, out };
    }

    case 'in_start':
    case 'in_stop': {
        if (s.phase !== 'watching' || ev.key !== s.trigger.key) return { state: prev, out };
        s.counts[ev.type] += 1;
        const known = s.pids.includes(ev.pid);
        if (ev.type === 'in_start') {
            if (!known) s.pids.push(ev.pid);
        } else {
            s.pids = s.pids.filter(p => p !== ev.pid);
        }
        out.push({ kind: 'log', entry: {
            event: ev.type, pid: ev.pid, path: ev.path || null,
            micwatch_t: ev.mw_t || null, received_t: iso(t),
            pids_after: s.pids.slice(),
            ...(ev.type === 'in_stop' && !known ? { note: 'pid was not in the set' } : {}),
            ...(s.wouldStop ? { after_would_stop: true } : {}),
        } });
        if (s.wouldStop) { s.afterWouldStop[ev.type] += 1; return { state: s, out }; }
        if (ev.type === 'in_start') {
            cancel(s, out, t, 'reacquire');
        } else if (s.pids.length === 0 && !s.pending) {
            const token = s.nextToken++;
            s.pending = { since: t, deadline: t + GRACE_MS, token, checking: false };
            out.push({ kind: 'schedule', token, at: t + GRACE_MS });
            out.push({ kind: 'log', entry: { event: 'pending_started', t: iso(t),
                expires_t: iso(t + GRACE_MS), token } });
        }
        return { state: s, out };
    }

    case 'detector_ready':
    case 'detector_exit': {
        if (s.phase !== 'watching') return { state: prev, out };
        // Whatever the old micwatch knew is gone; the new one re-reports every
        // current holder as an in_start on its first poll.
        s.pids = [];
        out.push({ kind: 'log', entry: { event: ev.type, t: iso(t),
            ...(ev.type === 'detector_exit' ? { code: ev.code ?? null, signal: ev.signal ?? null } : {}) } });
        cancel(s, out, t, ev.type === 'detector_ready' ? 'micwatch_restart' : 'micwatch_exit');
        return { state: s, out };
    }

    case 'expiry': {
        if (s.phase !== 'watching' || !s.pending || s.pending.token !== ev.token || s.pending.checking) {
            return { state: prev, out };
        }
        s.pending.checking = true;
        out.push({ kind: 'check_holders', token: ev.token });
        out.push({ kind: 'log', entry: { event: 'pending_expired', t: iso(t), token: ev.token,
            note: 'running fresh holder check' } });
        return { state: s, out };
    }

    case 'holders': {
        if (s.phase !== 'watching' || !s.pending || s.pending.token !== ev.token || !s.pending.checking) {
            return { state: prev, out };
        }
        const keys = Array.isArray(ev.keys) ? ev.keys : null;
        const triggerHolds = keys ? keys.includes(s.trigger.key) : null;
        out.push({ kind: 'log', entry: { event: 'expiry_check', t: iso(t), token: ev.token,
            holders: keys, trigger_holds: triggerHolds, error: ev.error || null } });
        if (keys === null) { cancel(s, out, t, 'holder_check_failed'); return { state: s, out }; }
        if (triggerHolds) { cancel(s, out, t, 'holder_check_found_trigger'); return { state: s, out }; }
        s.wouldStop = { at: t, pendingSince: s.pending.since };
        out.push({ kind: 'cancel_timer', token: s.pending.token });
        s.pending = null;
        out.push({ kind: 'log', entry: { event: 'auto_stop', t: iso(t),
            pending_since: iso(s.wouldStop.pendingSince),
            note: 'grace elapsed and the trigger no longer holds the mic: stopping' } });
        // The only stop effect in this file, and only from here.
        out.push({ kind: 'stop', cause: 'auto' });
        return { state: s, out };
    }

    case 'stop': {
        if (s.phase === 'idle' || s.phase === 'done') return { state: prev, out };
        const cause = ev.cause || 'manual';
        // A window open right now was opened by the trigger's last release (a
        // window only opens when the pid set empties). Kept before cancel()
        // clears it: a person who stops within seconds of hanging up always
        // lands here, and the would-stop never fires for them.
        if (s.pending) s.windowAtStop = { openedAt: s.pending.since, expiresAt: s.pending.deadline,
                                          checking: s.pending.checking };
        cancel(s, out, t, cause === 'quit' ? 'app_quit' : `${cause}_stop`);
        s.phase = 'done';
        s.stopped = { at: t, cause };
        out.push({ kind: 'log', entry: { event: 'capture_stop', t: iso(t), cause } });
        return { state: s, out };
    }

    default:
        return { state: prev, out };
    }
}

// The record written onto the capture at stop — manifest, then transcript,
// then recordings.metadata.autostop.
function autostopBlock(s) {
    const key = s.trigger ? s.trigger.key : null;
    let whyNull = null;
    if (!s.wouldStop) {
        if (s.phase === 'manual' || !key) whyNull = 'manual_start';
        else if (s.cancellations.length) whyNull = `cancelled: ${s.cancellations[s.cancellations.length - 1].reason}`;
        else if (s.pids.length) whyNull = 'trigger_still_holding';
        else whyNull = 'no_release_seen';
    }
    return {
        mode: 'live',
        trigger_key: key,
        trigger_name: s.trigger ? s.trigger.name : null,
        trigger_exe: s.trigger ? s.trigger.exe : null,
        trigger_path: s.trigger ? s.trigger.path : null,
        grace_ms: GRACE_MS,
        would_stop_at: s.wouldStop ? iso(s.wouldStop.at) : null,
        would_stop_null_reason: whyNull,
        pending_since: s.wouldStop ? iso(s.wouldStop.pendingSince) : null,
        stopped_at: s.stopped ? iso(s.stopped.at) : null,
        stop_cause: s.stopped ? s.stopped.cause : null,
        trigger_mic_events: { ...s.counts },
        // Trigger mic events after would_stop_at fired: an in_start there means
        // the call was still going (or came back) when a live build would have
        // stopped it.
        events_after_would_stop: { ...s.afterWouldStop },
        // Set when the capture was stopped (any cause; read stop_cause) while a
        // window was open, i.e. the trigger had released for the last time
        // window_open_at_stop.stopped_after_ms earlier and would have stopped
        // had the grace run out. This, not would_stop_at, is what a person who
        // presses Stop seconds after hanging up produces.
        window_open_at_stop: s.windowAtStop && s.stopped ? {
            opened_at: iso(s.windowAtStop.openedAt),
            expires_at: iso(s.windowAtStop.expiresAt),
            checking: s.windowAtStop.checking,
            stopped_after_ms: s.stopped.at - s.windowAtStop.openedAt,
        } : null,
        // Every window that opened and was cancelled: { opened_at, cancelled_at, reason }.
        cancellations: s.cancellations.slice(),
    };
}

// Parses `micwatch --once` stdout: one JSON object per line, event "in_now",
// one per process running input. The single reader for both the expiry check
// and the holders_at_start log line, so the two cannot drift. keyOf is
// main.js's detectKey (bundle ID, else exe:<name>). An unparseable line makes
// the whole result unusable (holders/keys null) rather than partial: the
// expiry check treats that as "do not stop".
function parseHoldersOnce(stdout, keyOf) {
    const holders = [];
    const keys = [];
    for (const line of String(stdout).split('\n')) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); }
        catch { return { holders: null, keys: null, error: `unparsed line: ${line}` }; }
        // A line that parses to something other than an object (null, a number)
        // is as unusable as one that does not parse; the pre-refactor code
        // threw on it inside the same try and reported "unparsed line".
        if (ev === null || typeof ev !== 'object') {
            return { holders: null, keys: null, error: `unparsed line: ${line}` };
        }
        if (ev.event !== 'in_now') continue;
        const key = keyOf(ev);
        holders.push({ pid: ev.pid, key: key || null, exe: ev.exe || null, path: ev.path || null });
        if (key && !keys.includes(key)) keys.push(key);
    }
    return { holders, keys, error: null };
}

// Holders at time t, as micwatch --once would have reported them: every key
// with a pid that started input at or before t and has not stopped.
function holdersFromEvents(events, t) {
    const live = new Map();
    for (const ev of events) {
        if (ev.t > t) break;
        if (ev.type === 'capture_start' && ev.trigger && ev.trigger.key) {
            for (const p of ev.pids || []) live.set(`${ev.trigger.key}#${p}`, ev.trigger.key);
        } else if (ev.type === 'in_start') live.set(`${ev.key}#${ev.pid}`, ev.key);
        else if (ev.type === 'in_stop') live.delete(`${ev.key}#${ev.pid}`);
    }
    return [...new Set(live.values())];
}

// Folds a whole event sequence, running the grace timer and the holder check
// the way main.js does. Pure given a pure holdersAt. Events without a stop
// have their outstanding timers fired at the end.
function decide(events, opts = {}) {
    const sorted = events.slice().sort((a, b) => a.t - b.t);
    const holdersAt = opts.holdersAt || (t => holdersFromEvents(sorted, t));
    let state = initialState();
    const log = [];
    const timers = new Map();
    // Every stop effect step() asked for, so a case can assert there was
    // exactly one, or none.
    const stopEffects = [];

    const feed = ev => {
        const r = step(state, ev);
        state = r.state;
        for (const o of r.out) {
            if (o.kind === 'log') log.push(o.entry);
            else if (o.kind === 'schedule') timers.set(o.token, o.at);
            else if (o.kind === 'cancel_timer') timers.delete(o.token);
            else if (o.kind === 'check_holders') {
                timers.delete(o.token);
                feed({ type: 'holders', t: ev.t, token: o.token, keys: holdersAt(ev.t) });
            } else if (o.kind === 'stop') {
                // What main.js does: stopRecording(cause), which feeds the
                // tracker its own 'stop' event. Later events are then ignored,
                // as they are on a stopped capture.
                stopEffects.push({ t: ev.t, cause: o.cause });
                feed({ type: 'stop', t: ev.t, cause: o.cause });
            }
        }
    };
    const fireUpTo = t => {
        for (;;) {
            let next = null;
            for (const [token, at] of timers) if (at <= t && (!next || at < next.at)) next = { token, at };
            if (!next) return;
            timers.delete(next.token);
            feed({ type: 'expiry', t: next.at, token: next.token });
        }
    };
    for (const ev of sorted) { fireUpTo(ev.t); feed(ev); }
    fireUpTo(Infinity);
    return { state, log, stopEffects, block: autostopBlock(state) };
}

module.exports = {
    GRACE_MS,
    initialState, step, autostopBlock, decide, holdersFromEvents, parseHoldersOnce,
};
