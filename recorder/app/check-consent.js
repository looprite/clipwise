// Checks the first-run acknowledgement (SAA-216) without Electron.
//
// Usage:
//   node recorder/app/check-consent.js           the real rules
//   node recorder/app/check-consent.js --naive   "the file exists" in place of
//                                                 "the file says it was agreed to"
//
// Five groups:
//   1. The record on disk, against a temp directory: what counts as agreed to,
//      and that writing it is atomic, idempotent and works on a fresh install
//      (no directory yet).
//   2. The button and what happens after it, for both ways the window opens:
//      at launch ("I understand", starts nothing) and after a blocked start
//      ("I understand — start recording", starts a hand-started capture, and an
//      app-started one only while that app still holds the mic).
//   3. The notice line: the approved text, one line, plain ASCII, and the
//      notification that fires when recording starts carries it as its body.
//   4. Static checks on the source: the gate sits in startRecording before any
//      capture child can be spawned, capture children are spawned nowhere else,
//      the window text is the approved text, and build-app.sh copies both new
//      files into the bundle (a bundle without them fails to launch).
//   5. The notice stamp (SAA-227 part I): consent.js's noticeStamp is the
//      file's version and acknowledged_at and nothing else, or null when not
//      agreed to; buildManifest stamps it; the gate returns before any manifest
//      is built or written; and the capture body sends it.
//
// --naive swaps in a reader that accepts any existing file. It must FAIL the
// garbled, empty, wrong-shape and older-version cases; if it didn't, those
// cases could not tell a real check from a file-exists check.
//
// Exit 0 when every case matches its expectation, 1 otherwise.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const consent = require('./consent.js');

const useNaive = process.argv.includes('--naive');
const isAcknowledged = useNaive
    ? (dir) => fs.existsSync(consent.consentPath(dir))
    : (dir) => consent.isAcknowledged(dir);

function withDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-consent-'));
    try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const put = (dir, text) => fs.writeFileSync(consent.consentPath(dir), text);
const good = (v = consent.STATEMENT_VERSION) =>
    JSON.stringify({ version: v, acknowledged_at: '2026-10-07T20:00:00.000Z' });

const SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, 'consent.html'), 'utf8');
const BUILD = fs.readFileSync(path.join(__dirname, 'build-app.sh'), 'utf8');
const startBody = (() => {
    const a = SRC.indexOf('\nfunction startRecording()');
    const b = SRC.indexOf('\nfunction onCaptureChildExit', a);
    return a >= 0 && b > a ? SRC.slice(a, b) : '';
})();

// The branch of notifyStateChange that announces the start of a capture.
const startNotice = (() => {
    const a = SRC.indexOf("if (next === 'recording' && prev === 'starting') {");
    const b = SRC.indexOf('return;', a);
    return a >= 0 && b > a ? SRC.slice(a, b) : '';
})();

const holds = (...keys) => (k) => keys.includes(k);
const trig = { key: 'com.google.Chrome.helper', name: 'Google Chrome' };

