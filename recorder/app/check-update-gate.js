// Checks update-gate.js's idle rule (SAA-253 decisions 4 and 5).
//
// Usage:
//   node recorder/app/check-update-gate.js            the real rule
//   node recorder/app/check-update-gate.js --naive    idle whenever no capture is running
//   node recorder/app/check-update-gate.js --stage1   the rule as first proposed: a queued
//                                                     upload blocks, an open window
//                                                     does not
//
// Each stand-in must FAIL the cases it gets wrong. --naive misses everything
// after a capture ends: the stop, the windows, the pipelines from this run and
// earlier ones, a failed ps, an upload in progress. --stage1 fails exactly the
// cases Jon ruled on 2026-10-29: queued uploads must not block, and any open
// Clipwise window must.
//
// Exit 0 when every case matches its expectation, 1 otherwise.

'use strict';

const { idleState, liveRecordStems, pipelineProcesses } = require('./update-gate.js');

const RES = '/Applications/Clipwise.app/Contents/Resources';
const ENTRIES = [`${RES}/pipeline/pipeline/capture-cli.js`, `${RES}/pipeline/pipeline/capture-recover.js`];
const EXEC = '/Applications/Clipwise.app/Contents/MacOS/Clipwise';
const OUTDIR = '/Users/x/Library/Application Support/clipwise/recordings';
const ALIVE = new Set([4242]);
const PS_QUIET = [
    `  1 /sbin/launchd`,
    `501 ${EXEC}`,
    `502 ${EXEC} --type=renderer`,
    `503 ${RES}/bin/micwatch`,
].join('\n') + '\n';

// Everything quiet: stopped, nothing running, ps reads, nothing uploading.
const QUIET = {
    state: 'stopped', session: null, teardownInFlight: false, anyWindowOpen: false,
    pipelineRunning: false, recoveryRunning: false,
    pipelineRecords: [], isAlive: (pid) => ALIVE.has(pid),
    psOut: PS_QUIET, entries: ENTRIES,
    uploadDraining: false, uploadQueue: [],
};
const w = (over) => ({ ...QUIET, ...over });
const rec = (stem, pid, steps) => ({ stem, doc: { pid, steps } });

const CASES = [
    { name: 'all quiet', expect: 'idle', s: w({}) },
    { name: 'recording', expect: 'recording', s: w({ state: 'recording', session: {} }) },
    { name: 'starting', expect: 'recording', s: w({ state: 'starting', session: {} }) },
    { name: 'stalled', expect: 'recording', s: w({ state: 'stalled', session: {} }) },
    { name: 'stopped, session not yet cleared', expect: 'recording', s: w({ session: {} }) },
    { name: 'teardown in flight', expect: 'stopping', s: w({ teardownInFlight: true }) },
    { name: 'identity window open (Jon, 10-29)', expect: 'window open', s: w({ anyWindowOpen: true }) },
    { name: 'voice-naming window open', expect: 'window open', s: w({ anyWindowOpen: true }) },
    { name: 'setup window open', expect: 'window open', s: w({ anyWindowOpen: true }) },
    { name: 'Recent meetings window open', expect: 'window open', s: w({ anyWindowOpen: true }) },
    { name: 'this run\'s pipeline running', expect: 'pipeline running', s: w({ pipelineRunning: true }) },
    { name: 'recovery pass running', expect: 'recovery running', s: w({ recoveryRunning: true }) },
    { name: 'earlier run\'s pipeline: step running, pid alive', expect: 'pipeline running for 20261029T120000Z',
      s: w({ pipelineRecords: [rec('20261029T120000Z', 4242, { transcribe: { state: 'running' } })] }) },
    { name: 'record says running, pid gone (killed mid-step)', expect: 'idle',
      s: w({ pipelineRecords: [rec('20261029T120000Z', 9999, { transcribe: { state: 'running' } })] }) },
    { name: 'record finished, pid alive (recycled)', expect: 'idle',
      s: w({ pipelineRecords: [rec('20261029T120000Z', 4242, { transcribe: { state: 'done' }, classify: { state: 'done' } })] }) },
    { name: 'record unreadable: skipped, ps is the backstop', expect: 'idle',
      s: w({ pipelineRecords: [{ stem: '20261029T120000Z', doc: null }] }) },
    { name: 'pipeline process in ps, no record yet', expect: 'pipeline process 777',
      s: w({ psOut: PS_QUIET + `777 ${EXEC} ${ENTRIES[0]} ${OUTDIR} --stem 20261029T120000Z\n` }) },
    { name: 'recovery process in ps (an earlier launch\'s)', expect: 'pipeline process 778',
      s: w({ psOut: PS_QUIET + `778 ${EXEC} ${ENTRIES[1]} ${OUTDIR}\n` }) },
    { name: 'another bundle\'s pipeline in ps (a worktree build): not this bundle', expect: 'idle',
      s: w({ psOut: PS_QUIET + `779 /Users/x/code/wt/recorder/app/dist/Clipwise.app/Contents/MacOS/Clipwise /Users/x/code/wt/recorder/app/dist/Clipwise.app/Contents/Resources/pipeline/pipeline/capture-cli.js ${OUTDIR}\n` }) },
    { name: 'ps failed', expect: 'ps failed', s: w({ psOut: null }) },
    { name: 'upload in progress', expect: 'upload in progress', s: w({ uploadDraining: true }) },
    { name: 'queued uploads, none in progress: drain after relaunch (Jon, 10-29)', expect: 'idle',
      s: w({ uploadQueue: [{ stem: 'a', state: 'queued' }, { stem: 'b', state: 'queued' }] }) },
    { name: 'failed and sent entries only', expect: 'idle',
      s: w({ uploadQueue: [{ stem: 'a', state: 'failed' }, { stem: 'b', state: 'sent' }] }) },
];

