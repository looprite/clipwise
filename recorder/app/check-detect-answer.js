// Checks the detection prompt's answer (detect-answer.js, SAA-269): a capture
// started by "Always record" carries the app that asked as its trigger, so
// auto-stop watches it like any other triggered capture. Without it the
// capture is a manual start, never auto-stops, and counts no mic events —
// trigger_app null, stop_cause manual, trigger_mic_events 0/0, as on a new
// Mac's first FaceTime call.
//
// Each start detect-answer.js returns is run through the real autostop.step,
// with events shaped as main.js sends them (autostopBegin, handleDetectEvent,
// autostopFeed, autostopCheckHolders): capture_start, the trigger's in_stop,
// the grace timer's expiry, then a holder check without the trigger's key.
//
// No Electron, no micwatch, no timers, no files: no app name, keychain item or
// support folder.
//
// Usage (the Node the app ships, then any Node):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron check-detect-answer.js
//   node check-detect-answer.js
//
// Exit 0 when every case passes, 1 otherwise.

'use strict';

const path = require('path');
const { startForAnswer } = require(path.join(__dirname, 'detect-answer.js'));
const autostop = require(path.join(__dirname, 'autostop.js'));

const KEY = 'com.apple.avconferenced';
const NAME = 'avconferenced';
const PID = 4242;

let passed = 0;
let failed = 0;
function result(ok, name, detail) {
    if (ok) passed++; else failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const show = (v) => JSON.stringify(v);
const triggerSet = (a) => !!a.trigger && a.trigger.key === KEY && a.trigger.name === NAME;

// A capture with this trigger, from its start to a holder check that no longer
// finds the trigger. Returns the phase after capture_start, every out record,
// and the stop records.
function runAutostop(trigger) {
    let state = autostop.initialState();
    const all = [];
    const feed = (ev) => {
        const r = autostop.step(state, ev);
        state = r.state;
        all.push(...r.out);
        return r.out;
    };
    let t = Date.UTC(2026, 10, 5, 15, 0, 0);
    // As autostopBegin: the trigger's pids from detectActive, the trigger with
    // exe and path, or null and no pids for a capture with no trigger.
    const detail = trigger ? { ...trigger, exe: NAME, path: `/usr/libexec/${NAME}` } : null;
    feed({ type: 'capture_start', t, trigger: detail, pids: trigger ? [PID] : [],
        pidInfo: trigger ? [{ pid: PID, name: NAME, path: `/usr/libexec/${NAME}`, exe: NAME }] : [] });
    const phase = state.phase;
    // The call ends: the trigger's process lets go of the mic.
    t += 180 * 1000;
    const onRelease = feed({ type: 'in_stop', t, key: KEY, pid: PID, path: `/usr/libexec/${NAME}`, mw_t: null });
    const scheduled = onRelease.find((o) => o.kind === 'schedule');
    // The grace timer fires with the token it was scheduled with, then the fresh
    // holder check finds something else on the mic, not the trigger.
    const token = scheduled ? scheduled.token : 1;
    t += autostop.GRACE_MS;
    feed({ type: 'expiry', t, token });
    feed({ type: 'holders', t: t + 50, token, keys: ['com.example.other'], error: null });
    return { phase, scheduled: !!scheduled, stops: all.filter((o) => o.kind === 'stop') };
}
const stoppedAuto = (r) => r.stops.length === 1 && r.stops[0].cause === 'auto';

function main() {
    console.log(`node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ''}`);

    // Control: the harness itself. A trigger given by hand (what the allowed-app
    // path, main.js handleDetectEvent, hands startRecording) is watched and
    // stops with cause auto.
    {
        const r = runAutostop({ key: KEY, name: NAME });
        result(r.phase === 'watching' && r.scheduled && stoppedAuto(r),
            'control: a capture with a trigger is watched, its release opens the window, and the holder check stops it with cause auto',
            `phase ${r.phase}, window scheduled ${r.scheduled}, stops ${show(r.stops)}`);
    }

    // Control: no trigger. Manual, never stops — this capture's metadata.
    {
        const r = runAutostop(null);
        result(r.phase === 'manual' && !r.scheduled && r.stops.length === 0,
            'control: a capture with a null trigger stays manual and never stops',
            `phase ${r.phase}, window scheduled ${r.scheduled}, stops ${show(r.stops)}`);
    }

    // "Always record" while the prompt is live.
    {
        const a = startForAnswer({ choice: 'record', live: true, holding: true, key: KEY, name: NAME });
        result(a.start === true && triggerSet(a),
            '"record" while the prompt is live: starts, with the app as its trigger',
            `got ${show(a)}`);
        const r = runAutostop(a.start ? a.trigger : undefined);
        result(a.start === true && r.phase === 'watching' && stoppedAuto(r),
            '"record" while live: that capture is watched and auto-stops when the app lets go',
            `phase ${r.phase}, stops ${show(r.stops)}`);
    }

    // "Always record" after the prompt lapsed, the app still on the mic.
    {
        const a = startForAnswer({ choice: 'record', live: false, holding: true, key: KEY, name: NAME });
        result(a.start === true && triggerSet(a),
            'late "record", the app still on the mic: starts, with the app as its trigger',
            `got ${show(a)}`);
        const r = runAutostop(a.start ? a.trigger : undefined);
        result(a.start === true && r.phase === 'watching' && stoppedAuto(r),
            'late "record", app on the mic: that capture is watched and auto-stops when the app lets go',
            `phase ${r.phase}, stops ${show(r.stops)}`);
    }

    // Controls: answers that start nothing.
    for (const [name, args] of [
        ['"not now" (live)', { choice: 'not_now', live: true, holding: true }],
        ['"never" (live)', { choice: 'never', live: true, holding: true }],
        ['late "record" after the app released the mic', { choice: 'record', live: false, holding: false }],
    ]) {
        const a = startForAnswer({ ...args, key: KEY, name: NAME });
        result(a.start === false && a.trigger === null,
            `control: ${name}: no start`,
            `got ${show(a)}`);
    }

    console.log(`\ncheck-detect-answer: ${passed} passed, ${failed} failed`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main();
