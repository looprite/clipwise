// Whether a downloaded update may be applied now (SAA-253 decisions 4 and 5).
//
// Applying an update quits the app and replaces the bundle on disk, so it waits
// until nothing would be cut off or would lose the files it runs from:
//
//   - no capture: recording, starting or stalled, or a session not yet torn down
//   - no stop in progress (teardown's children not yet gone)
//   - no Clipwise window open (Jon, 2026-10-29): identity, voice naming, setup,
//     Recent meetings, any of them. Applying would close it under the person
//     using it, and an identity or naming window would close unanswered.
//     main.js reads this from BrowserWindow.getAllWindows(), visible ones only.
//   - no pipeline from this run, and no recovery pass
//   - no pipeline from an EARLIER run either: pipelines are detached and outlive
//     the app that started them, so they are found two ways, by their record
//     (pipeline-<stem>.json with a step running and its pid alive) and by
//     process (ps args naming this bundle's capture-cli.js or capture-recover.js).
//     A pipeline between its spawn and its first record write is seen only by
//     ps; a ps that fails counts as busy.
//   - no upload in progress
//
// Queued uploads do not block (Jon, 2026-10-29): they are files in the support
// folder, outside the bundle, and the relaunched app drains them at launch
// (drainUploadQueue('launch')). So the queue is not an input here at all.
//
// A recycled pid makes a finished pipeline look alive: that errs toward busy,
// a later apply, never toward an apply under a running pipeline.
//
// Split out of main.js, like autostop.js, so check-update-gate.js can run the
// rule without Electron. main.js gathers the inputs and acts on the answer, in
// the same tick.

'use strict';

// Stems whose record shows a step running under a pid that is still alive, as
// main.js pipelineSettled reads one. records: [{ stem, doc }], doc null when the
// file could not be read or parsed (skipped: ps is the backstop).
function liveRecordStems(records, isAlive) {
    const out = [];
    for (const r of records || []) {
        const doc = r && r.doc;
        if (!doc || typeof doc !== 'object') continue;
        const running = Object.values(doc.steps || {}).some((st) => st && st.state === 'running');
        if (running && Number.isInteger(doc.pid) && isAlive(doc.pid)) out.push(r.stem);
    }
    return out;
}

// Pids from `ps -A -ww -o pid=,args=` output whose args name one of entries
// (this bundle's pipeline scripts). Null when there is no output to read.
function pipelineProcesses(psOut, entries) {
    if (typeof psOut !== 'string') return null;
    const out = [];
    for (const line of psOut.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) continue;
        if (entries.some((e) => m[2].includes(e))) out.push(Number(m[1]));
    }
    return out;
}

const busy = (reason) => ({ idle: false, reason });

// s: { state, session, teardownInFlight, anyWindowOpen, pipelineRunning,
//      recoveryRunning, pipelineRecords, isAlive, psOut, entries, uploadDraining }
// Returns { idle, reason }: the first thing found busy, or idle with reason null.
function idleState(s) {
    if (s.state !== 'stopped' || s.session) return busy('recording');
    if (s.teardownInFlight) return busy('stopping');
    if (s.anyWindowOpen) return busy('window open');
    if (s.pipelineRunning) return busy('pipeline running');
    if (s.recoveryRunning) return busy('recovery running');
    const stems = liveRecordStems(s.pipelineRecords, s.isAlive);
    if (stems.length) return busy(`pipeline running for ${stems[0]}`);
    const procs = pipelineProcesses(s.psOut, s.entries);
    if (procs === null) return busy('ps failed');
    if (procs.length) return busy(`pipeline process ${procs[0]}`);
    if (s.uploadDraining) return busy('upload in progress');
    return { idle: true, reason: null };
}

module.exports = { idleState, liveRecordStems, pipelineProcesses };
