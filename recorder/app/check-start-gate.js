#!/usr/bin/env node
// A capture that would start while an audio grant is unanswered waits for the
// answer on the setup window's permissions screen instead of running into the
// 9 s start timeout (SAA-124).
//
//   node check-start-gate.js
//   CLIPWISE_CHECK_SOURCE=c5b1408 node check-start-gate.js
//
// Cases 1-31 run code: start-gate.js's permissionGate, resumeAfterPermissions
// and permissionsWindowNext as tables, an auto-detected call through them, and
// prompt-child.js against real child processes (a shell script, and a Node script
// that ignores SIGINT for the race) and one
// stand-in child whose exit is never delivered. With CLIPWISE_CHECK_SOURCE set,
// c5b1408 has none of these, so STAND-INS are checked in their place: a COPY of
// its refuse-on-denied rule for the gate, a resume that always says none, a
// window that never closes, and a COPY of its promptForSystemAudio timing.
//
// Cases 32-42 read main.js and build-app.sh as text: they show where main.js
// calls these and what it does with the answers. They do not cover the live
// path (a real prompt, a real call); that is the build/install step's.

const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { spawn: realSpawn, execFileSync } = require('child_process');

const REV = process.env.CLIPWISE_CHECK_SOURCE || '';
const fromRev = (file) => execFileSync('git', ['show', `${REV}:recorder/app/${file}`], { cwd: __dirname, encoding: 'utf8' });
const read = (file) => (REV ? fromRev(file) : fs.readFileSync(path.join(__dirname, file), 'utf8'));
const SRC = read('main.js');
const BUILD = read('build-app.sh');

// COPY of c5b1408's promptForSystemAudio timing, in prompt-child.js's shape: it
// resolves graceMs after the SIGINT whether or not the child has exited, and
// nothing knows whether it is running.
function oldPromptChildCopy({ spawn = realSpawn } = {}) {
    return {
        running: () => false,
        run(cmd, args, env, isAnswered, { pollMs, waitMs, graceMs } = {}) {
            return new Promise((resolve) => {
                let child;
                try { child = spawn(cmd, args, { env, stdio: 'ignore' }); } catch { resolve(); return; }
                child.once('error', () => {});
                const started = Date.now();
                const timer = setInterval(() => {
                    const answered = isAnswered();
                    const gone = child.exitCode !== null || child.signalCode !== null;
                    if (!answered && !gone && Date.now() - started < waitMs) return;
                    clearInterval(timer);
                    try { child.kill('SIGINT'); } catch {}
                    setTimeout(() => {
                        if (child.exitCode === null && child.signalCode === null) {
                            try { child.kill('SIGKILL'); } catch {}
                        }
                        resolve();
                    }, graceMs);
                }, pollMs);
            });
        },
    };
}

const G = REV
    ? {
        // COPY of c5b1408's rule: any denied grant refuses, everything else starts.
        permissionGate: (mic, tap) => (mic === 'denied' || tap === 'denied' ? 'refuse' : 'start'),
        // STAND-IN: c5b1408 has no resume for a start the grants turned away.
        resumeAfterPermissions: () => 'none',
        // STAND-IN: c5b1408's setup window goes on to its next screen; it never closes.
        permissionsWindowNext: (_finished, mic, tap) => (mic === 'notDetermined' || tap === 'notDetermined' ? 'stay' : 'continue'),
        BLOCKED_START_TTL_MS: 10 * 60 * 1000,
    }
    : require('./start-gate.js');
const makePromptChild = REV ? oldPromptChildCopy : require('./prompt-child.js').createPromptChild;

const NOW = Date.UTC(2026, 9, 23, 15, 0, 0);
const ZOOM = { key: 'us.zoom.xos', name: 'zoom.us' };
const blockedAt = (msAgo, reason = 'permissions', trigger = ZOOM) => ({ trigger, at: NOW - msAgo, reason });
const holdsZoom = (key) => key === ZOOM.key;
const holdsNothing = () => false;
const resume = (blocked, mic, tap, holds, promptRunning = false) =>
    G.resumeAfterPermissions(blocked, mic, tap, holds, { promptRunning, now: NOW });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-check-start-gate-'));