const CASES = [
    // 1. the record on disk
    ['fresh install: no directory at all -> not agreed to', () => withDir(d => !isAcknowledged(path.join(d, 'nope')))],
    ['directory but no file -> not agreed to', () => withDir(d => !isAcknowledged(d))],
    ['valid file -> agreed to', () => withDir(d => { put(d, good()); return isAcknowledged(d); })],
    ['garbled file -> not agreed to', () => withDir(d => { put(d, '{not json'); return !isAcknowledged(d); })],
    ['empty file -> not agreed to', () => withDir(d => { put(d, ''); return !isAcknowledged(d); })],
    ['valid JSON, wrong shape (array) -> not agreed to', () => withDir(d => { put(d, '[]'); return !isAcknowledged(d); })],
    ['valid JSON, null -> not agreed to', () => withDir(d => { put(d, 'null'); return !isAcknowledged(d); })],
    ['object with no acknowledged_at -> not agreed to', () => withDir(d => { put(d, JSON.stringify({ version: 1 })); return !isAcknowledged(d); })],
    ['version below the current statement -> not agreed to', () => withDir(d => { put(d, good(0)); return !isAcknowledged(d); })],
    ['version above the current statement (newer build wrote it) -> agreed to', () => withDir(d => { put(d, good(consent.STATEMENT_VERSION + 1)); return isAcknowledged(d); })],
    ['recording creates the missing directory and the file reads back as agreed to', () => withDir(d => {
        const dir = path.join(d, 'a', 'b');
        consent.recordAcknowledgement(dir, new Date('2026-10-07T20:00:00Z'));
        return consent.isAcknowledged(dir) && consent.readConsent(dir).acknowledged_at === '2026-10-07T20:00:00.000Z'; })],
    ['recording leaves no temp file behind', () => withDir(d => {
        consent.recordAcknowledgement(d);
        return fs.readdirSync(d).join() === 'consent.json'; })],
    ['recording twice keeps the first time (idempotent)', () => withDir(d => {
        consent.recordAcknowledgement(d, new Date('2026-10-07T20:00:00Z'));
        consent.recordAcknowledgement(d, new Date('2026-10-08T09:00:00Z'));
        return consent.readConsent(d).acknowledged_at === '2026-10-07T20:00:00.000Z'; })],
    ['recording over an older-version file replaces it', () => withDir(d => {
        put(d, good(0));
        consent.recordAcknowledgement(d, new Date('2026-10-07T21:00:00Z'));
        const doc = consent.readConsent(d);
        return doc.version === consent.STATEMENT_VERSION && doc.acknowledged_at === '2026-10-07T21:00:00.000Z'; })],
    ['recording into an unwritable place throws and leaves it not agreed to', () => withDir(d => {
        // A file where the directory should be: mkdir fails, as it would on a read-only volume.
        const blocker = path.join(d, 'blocker'); fs.writeFileSync(blocker, 'x');
        let threw = false;
        try { consent.recordAcknowledgement(path.join(blocker, 'sub')); } catch { threw = true; }
        return threw && !consent.isAcknowledged(path.join(blocker, 'sub')); })],

    // 2. the button, and what happens after it
    ['launch: the button reads "I understand"', () => consent.buttonLabel('launch') === 'I understand'],
    ['blocked start: the button reads "I understand — start recording"', () => consent.buttonLabel('blocked') === 'I understand — start recording'],
    ['opened at launch: agreeing starts nothing, even with a blocked start on record', () =>
        consent.shouldStartAfterAcknowledgement('launch', { trigger: null }, holds()) === false],
    ['blocked, hand-started: agreeing starts a capture', () =>
        consent.shouldStartAfterAcknowledgement('blocked', { trigger: null }, holds()) === true],
    ['blocked, started by an app that still holds the mic: starts', () =>
        consent.shouldStartAfterAcknowledgement('blocked', { trigger: trig }, holds(trig.key)) === true],
    ['blocked, started by an app that has since let go: does not start', () =>
        consent.shouldStartAfterAcknowledgement('blocked', { trigger: trig }, holds()) === false],
    ['blocked, a different app holds the mic now: does not start', () =>
        consent.shouldStartAfterAcknowledgement('blocked', { trigger: trig }, holds('com.apple.avconferenced')) === false],
    ['blocked mode but nothing was turned away: does not start', () =>
        consent.shouldStartAfterAcknowledgement('blocked', null, holds(trig.key)) === false],

    // 3. the notice line
    ['notice line is the approved text', () => consent.NOTICE_LINE ===
        "I'm recording this call with Clipwise to take notes. Let me know if you'd rather I didn't."],
    ['notice line is one line', () => !/[\r\n]/.test(consent.NOTICE_LINE)],
    ['notice line is plain ASCII (printable only, straight apostrophes)', () => /^[\x20-\x7e]+$/.test(consent.NOTICE_LINE)],
    ['notice line has no leading or trailing space', () => consent.NOTICE_LINE === consent.NOTICE_LINE.trim()],

    // 4. static checks on the source
    ['gate: startRecording asks consent.isAcknowledged', () => startBody.includes('consent.isAcknowledged(SUPPORT_DIR)')],
    ['gate: it comes before the first capture child is spawned', () => {
        const g = startBody.indexOf('consent.isAcknowledged(SUPPORT_DIR)');
        const s = startBody.indexOf('spawnChild(');
        return g >= 0 && s > g; }],
    ['gate: it comes before the output directory is created', () => {
        const g = startBody.indexOf('consent.isAcknowledged(SUPPORT_DIR)');
        const m = startBody.indexOf('fs.mkdirSync(OUTDIR');
        return g >= 0 && m > g; }],
    ['gate: capture children are spawned only inside startRecording', () => {
        let n = 0, i = -1; while ((i = SRC.indexOf('spawnChild(', i + 1)) >= 0) n++;
        let inside = 0; i = -1; while ((i = startBody.indexOf('spawnChild(', i + 1)) >= 0) inside++;
        // one extra for the function's own declaration, outside startRecording
        return inside >= 1 && n === inside + 1; }],
    ['gate: a blocked start opens the window and returns', () =>
        /showConsentWindow\('blocked'\);[\s\S]{0,400}?return;/.test(startBody)],
    ['window text: title and the three paragraphs are the approved text', () => [
        'Before you record',
        'Clipwise records calls on this Mac without joining them. No bot appears in the meeting, so nobody else on the call can see that it is recording.',
        'You are responsible for telling the people you record, and for following the laws and workplace rules that apply to you. In many places everyone on a call has to agree to be recorded.',
        'When you start recording, Clipwise shows a short line you can say to let everyone know. On calls with a chat, &ldquo;Copy recording notice&rdquo; in the menu bar copies it for you.',
        'Not now',
    ].every(t => HTML.includes(t))],
    ['window: the primary button is labelled by main.js, not hard-coded to one mode', () =>
        HTML.includes("params.get('label')") && HTML.includes('consent:set-label')],
    ['start notification: fires on the move from starting to recording', () => startNotice.length > 0],
    ['start notification: the body is consent.NOTICE_LINE, the same line the tray copies', () =>
        /notify\([^;]*,\s*consent\.NOTICE_LINE\)/.test(startNotice)],
    ['start notification: the title tells the host to let everyone know', () =>
        /notify\('Recording \\u2014 let everyone know',/.test(startNotice)],
    ['start notification: the old "recording started" text is gone', () =>
        !SRC.includes("'Clipwise: recording started'") && !startNotice.includes('Capturing your mic')],
    ['start notification: it is not behind the stalled/resumed flap throttle', () =>
        !startNotice.includes('lastFlapNotifyMs')],
    ['tray: "Copy recording notice" is offered only while a capture is active', () =>
        /if \(active\) items\.push\(\{ label: 'Copy recording notice'/.test(SRC)],
    ['tray: an unacknowledged install has a "Recording notice" item', () => SRC.includes("label: 'Recording notice")],
    ['fresh support dir: the recordings dir is created before the recovery sweep runs', () => {
        const a = SRC.indexOf("fs.mkdirSync(OUTDIR, { recursive: true }); } catch (err) {\n        console.error(`launch: could not create");
        const b = SRC.indexOf("startRecovery('app launch');");
        return a >= 0 && b > a; }],
    ['fresh support dir: that mkdir sits inside app.whenReady, after the tray exists', () => {
        const w = SRC.indexOf('app.whenReady().then(');
        const t = SRC.indexOf('tray = new Tray(', w);
        const a = SRC.indexOf('could not create ${OUTDIR}', w);
        return w >= 0 && t > w && a > t; }],
    ['launch: the window opens at launch when not agreed to', () =>
        /if \(!consent\.isAcknowledged\(SUPPORT_DIR\)\) showConsentWindow\('launch'\)/.test(SRC)],
    ['build-app.sh copies consent.js into the bundle', () => /cp "\$APP_SRC\/consent\.js" "\$C\/Resources\/app\/consent\.js"/.test(BUILD)],
    ['build-app.sh copies consent.html into the bundle', () => /cp "\$APP_SRC\/consent\.html" "\$C\/Resources\/app\/consent\.html"/.test(BUILD)],

    // 5. the notice stamp a capture carries (SAA-227 part I)
    ['stamp: agreed to -> version and acknowledged_at, equal to consent.json', () => withDir(d => {
        consent.recordAcknowledgement(d, new Date('2026-10-07T21:18:52Z'));
        const file = JSON.parse(fs.readFileSync(consent.consentPath(d), 'utf8'));
        return JSON.stringify(consent.noticeStamp(d)) === JSON.stringify({ version: file.version, acknowledged_at: file.acknowledged_at }); })],
    ['stamp: only those two fields, whatever else the file holds', () => withDir(d => {
        put(d, JSON.stringify({ version: consent.STATEMENT_VERSION, acknowledged_at: '2026-10-07T21:18:52.000Z', note: 'x' }));
        return JSON.stringify(Object.keys(consent.noticeStamp(d))) === JSON.stringify(['version', 'acknowledged_at']); })],
    ['stamp: not agreed to (no file, or an older version) -> null', () => withDir(d => {
        const none = consent.noticeStamp(d) === null;
        put(d, good(0));
        return none && consent.noticeStamp(d) === null; })],
    ['manifest: buildManifest stamps consent.noticeStamp(SUPPORT_DIR)', () => {
        const a = SRC.indexOf('\nfunction buildManifest(');
        const b = SRC.indexOf('\n}\n', a);
        return a >= 0 && SRC.slice(a, b).includes('notice: consent.noticeStamp(SUPPORT_DIR),'); }],
    ['manifest: a capture the gate blocks writes none (the gate returns before buildManifest and the manifest write)', () => {
        const g = startBody.indexOf('consent.isAcknowledged(SUPPORT_DIR)');
        const r = startBody.indexOf('return;', g);
        const m = startBody.indexOf('buildManifest(');
        const w = startBody.indexOf('fs.writeFileSync(paths.manifest');
        return g >= 0 && r > g && m > r && w > m; }],
    ['builder: the capture body sends the manifest\'s stamp as notice', () =>
        /notice: manifest\.notice\s*\?\s*\{ version: manifest\.notice\.version, acknowledgedAt: manifest\.notice\.acknowledged_at \}/.test(SRC)],
];

console.log(`rule: ${useNaive ? 'NAIVE (any existing file counts as agreed to)' : 'consent.js'}`);
let fails = 0;
for (const [name, fn] of CASES) {
    let ok = false;
    try { ok = !!fn(); } catch (err) { ok = false; }
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\n${CASES.length - fails}/${CASES.length} as expected`);
process.exit(fails ? 1 : 0);
