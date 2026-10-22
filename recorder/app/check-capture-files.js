#!/usr/bin/env node
// Deleting a capture from the trash removes its upload-queue entry and leaves
// every other capture's files and entry as they were (SAA-243 item 7).
//
//   node check-capture-files.js
//   CLIPWISE_CHECK_SOURCE=c5b1408 node check-capture-files.js
//
// The second form runs the same cases against that revision: its main.js
// removeCaptureFiles body, run with OUTDIR bound to the fixture, and its main.js
// text for the wiring cases. Only the queue-entry cases should fail there.
//
// Cases 1-8 run the code against a temporary folder. Cases 9-11 read main.js and
// build-app.sh as text: they show the call passes the queue folder, the upload
// drain does not write back an entry that has gone, and the bundle gets the
// module, not that any of it runs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REV = process.env.CLIPWISE_CHECK_SOURCE || '';
const SRC = REV
    ? execFileSync('git', ['show', `${REV}:recorder/app/main.js`], { cwd: __dirname, encoding: 'utf8' })
    : fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const BUILD = REV
    ? execFileSync('git', ['show', `${REV}:recorder/app/build-app.sh`], { cwd: __dirname, encoding: 'utf8' })
    : fs.readFileSync(path.join(__dirname, 'build-app.sh'), 'utf8');

// (outdir, queueDir, stem) -> files removed, for whichever source is under check.
function loadRemove() {
    if (!REV) return require('./capture-files.js').removeCaptureFiles;
    const body = (name) => {
        const m = new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm').exec(SRC);
        if (!m) throw new Error(`${REV}: no function ${name} in main.js`);
        return m[0];
    };
    return (outdir, _queueDir, stem) => new Function('fs', 'path', 'OUTDIR',
        `${body('trashMarkerPath')}\n${body('removeCaptureFiles')}\nreturn removeCaptureFiles;`,
    )(fs, path, outdir)(stem);
}
const removeCaptureFiles = loadRemove();

const A = '2026-10-01T10-00-00Z';
const B = '2026-10-01T11-00-00Z';
const captureFiles = (s) => [
    `system-${s}.f32le.pcm`, `systemtap-${s}.log`, `mic-${s}.wav`, `mic-${s}.log`,
    `poller-${s}.log`, `pipeline-${s}.log`, `pipeline-${s}.json`, `identity-${s}.json`,
    `calendar-match-${s}.json`, `manifest-${s}.json`,
];
// Not A's, though each contains A's stem or sits beside it.
const OTHERS = [`mic-${A}0.wav`, 'recorder-2026-10-01.log', 'recovery.log', 'identity-self.json'];

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-check-capture-files-'));
    const outdir = path.join(root, 'recordings');
    const queueDir = path.join(root, 'upload-queue');
    fs.mkdirSync(outdir);
    fs.mkdirSync(queueDir);
    for (const s of [A, B]) {
        for (const f of captureFiles(s)) fs.writeFileSync(path.join(outdir, f), `${f}\n`);
        fs.writeFileSync(path.join(outdir, `trashed-${s}.json`), JSON.stringify({ stem: s }) + '\n');
        fs.writeFileSync(path.join(queueDir, `${s}.json`), JSON.stringify({ stem: s, state: 'sent' }) + '\n');
    }
    for (const f of OTHERS) fs.writeFileSync(path.join(outdir, f), `${f}\n`);
    return { root, outdir, queueDir };
}

// Every file under the fixture, by path relative to it, with its bytes.
function snapshot(root) {
    const out = new Map();
    for (const dir of ['recordings', 'upload-queue']) {
        for (const f of fs.readdirSync(path.join(root, dir))) {
            out.set(`${dir}/${f}`, fs.readFileSync(path.join(root, dir, f), 'utf8'));
        }
    }
    return out;
}

// Delete A with fs.rmSync recorded, in order, as paths relative to the fixture.
const fx = fixture();
const before = snapshot(fx.root);
const calls = [];
const realRmSync = fs.rmSync;
fs.rmSync = (p, opts) => {
    calls.push(path.relative(fx.root, String(p)));
    return realRmSync(p, opts);
};
let returned, threw = null;
try {
    returned = removeCaptureFiles(fx.outdir, fx.queueDir, A);
} catch (err) {
    threw = err;
} finally {
    fs.rmSync = realRmSync;
}
const after = snapshot(fx.root);
const notA = [...before.keys()].filter((k) => !k.includes(A) || OTHERS.some((o) => k.endsWith(`/${o}`)));
const markerA = `recordings/trashed-${A}.json`;
const queueA = `upload-queue/${A}.json`;
const manifestA = `recordings/manifest-${A}.json`;

const CASES = [
    ['runs: deleting A throws nothing', () => threw === null],
    ['returns how many of A\'s files went from recordings/, the marker not counted', () =>
        returned === captureFiles(A).length],
    ['every one of A\'s capture files and its trash marker are gone', () =>
        [...captureFiles(A).map((f) => `recordings/${f}`), markerA].every((k) => !after.has(k))],
    ['A\'s upload-queue entry is gone', () => !after.has(queueA)],
    ['control: B\'s files, B\'s marker, B\'s queue entry and every non-A file are there, byte for byte', () =>
        notA.length === captureFiles(B).length + 2 + OTHERS.length
        && notA.every((k) => after.has(k) && after.get(k) === before.get(k))],
    ['order: the manifest goes after every other capture file', () => {
        const m = calls.indexOf(manifestA);
        return m >= 0 && captureFiles(A).filter((f) => !f.startsWith('manifest-'))
            .every((f) => { const i = calls.indexOf(`recordings/${f}`); return i >= 0 && i < m; });
    }],
    ['order: the queue entry is removed, after the manifest and before the marker', () => {
        const q = calls.indexOf(queueA);
        return q >= 0 && q > calls.indexOf(manifestA) && q < calls.indexOf(markerA);
    }],
    ['order: the marker is the last removal', () => calls[calls.length - 1] === markerA],
    ['main.js (text): the delete passes the upload-queue folder', () =>
        SRC.includes('removeCaptureFiles(OUTDIR, UPLOAD_QUEUE_DIR, stem)')],
    ['main.js (text): the upload drain skips an entry that has gone before writing its outcome', () =>
        /if \(!fs\.existsSync\(uploadQueuePathFor\(entry\.stem\)\)\) continue;\n\s*const current = readUploadEntry\(entry\.stem\);[\s\S]{0,300}writeUploadEntry\(next\)/.test(SRC)],
    ['build-app.sh (text): copies capture-files.js into the bundle (main.js requires it)', () =>
        BUILD.includes('cp "$APP_SRC/capture-files.js" "$C/Resources/app/capture-files.js"')],
];

fs.rmSync(fx.root, { recursive: true, force: true });

console.log(`source: ${REV ? `${REV} main.js` : 'capture-files.js and main.js in the checkout'}`);
console.log('expected to fail on c5b1408: cases 4, 7, 9, 10 and 11, and nothing else');
console.log(`rmSync order: ${calls.join(', ')}`);
if (threw) console.log(`threw: ${String(threw)}`);
let fails = 0;
CASES.forEach(([name, fn], i) => {
    let ok = false;
    try { ok = !!fn(); } catch { ok = false; }
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${i + 1}. ${name}`);
});
console.log(`\n${CASES.length - fails}/${CASES.length} as expected`);
process.exit(fails ? 1 : 0);