// Idle whenever no capture is running.
function naive(s) {
    return s.state === 'stopped' && !s.session ? { idle: true, reason: null } : { idle: false, reason: 'recording' };
}

// The stage-1 proposal: any queued entry blocks; open windows are not looked at.
function stage1(s) {
    const r = idleState({ ...s, anyWindowOpen: false });
    if (r.idle && (s.uploadQueue || []).some((e) => e.state === 'queued')) return { idle: false, reason: 'upload queued' };
    return r;
}

const mode = process.argv.includes('--naive') ? 'naive' : process.argv.includes('--stage1') ? 'stage1' : 'real';
const rule = { naive, stage1, real: idleState }[mode];

console.log(`rule: ${mode === 'real' ? 'update-gate.js idleState' : mode.toUpperCase()}`);
let fails = 0;
for (const c of CASES) {
    const r = rule(c.s);
    const ok = c.expect === 'idle' ? r.idle === true && r.reason === null : r.idle === false && r.reason === c.expect;
    if (!ok) fails++;
    const got = r.idle ? 'idle' : `busy: ${r.reason}`;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${(c.expect === 'idle' ? 'idle' : `busy: ${c.expect}`).padEnd(48)}  ${got.padEnd(48)}  ${c.name}`);
}
console.log(`\nrule cases: ${CASES.length - fails}/${CASES.length} as expected`);

// --- the two readers, directly -----------------------------------------------
const HELPERS = [
    { name: 'liveRecordStems: only running + alive counts',
      ok: () => JSON.stringify(liveRecordStems([
          rec('a', 4242, { x: { state: 'running' } }),
          rec('b', 9999, { x: { state: 'running' } }),
          rec('c', 4242, { x: { state: 'done' } }),
          rec('d', '4242', { x: { state: 'running' } }),
          { stem: 'e', doc: null },
      ], (pid) => ALIVE.has(pid))) === '["a"]' },
    { name: 'liveRecordStems: no records -> []', ok: () => liveRecordStems(undefined, () => true).length === 0 },
    { name: 'pipelineProcesses: quiet ps -> []', ok: () => JSON.stringify(pipelineProcesses(PS_QUIET, ENTRIES)) === '[]' },
    { name: 'pipelineProcesses: both entries found, in order',
      ok: () => JSON.stringify(pipelineProcesses(PS_QUIET + `777 ${EXEC} ${ENTRIES[0]} x\n778 ${EXEC} ${ENTRIES[1]} x\n`, ENTRIES)) === '[777,778]' },
    { name: 'pipelineProcesses: no output -> null', ok: () => pipelineProcesses(undefined, ENTRIES) === null },
];
let helperFails = 0;
if (mode === 'real') {
    for (const h of HELPERS) {
        let ok = false;
        try { ok = h.ok(); } catch { ok = false; }
        if (!ok) helperFails++;
        console.log(`${ok ? 'PASS' : 'FAIL'}  helper  ${h.name}`);
    }
    console.log(`helper cases: ${HELPERS.length - helperFails}/${HELPERS.length} as expected`);
}

const total = CASES.length + (mode === 'real' ? HELPERS.length : 0);
console.log(`\n${total - fails - helperFails}/${total} as expected`);
process.exit(fails || helperFails ? 1 : 0);