function script(name, body) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
    return p;
}
const EXITS_ON_INT = script('exits-on-int', "trap 'exit 0' INT\nwhile :; do sleep 0.05; done");
// Node, not sh: a probe (2026-10-23) showed `trap '' INT` in /bin/sh did not keep
// the script alive; it exited on the SIGINT, signal=SIGINT, within 1 ms. This one
// writes the ready file only once its handler is in place, so no SIGINT can
// arrive before it.
const IGNORES_INT = path.join(dir, 'ignores-int.js');
const IGNORES_INT_READY = path.join(dir, 'ignores-int.ready');
fs.writeFileSync(IGNORES_INT, `process.on('SIGINT', () => {});\nsetInterval(() => {}, 1000);\nrequire('fs').writeFileSync(${JSON.stringify(IGNORES_INT_READY)}, '');\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (c) => !!c && c.exitCode === null && c.signalCode === null;

// A child for the case where the exit event never comes: kill() is recorded and
// does nothing, and 'exit' is never emitted.
function neverExitsSpawn(signals) {
    return () => {
        const c = new EventEmitter();
        c.exitCode = null;
        c.signalCode = null;
        c.kill = (sig) => { signals.push(sig); return true; };
        return c;
    };
}

(async () => {
    const out = {};

    // P1: a child that exits on SIGINT.
    {
        let child = null;
        const pc = makePromptChild({ spawn: (...a) => (child = realSpawn(...a)), log: () => {} });
        let answered = false;
        let onExitCalls = 0, runningAtOnExit = null;
        setTimeout(() => { answered = true; }, 60);
        const p = pc.run(EXITS_ON_INT, [], process.env, () => answered,
            { pollMs: 20, waitMs: 5000, graceMs: 400, onExit: () => { onExitCalls++; runningAtOnExit = pc.running(); } });
        await p;
        out.p1 = { exitedAtResolve: !alive(child), runningAfter: pc.running(), onExitCalls, runningAtOnExit };
    }

    // P2: the race. A child that ignores SIGINT: between the answer and its exit,
    // a resume (as the window's focus would run one) must wait.
    {
        let child = null;
        const pc = makePromptChild({ spawn: (...a) => (child = realSpawn(...a)), log: () => {} });
        let answered = false;
        let onExitCalls = 0;
        const p = pc.run(process.execPath, [IGNORES_INT], process.env, () => answered,
            { pollMs: 20, waitMs: 5000, graceMs: 150, onExit: () => { onExitCalls++; } });
        // Answered only once the child's SIGINT handler is in place (at most 5 s).
        for (let i = 0; i < 250 && !fs.existsSync(IGNORES_INT_READY); i++) await sleep(20);
        const readyBeforeAnswer = fs.existsSync(IGNORES_INT_READY);
        answered = true;
        await sleep(90); // past the SIGINT (next poll), before the SIGKILL (150 ms later)
        const sampleAlive = alive(child);
        const sampleRunning = pc.running();
        const sampleResume = resume(blockedAt(1000), 'granted', 'granted', holdsZoom, pc.running());
        await p;
        out.p2 = {
            readyBeforeAnswer, sampleAlive, sampleRunning, sampleResume,
            exitedAtResolve: !alive(child), runningAfter: pc.running(),
            resumeAfter: resume(blockedAt(1000), 'granted', 'granted', holdsZoom, pc.running()),
            onExitCalls,
        };
    }

    // P3: no binary at that path.
    {
        const pc = makePromptChild({ log: () => {} });
        let threw = null;
        try {
            await pc.run(path.join(dir, 'no-such-systemtap'), [], process.env, () => false,
                { pollMs: 20, waitMs: 300, graceMs: 50 });
        } catch (err) { threw = err; }
        out.p3 = { threw: threw ? String(threw) : null, runningAfter: pc.running() };
    }

    // P4: the exit event never comes after SIGKILL: treated as gone at 2 x grace.
    {
        const signals = [];
        const logs = [];
        const pc = makePromptChild({ spawn: neverExitsSpawn(signals), log: (l) => logs.push(l) });
        let onExitCalls = 0;
        const started = Date.now();
        const p = pc.run('stand-in', [], process.env, () => true,
            { pollMs: 20, waitMs: 5000, graceMs: 50, onExit: () => { onExitCalls++; } });
        await sleep(120); // after the SIGKILL (~70 ms), before the cap (~170 ms)
        const runningBeforeCap = pc.running();
        await p;
        out.p4 = { signals, logs, runningBeforeCap, runningAfter: pc.running(), onExitCalls, ms: Date.now() - started };
    }

    const body = (name) => (new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm').exec(SRC) || [''])[0];
    const start = body('startRecording');
    const order = (...needles) => {
        const at = needles.map((n) => start.indexOf(n));
        return at.every((i) => i >= 0) && at.every((i, k) => k === 0 || i > at[k - 1]);
    };
    const lastSpawn = start.lastIndexOf('spawnChild(');

    const flowBlock = G.permissionGate('notDetermined', 'notDetermined');
    const flowBlocked = flowBlock === 'block' ? blockedAt(0) : null;
    const flowAfterMic = resume(flowBlocked, 'granted', 'notDetermined', holdsZoom);
    const flowAfterBoth = resume(flowBlocked, 'granted', 'granted', holdsZoom);

    const CASES = [
        // permissionGate(mic, tap)
        ['gate: mic notDetermined, tap notDetermined -> block', () => G.permissionGate('notDetermined', 'notDetermined') === 'block'],
        ['gate: mic granted, tap notDetermined -> block', () => G.permissionGate('granted', 'notDetermined') === 'block'],
        ['gate: mic notDetermined, tap granted -> block', () => G.permissionGate('notDetermined', 'granted') === 'block'],
        ['gate: mic granted, tap granted -> start', () => G.permissionGate('granted', 'granted') === 'start'],
        ['gate: mic denied, tap granted -> refuse', () => G.permissionGate('denied', 'granted') === 'refuse'],
        ['gate: mic notDetermined, tap denied -> refuse', () => G.permissionGate('notDetermined', 'denied') === 'refuse'],
        ['gate: mic granted, tap unavailable -> fallback', () => G.permissionGate('granted', 'unavailable') === 'fallback'],
        ['gate: mic notDetermined, tap unexpected(7) -> fallback', () => G.permissionGate('notDetermined', 'unexpected(7)') === 'fallback'],
        ['gate: mic restricted, tap granted -> start', () => G.permissionGate('restricted', 'granted') === 'start'],
        // resumeAfterPermissions(blocked, mic, tap, holdsMic, { promptRunning, now })
        ['resume: nothing blocked -> none', () => resume(null, 'granted', 'granted', holdsZoom) === 'none'],
        ['resume: blocked 10 min + 1 ms ago -> none', () => resume(blockedAt(G.BLOCKED_START_TTL_MS + 1), 'granted', 'granted', holdsZoom) === 'none'],
        ['resume: blocked for the notice, not the grants -> none', () => resume(blockedAt(1000, 'notice'), 'granted', 'granted', holdsZoom) === 'none'],
        ['resume: one grant still notDetermined -> wait', () => resume(blockedAt(1000), 'granted', 'notDetermined', holdsZoom) === 'wait'],
        ['resume: mic denied -> drop-denied', () => resume(blockedAt(1000), 'denied', 'granted', holdsZoom) === 'drop-denied'],
        ['resume: tap denied -> drop-denied', () => resume(blockedAt(1000), 'granted', 'denied', holdsZoom) === 'drop-denied'],
        ['resume: both granted, the app no longer holds the mic -> call-ended', () => resume(blockedAt(1000), 'granted', 'granted', holdsNothing) === 'call-ended'],
        ['resume: both granted, the app still holds the mic -> start', () => resume(blockedAt(1000), 'granted', 'granted', holdsZoom) === 'start'],
        ['resume: manual start (no trigger), both granted -> start', () => resume(blockedAt(1000, 'permissions', null), 'granted', 'granted', holdsNothing) === 'start'],
        ['resume (race): both granted, app holding, the prompt\'s child still running -> wait', () => resume(blockedAt(1000), 'granted', 'granted', holdsZoom, true) === 'wait'],
        // permissionsWindowNext(finishedBefore, mic, tap)
        ['window: setup finished before, a grant unanswered -> stay', () => G.permissionsWindowNext(true, 'notDetermined', 'granted') === 'stay'],
        ['window: setup finished before, both granted -> close', () => G.permissionsWindowNext(true, 'granted', 'granted') === 'close'],
        ['window: setup finished before, mic denied -> close', () => G.permissionsWindowNext(true, 'denied', 'granted') === 'close'],
        ['window: setup not finished, both granted -> continue', () => G.permissionsWindowNext(false, 'granted', 'granted') === 'continue'],
        ['window: setup not finished, both unanswered -> stay', () => G.permissionsWindowNext(false, 'notDetermined', 'notDetermined') === 'stay'],
        ['window: setup not finished, tap denied -> continue', () => G.permissionsWindowNext(false, 'granted', 'denied') === 'continue'],
        // An auto-detected call, through the gate and the resume.
        [`flow: an auto-detected call with both unanswered is blocked (no capture), waits after the mic answer, starts for that call after both (gate ${flowBlock}, then ${flowAfterMic}, then ${flowAfterBoth})`, () =>
            flowBlock === 'block' && flowAfterMic === 'wait' && flowAfterBoth === 'start' && flowBlocked.trigger === ZOOM],
        ['flow (control): the same call with both granted starts at once, nothing blocked', () =>
            G.permissionGate('granted', 'granted') === 'start'],
        // prompt-child.js, with real processes
        ['prompt child: a child that exits on SIGINT has exited when run resolves; running() false then; onExit once, with running() already false', () =>
            out.p1.exitedAtResolve && out.p1.runningAfter === false && out.p1.onExitCalls === 1 && out.p1.runningAtOnExit === false],
        ['prompt child (race): a child that ignores SIGINT is alive between the answer and its SIGKILL; running() is true then and a resume waits; after its exit running() is false and the resume starts', () =>
            out.p2.readyBeforeAnswer && out.p2.sampleAlive && out.p2.sampleRunning === true && out.p2.sampleResume === 'wait'
            && out.p2.exitedAtResolve && out.p2.runningAfter === false && out.p2.resumeAfter === 'start' && out.p2.onExitCalls === 1],
        ['prompt child: no binary at that path resolves, nothing throws, running() false', () =>
            out.p3.threw === null && out.p3.runningAfter === false],
        ['prompt child: no exit event after SIGKILL -> running() true until 2 x grace, then false, with "prompt child: no exit after SIGKILL, treated as gone"; onExit once', () =>
            JSON.stringify(out.p4.signals) === '["SIGINT","SIGKILL"]' && out.p4.runningBeforeCap === true && out.p4.runningAfter === false
            && out.p4.logs.includes('prompt child: no exit after SIGKILL, treated as gone') && out.p4.onExitCalls === 1],
        // main.js and build-app.sh, as text
        ['main.js (text): startRecording keeps the notice gate first, then readDevices, then permissionGate, then the manifest and the spawns', () =>
            order('if (!consent.isAcknowledged(SUPPORT_DIR))', 'dev = readDevices();', 'startGate.permissionGate(dev.micPerm, dev.tapPerm)', 'buildManifest(', 'spawnChild(')],
        ['main.js (text): block keeps the start as { trigger, at, reason: \'permissions\' }, opens setup at permissions, notifies only for a trigger with the approved text, and returns', () =>
            /if \(gate === 'block'\) \{\s*blockedStart = \{ trigger, at: Date\.now\(\), reason: 'permissions' \};[\s\S]{0,400}showSetupWindow\('permissions'\);[\s\S]{0,200}if \(trigger\) \{\s*notify\('permissions-start-blocked', 'Clipwise: allow audio access',\s*'Recording starts when you answer, if the call is still going\.'\);\s*\}\s*return;\s*\}/.test(start)],
        ['main.js (text): fallback logs "start: system audio permission unreadable (tap_perm=<state>) — starting without the permission gate" and goes on', () =>
            start.includes("if (gate === 'fallback') {\n        console.error(`start: system audio permission unreadable (tap_perm=${dev.tapPerm}) — starting without the permission gate`);\n    }")],
        ['main.js (text, control): a denied grant is still refused with the same note and line', () =>
            /notify\((?:'start-permission-denied', )?'Clipwise: capture not started', permissionIssue\.note\);/.test(start)
            && start.includes('console.error(`start refused: denied permissions: ${denied.join(\', \')}`);')],
        ['main.js (text): the resume asks resumeAfterPermissions with the prompt child\'s running(), drops a denial with the approved text, says when the call ended, and otherwise restores the trigger and starts', () => {
            const r = body('resumePermissionBlockedStart');
            return r.includes('{ promptRunning: systemAudioPrompt.running() }')
                && r.includes("notify('permissions-denied-dropped', 'Clipwise: capture not started',\n            `${permissionIssue.note}. Open System Settings from the Clipwise menu bar.`);")
                && r.includes("notify('permissions-blocked-call-ended', 'Clipwise: nothing to record',\n            'The call that tried to start recording has ended.');")
                && /pendingStartTrigger = blocked\.trigger \|\| null;\s*startRecording\(\);\s*\}$/.test(r);
        }],
        ['main.js (text, control): STARTING_TIMEOUT_MS is 9000 and its timer is armed after the last spawn', () =>
            SRC.includes('const STARTING_TIMEOUT_MS = 9000;')
            && lastSpawn >= 0 && start.indexOf('setTimeout(onStartingTimeout, STARTING_TIMEOUT_MS)') > lastSpawn],
        ['main.js (text): the resume runs after requestPermission, on the setup window\'s focus, and on the prompt child\'s exit; the prompt runs through prompt-child.js with today\'s values', () =>
            body('requestPermission').includes("resumePermissionBlockedStart('request');")
            && /win\.on\('focus', \(\) => \{[\s\S]{0,400}resumePermissionBlockedStart\('focus'\);\s*\}\);/.test(SRC)
            && /return systemAudioPrompt\.run\(\s*SYSTEMTAP_BIN, \[\], \{ \.\.\.process\.env, SYSTEMTAP_OUT: '\/dev\/null' \},[\s\S]{0,200}pollMs: 1000,\s*waitMs: SYSTEM_AUDIO_PROMPT_WAIT_MS,\s*graceMs: KILL_GRACE_MS,\s*onExit: \(\) => \{\s*readPermissions\(\);\s*resumePermissionBlockedStart\('prompt exit'\);/.test(SRC)],
        ['main.js (text): one expiry for the notice and the grants, start-gate.js\'s', () =>
            SRC.includes('const { BLOCKED_START_TTL_MS } = startGate;') && !/const BLOCKED_START_TTL_MS = /.test(SRC)],
        ['main.js (text): setup opens at permissions even after it was finished, and a window opened that way closes once both are answered (permissionsWindowNext), never re-running a finished step', () => {
            const s = body('showSetupWindow');
            const w = body('settlePermissionsWindow');
            return s.includes('const noticeOnly = setupCompleted() && !forPermissions;')
                && s.includes("override: forPermissions ? 'permissions' : null")
                && s.includes('permissionsOnly: forPermissions && setup.isSetupCompleted(SUPPORT_DIR)')
                && w.includes('startGate.permissionsWindowNext(w.permissionsOnly, lastPermissions.mic, lastPermissions.tap)')
                && /if \(next === 'close'\) \{\s*closeSetupWindow\(\);/.test(w)
                && body('resumePermissionBlockedStart').includes('settlePermissionsWindow();');
        }],
        ['main.js (text): the notice gate marks its start as the notice\'s, and agreeing to the notice leaves a start waiting on the grants alone', () =>
            start.includes("blockedStart = { trigger, at: Date.now(), reason: 'notice' };")
            && body('resumeBlockedStart').includes("if (blocked && blocked.reason === 'permissions') return;")],
        ['build-app.sh (text): copies start-gate.js and prompt-child.js into the bundle (main.js requires them)', () =>
            BUILD.includes('cp "$APP_SRC/start-gate.js" "$C/Resources/app/start-gate.js"')
            && BUILD.includes('cp "$APP_SRC/prompt-child.js" "$C/Resources/app/prompt-child.js"')],
    ];

    const EXPECTED_OLD_FAILS = [1, 2, 3, 7, 8, 13, 14, 15, 16, 17, 18, 19, 21, 22, 26, 28, 29, 31, 32, 33, 34, 36, 38, 39, 40, 41, 42];
    console.log(`source: ${REV ? `${REV} main.js and build-app.sh; gate: COPY of c5b1408's refuse-on-denied rule; resume and window: STAND-INS (c5b1408 has neither); prompt child: COPY of c5b1408's promptForSystemAudio timing` : 'start-gate.js, prompt-child.js, main.js and build-app.sh in the checkout'}`);
    console.log(`expected to fail on c5b1408: cases ${EXPECTED_OLD_FAILS.join(', ')}, and nothing else`);
    console.log(`prompt child, exits on SIGINT: ${JSON.stringify(out.p1)}`);
    console.log(`prompt child, race (ignores SIGINT): ${JSON.stringify(out.p2)}`);
    console.log(`prompt child, no binary: ${JSON.stringify(out.p3)}`);
    console.log(`prompt child, no exit event: ${JSON.stringify(out.p4)}`);
    const failed = [];
    CASES.forEach(([name, fn], i) => {
        let ok = false;
        try { ok = !!fn(); } catch { ok = false; }
        if (!ok) failed.push(i + 1);
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${i + 1}. ${name}`);
    });
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\nfailed: ${failed.length ? failed.join(', ') : 'none'}`);
    console.log(`${CASES.length - failed.length}/${CASES.length} as expected`);
    process.exit(failed.length ? 1 : 0);
})();
