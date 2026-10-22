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
//   6. First-run setup and the rest of SAA-198 step 4 (setup.js, setup.html,
//      main.js, build-app.sh): the screen order and what counts as done; an
//      install with all four done is recorded as set up; the tray's account
//      items before and after setup; the team address and the Clipwise check;
//      the recording time; launch at login and the move offer; and static checks
//      for the lock, the Dock, the build number, Electron's default texts and
//      the system audio prompt writing nowhere.
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
// The notice is the first screen of setup.html (SAA-198 step 4); before that it
// was consent.html. A missing file reads as empty, so the cases on it fail
// rather than the whole run.
const readOr = (name) => { try { return fs.readFileSync(path.join(__dirname, name), 'utf8'); } catch { return ''; } };
const HTML = readOr('setup.html');
const BUILD = fs.readFileSync(path.join(__dirname, 'build-app.sh'), 'utf8');
// Group 8, the notices (SAA-198 step 7): the repo's THIRD_PARTY_NOTICES, the
// README, notarize.sh and ffmpeg's build script. Missing reads as empty.
const readRepo = (rel) => { try { return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8'); } catch { return ''; } };
const NOTICES = readRepo('THIRD_PARTY_NOTICES');
const README = readRepo('README.md');
const NOTARIZE = readOr('notarize.sh');
const FFMPEG_BUILD = readRepo('recorder/ffmpeg/build.sh');
// Required lazily for the same reason: without setup.js its cases fail one by one.
let setup = null;
try { setup = require('./setup.js'); } catch {}
const whenReadyBody = (() => {
    const a = SRC.indexOf('app.whenReady().then(');
    const b = SRC.indexOf('\n});\n', a);
    return a >= 0 && b > a ? SRC.slice(a, b) : '';
})();
const fnBody = (name) => {
    const a = SRC.search(new RegExp(`\\n(async )?function ${name}\\(`));
    const b = SRC.indexOf('\n}\n', a + 1);
    return a >= 0 && b > a ? SRC.slice(a, b) : '';
};
const ALL_DONE = { acknowledged: true, server: 'https://team.example.com', signedIn: true, mic: 'granted', tap: 'granted' };
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
        /showSetupWindow\('blocked'\);[\s\S]{0,400}?return;/.test(startBody)],
    ['window text: title and the three paragraphs are the approved text', () => [
        'Before you record',
        'Clipwise records calls on this Mac without joining them. No bot appears in the meeting, so nobody else on the call can see that it is recording.',
        'You are responsible for telling the people you record, and for following the laws and workplace rules that apply to you. In many places everyone on a call has to agree to be recorded.',
        'When you start recording, Clipwise shows a short line you can say to let everyone know. On calls with a chat, &ldquo;Copy recording notice&rdquo; in the menu bar copies it for you.',
        'Not now',
    ].every(t => HTML.includes(t))],
    ['window: the primary button is labelled by main.js, not hard-coded to one mode', () =>
        HTML.includes('v.noticeLabel') && fnBody('setupView').includes('noticeLabel: consent.buttonLabel(w.mode)')],
    ['start notification: fires on the move from starting to recording', () => startNotice.length > 0],
    ['start notification: the body is consent.NOTICE_LINE, the same line the tray copies', () =>
        /notify\([^;]*,\s*consent\.NOTICE_LINE\)/.test(startNotice)],
    ['start notification: the title tells the host to let everyone know', () =>
        /notify\('recording-started-notice', 'Recording \\u2014 let everyone know',/.test(startNotice)],
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
    ['launch: the window opens at launch when not agreed to (showSetupWindow at launch, which stays shut only when setup is finished and the notice agreed to)', () =>
        whenReadyBody.includes("showSetupWindow('launch');")
        && /if \(noticeOnly && consent\.isAcknowledged\(SUPPORT_DIR\)\) return;/.test(fnBody('showSetupWindow'))],
    ['build-app.sh copies consent.js into the bundle', () => /cp "\$APP_SRC\/consent\.js" "\$C\/Resources\/app\/consent\.js"/.test(BUILD)],
    ['build-app.sh copies setup.js and setup.html into the bundle', () =>
        /cp "\$APP_SRC\/setup\.js" "\$C\/Resources\/app\/setup\.js"/.test(BUILD)
        && /cp "\$APP_SRC\/setup\.html" "\$C\/Resources\/app\/setup\.html"/.test(BUILD)],

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

    // 6. first-run setup and the rest of SAA-198 step 4
    ['setup: the five screens, in order: notice, address, sign-in, permissions, Use Clipwise in Claude', () =>
        JSON.stringify(setup.SCREENS) === JSON.stringify(['notice', 'address', 'signin', 'permissions', 'claude'])],
    ['setup: opens at the first screen not done', () => {
        const at = (s) => setup.firstIncompleteScreen({ ...ALL_DONE, ...s });
        return at({ acknowledged: false, server: null, signedIn: false }) === 'notice'
            && at({ server: null, signedIn: false }) === 'address'
            && at({ signedIn: false }) === 'signin'
            && at({ tap: 'notDetermined' }) === 'permissions'
            && at({ mic: 'denied' }) === 'permissions'
            && at({}) === null; }],
    ['setup: a notice not agreed to comes first even when everything after it is done', () =>
        setup.firstIncompleteScreen({ ...ALL_DONE, acknowledged: false }) === 'notice'],
    ['setup: restricted, unavailable and unexpected grants do not hold setup open', () =>
        ['restricted', 'unavailable', 'unexpected(7)'].every(s => setup.firstIncompleteScreen({ ...ALL_DONE, mic: s, tap: s }) === null)],
    ['setup: all four done and no setup.json -> no "Finish setting up" item, and setup.json is written', () => withDir(d => {
        const before = fs.existsSync(setup.setupPath(d));
        const completed = setup.settleSetup(d, ALL_DONE, new Date('2026-10-13T20:00:00Z'));
        const items = setup.trayAccountItems({ setupCompleted: completed, ...ALL_DONE });
        const doc = JSON.parse(fs.readFileSync(setup.setupPath(d), 'utf8'));
        return !before && completed && !items.includes('finish-setup')
            && doc.completed_at === '2026-10-13T20:00:00.000Z' && setup.isSetupCompleted(d); })],
    ['setup: one screen not done and no setup.json -> not finished, and nothing written', () => withDir(d =>
        setup.settleSetup(d, { ...ALL_DONE, tap: 'notDetermined' }) === false && !fs.existsSync(setup.setupPath(d)))],
    ['setup: once finished it stays finished, whatever is undone later (a sign-out)', () => withDir(d => {
        setup.recordSetupCompleted(d);
        return setup.settleSetup(d, { ...ALL_DONE, signedIn: false }) === true; })],
    ['setup: recording it creates the directory, keeps the first time and leaves no temp file', () => withDir(d => {
        const dir = path.join(d, 'a', 'b');
        setup.recordSetupCompleted(dir, new Date('2026-10-13T20:00:00Z'));
        setup.recordSetupCompleted(dir, new Date('2026-10-14T09:00:00Z'));
        return setup.isSetupCompleted(dir)
            && JSON.parse(fs.readFileSync(setup.setupPath(dir), 'utf8')).completed_at === '2026-10-13T20:00:00.000Z'
            && fs.readdirSync(dir).join() === 'setup.json'; })],
    ['setup: a garbled or empty setup.json is not finished', () => withDir(d => {
        fs.writeFileSync(setup.setupPath(d), '{not json');
        const garbled = setup.isSetupCompleted(d);
        fs.writeFileSync(setup.setupPath(d), JSON.stringify({ completed_at: '' }));
        return !garbled && !setup.isSetupCompleted(d); })],
    ['tray: setup never finished -> only "Finish setting up", not the notice or sign-in items', () =>
        JSON.stringify(setup.trayAccountItems({ setupCompleted: false, acknowledged: false, server: 'https://t.example.com', signedIn: false })) === JSON.stringify(['finish-setup'])],
    ['tray: setup finished, then signed out -> "Sign in to Clipwise", not "Finish setting up"', () =>
        JSON.stringify(setup.trayAccountItems({ setupCompleted: true, acknowledged: true, server: 'https://t.example.com', signedIn: false })) === JSON.stringify(['sign-in'])],
    ['tray: setup finished, notice version raised -> "Recording notice"', () =>
        setup.trayAccountItems({ setupCompleted: true, acknowledged: false, server: 'https://t.example.com', signedIn: true }).includes('recording-notice')],
    ['tray: signed in -> "Sign out", and no sign-in item', () => {
        const items = setup.trayAccountItems({ setupCompleted: true, acknowledged: true, server: 'https://t.example.com', signedIn: true });
        return items.includes('sign-out') && !items.includes('sign-in'); }],
    ['tray: main.js labels the items, and Sign out revokes on the server before signing out on the Mac (SAA-198 step 5)', () => {
        const body = fnBody('signOutFromTray');
        const revoke = body.indexOf('await revokeRefreshToken(held.server, held.refresh, CAPTURE_CLIENT_ID)');
        const local = body.indexOf("signOutOfCaptureServer('tray')");
        return SRC.includes("label: 'Finish setting up Clipwise…'")
            && /label: 'Sign out', click: signOutFromTray \}/.test(SRC)
            && revoke >= 0 && local > revoke
            && SRC.includes('setup.trayAccountItems({ setupCompleted: setupCompleted(), ...setupStatus() })'); }],
    ['build-app.sh copies capture-sign-out.js into the bundle (main.js requires it)', () =>
        /cp "\$APP_SRC\/capture-sign-out\.js" "\$C\/Resources\/app\/capture-sign-out\.js"/.test(BUILD)
        && SRC.includes("require('./capture-sign-out.js')")],
    ['build-app.sh copies capture-refresh.js into the bundle (main.js requires it)', () =>
        /cp "\$APP_SRC\/capture-refresh\.js" "\$C\/Resources\/app\/capture-refresh\.js"/.test(BUILD)
        && SRC.includes("require('./capture-refresh.js')")],
    ['wake from sleep: powerMonitor\'s resume logs and reschedules the capture-token refresh from the clock', () =>
        /const \{[^}]*\bpowerMonitor\b[^}]*\} = require\('electron'\);/.test(SRC)
        && /powerMonitor\.on\('resume', \(\) => \{\s*if \(!captureTokens\) return;\s*console\.error\(`\[clipwise-recorder\] capture token: resumed from sleep, refresh in \$\{captureRefreshDelay\(\)\} ms`\);\s*scheduleCaptureRefresh\(\);\s*\}\);/.test(SRC)
        && /function captureRefreshDelay\(\) \{\s*return Math\.max\(0, captureTokens\.expiresAt - CAPTURE_REFRESH_EARLY_MS - Date\.now\(\)\);\s*\}\s*function scheduleCaptureRefresh\(\) \{[\s\S]{0,120}setTimeout\(refreshCaptureToken, captureRefreshDelay\(\)\)/.test(SRC)],
    ['signed out by a refresh: one notification, whose click starts the tray\'s sign-in; the tray\'s Sign out shows none', () =>
        /function signOutAfterRefresh\(reason\) \{\s*signOutOfCaptureServer\(reason\);\s*notify\('signed-out', 'Clipwise is signed out', 'Recordings are kept and will upload after you sign in\.', signInToCaptureServer\);\s*\}/.test(SRC)
        && SRC.includes('{ signOut: signOutAfterRefresh, store: setCaptureTokens }')
        && (SRC.match(/signOutAfterRefresh/g) || []).length === 2
        && (SRC.match(/'Clipwise is signed out'/g) || []).length === 1
        && SRC.includes("signOutOfCaptureServer('tray');")
        && SRC.includes("items.push({ label: 'Sign in to Clipwise…', click: signInToCaptureServer });")],
    ['sign-in: queued captures waiting because no one was signed in are made due with attempts reset, logged, and the queue is drained', () =>
        /function sendUploadsWaitingOnSignIn\(\) \{\s*for \(const entry of listUploadQueue\(\)\) \{\s*if \(entry\.state !== 'queued' \|\| entry\.lastError !== 'not_signed_in'\) continue;\s*try \{\s*writeUploadEntry\(\{ \.\.\.entry, attempts: 0, nextAttemptAt: new Date\(\)\.toISOString\(\) \}\);\s*console\.error\(`\[clipwise-recorder\] upload \$\{entry\.stem\}: due now \(signed in\)`\);/.test(SRC)
        && /function sendUploadsWaitingOnSignIn\(\) \{[\s\S]{0,700}?\n    \}\n    drainUploadQueue\('sign-in'\);\n\}/.test(SRC)
        && /console\.error\(`\[clipwise-recorder\] sign-in: signed in to \$\{server\}`\);\s*sendUploadsWaitingOnSignIn\(\);\s*setupSignInFinished\(true\);/.test(SRC)
        && SRC.includes("retryLater(null, 'not_signed_in')")],
    ['address: no scheme means https, and only the origin is kept', () => {
        const a = setup.normalizeTeamAddress('  clipwise.example.com  ');
        const b = setup.normalizeTeamAddress('https://clipwise.example.com/login?x=1');
        return a.ok && a.origin === 'https://clipwise.example.com' && b.ok && b.origin === 'https://clipwise.example.com'; }],
    ['address: http only for localhost and 127.0.0.1', () =>
        setup.normalizeTeamAddress('http://localhost:3000').origin === 'http://localhost:3000'
        && setup.normalizeTeamAddress('http://127.0.0.1:3000').origin === 'http://127.0.0.1:3000'
        && !setup.normalizeTeamAddress('http://clipwise.example.com').ok
        && !setup.normalizeTeamAddress('http://localhost.example.com').ok],
    ['address: empty, a non-web scheme and junk are refused with a message', () =>
        ['', '   ', 'ftp://clipwise.example.com', 'https://'].every(t => { const r = setup.normalizeTeamAddress(t); return !r.ok && typeof r.error === 'string' && r.error.length > 0; })],
    ['address check: the scratch server\'s reply answers as Clipwise', () =>
        setup.isClipwiseDiscovery('http://localhost:3000', 200, { resource: 'http://localhost:3000/mcp', authorization_servers: ['http://localhost:3000/api/auth'], bearer_methods_supported: ['header'], resource_name: 'Clipwise' })],
    ['address check: another name, another origin\'s sign-in, a non-200 or no JSON does not', () => {
        const body = { authorization_servers: ['https://t.example.com/api/auth'], resource_name: 'Clipwise' };
        return !setup.isClipwiseDiscovery('https://t.example.com', 200, { ...body, resource_name: 'Other' })
            && !setup.isClipwiseDiscovery('https://t.example.com', 200, { ...body, authorization_servers: ['https://evil.example.com/api/auth'] })
            && !setup.isClipwiseDiscovery('https://t.example.com', 404, body)
            && !setup.isClipwiseDiscovery('https://t.example.com', 200, null); }],
    ['address check: main.js asks /.well-known/oauth-protected-resource and saves only on a pass', () => {
        const body = fnBody('checkTeamAddress');
        const ask = body.indexOf('/.well-known/oauth-protected-resource');
        const save = body.indexOf('writeCaptureServer(parsed.origin)');
        return ask >= 0 && save > ask && /if \(verdict === 'clipwise'\) \{[\s\S]{0,80}writeCaptureServer/.test(body); }],
    ['recording time: 0:00, 3:52, 59:59, 1:02:03', () =>
        setup.formatElapsed(0) === '0:00' && setup.formatElapsed(232000) === '3:52'
        && setup.formatElapsed(3599999) === '59:59' && setup.formatElapsed(3723000) === '1:02:03'],
    ['recording time: the tray title is "Rec <time>" from the capture\'s start, redrawn each second while recording', () =>
        /`Rec \$\{setup\.formatElapsed\(Date\.now\(\) - session\.startedAtMs\)\}`/.test(fnBody('trayTitle'))
        && /setInterval\(\(\) => \{ if \(tray\) tray\.setTitle\(trayTitle\(\)\); \}, 1000\)/.test(fnBody('syncTrayClock'))
        && fnBody('setState').includes('syncTrayClock();')],
    ['login item: on by default only from Applications, with setup finished, once', () =>
        setup.shouldApplyLoginDefault({ inApplications: true, setupCompleted: true, defaultApplied: false }) === true
        && setup.shouldApplyLoginDefault({ inApplications: false, setupCompleted: true, defaultApplied: false }) === false
        && setup.shouldApplyLoginDefault({ inApplications: true, setupCompleted: false, defaultApplied: false }) === false
        && setup.shouldApplyLoginDefault({ inApplications: true, setupCompleted: true, defaultApplied: true }) === false],
    ['login item: the record of the default reads back, and is kept as first written', () => withDir(d => {
        const before = setup.loginDefaultApplied(d);
        setup.recordLoginDefaultApplied(d, new Date('2026-10-13T20:00:00Z'));
        setup.recordLoginDefaultApplied(d, new Date('2026-10-14T09:00:00Z'));
        return !before && setup.loginDefaultApplied(d)
            && JSON.parse(fs.readFileSync(setup.loginItemPath(d), 'utf8')).default_applied_at === '2026-10-13T20:00:00.000Z'; })],
    ['login item: applied at launch and from Done; the tray toggle records a choice so the default never overrides it', () =>
        whenReadyBody.includes('applyLoginDefault();') && fnBody('finishSetup').includes('applyLoginDefault();')
        && fnBody('setOpenAtLogin').includes('setup.recordLoginDefaultApplied(SUPPORT_DIR)')
        && /label: 'Open at login', type: 'checkbox'/.test(SRC)],
    ['move: offered only by the built app, and only outside Applications', () =>
        setup.shouldOfferMove({ bundled: true, inApplications: false }) === true
        && setup.shouldOfferMove({ bundled: true, inApplications: true }) === false
        && setup.shouldOfferMove({ bundled: false, inApplications: false }) === false],
    ['move: offered before the tray exists, and a move stops the launch', () => {
        const m = whenReadyBody.indexOf('if (await offerMoveToApplications()) return;');
        const t = whenReadyBody.indexOf('tray = new Tray(');
        return m >= 0 && t > m && fnBody('offerMoveToApplications').includes('app.moveToApplicationsFolder()'); }],
    ['lock: requested at load, a second launch quits, and the boot code does nothing without it', () =>
        /\nconst GOT_SINGLE_INSTANCE_LOCK = app\.requestSingleInstanceLock\(\);\nif \(!GOT_SINGLE_INSTANCE_LOCK\) \{[\s\S]{0,200}app\.quit\(\);/.test(SRC)
        && whenReadyBody.includes('if (!GOT_SINGLE_INSTANCE_LOCK) return;')
        && SRC.indexOf('requestSingleInstanceLock') < SRC.indexOf('app.whenReady().then(')],
    ['lock: the pipeline child is this executable as Node, which never loads main.js, so the lock cannot hold it', () =>
        SRC.includes('requestSingleInstanceLock')
        && /cmd: process\.execPath/.test(fnBody('pipelineSpawn')) && /ELECTRON_RUN_AS_NODE: '1'/.test(fnBody('pipelineSpawn'))
        && /pipeline', 'capture-cli\.js'\)/.test(SRC)],
    ['permissions: the system audio prompt runs systemtap into /dev/null, so nothing it hears is kept', () => {
        const body = fnBody('promptForSystemAudio');
        return body.includes("SYSTEMTAP_OUT: '/dev/null'") && !/tmpdir|\.pcm/.test(body); }],
    ['permissions: never asked for before the notice is agreed to', () =>
        /ipcMain\.on\('setup:permission-request'[\s\S]{0,300}!consent\.isAcknowledged\(SUPPORT_DIR\)\) return;/.test(SRC)],
    ['permissions: the microphone is asked for with macOS\'s own prompt; a denial opens its System Settings pane', () =>
        fnBody('requestPermission').includes("systemPreferences.askForMediaAccess('microphone')")
        && /ipcMain\.on\('setup:permission-settings'[\s\S]{0,300}SETTINGS_PANE\[/.test(SRC)],
    ['window: a grant that is not granted, denied or notDetermined reads "Not available" in the muted style, never "Allowed" in green', () =>
        HTML.includes("const STATE_TEXT = { granted: 'Allowed', denied: 'Off', notDetermined: 'Not yet asked' };")
        && HTML.includes("(STATE_TEXT[state] || 'Not available')")
        && HTML.includes("el.className = `state ${state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : ''}`;")],
    ['window: the sign-in screen says Google asks once for read-only calendar access (SAA-198 step 5)', () =>
        HTML.includes('Google asks once for read-only access to your calendar, so your recordings get their meeting&rsquo;s title and invitees.')],
    ['window: setup.html has the five screens and the notice\'s approved title', () =>
        ['screen-notice', 'screen-address', 'screen-signin', 'screen-permissions', 'screen-claude', '<h1>Before you record</h1>'].every(t => HTML.includes(t))],

    // 7. Use Clipwise in Claude, setup's fifth screen (SAA-198 step 6, Jon's call 9)
    ['claude screen: the address is the team\'s origin plus /mcp, and none without a server', () =>
        setup.claudeAddress('https://clipwise.example.com') === 'https://clipwise.example.com/mcp'
        && setup.claudeAddress('http://localhost:3000') === 'http://localhost:3000/mcp'
        && setup.claudeAddress(null) === null],
    ['claude screen: it is what the window shows once the four before it are done, as step 5 of 5', () =>
        setup.firstIncompleteScreen(ALL_DONE) === null && setup.SCREENS.indexOf('claude') === 4
        && fnBody('setupView').includes("(w.override || setup.firstIncompleteScreen(status) || 'claude')")
        && fnBody('setupView').includes('claudeAddress: setup.claudeAddress(status.server)')],
    ['claude screen: an install with all four done is recorded as set up, so its window never opens as setup and never shows it', () => withDir(d =>
        setup.SCREENS.includes('claude') && setup.settleSetup(d, ALL_DONE) === true && setup.isSetupCompleted(d)
        && /if \(noticeOnly && consent\.isAcknowledged\(SUPPORT_DIR\)\) return;/.test(fnBody('showSetupWindow')))],
    ['claude screen: its text is the approved text, each line once', () => {
        const lines = [
            '<h1>Use Clipwise in Claude</h1>',
            'Ask Claude about your calls. Add this address to Claude as a custom connector:',
            '<li>Go to Customize, then Connectors, and click Add.</li>',
            '<li>Hover over Custom, then choose Web.</li>',
            '<li>Name it Clipwise, paste the address above, and click Continue.</li>',
            '<li>Under Authentication, choose Sign in now, then click Add. Sign in with Google when Clipwise asks.</li>',
            '<li>In a chat, click + (or type /), hover over Connectors, and turn Clipwise on.</li>',
            'To try it, ask: &ldquo;What changed in the Panfold project between the two calls, and is anyone behind on what they committed to?&rdquo;',
            'The two demo calls are made-up samples in your recordings, visible only to you. You can remove them any time from your sign-in page.',
        ];
        return lines.every(l => HTML.split(l).length - 1 === 1); }],
    ['claude screen: its five steps are one closed ordered list', () => {
        const a = HTML.indexOf('id="screen-claude"');
        const b = HTML.indexOf('</div>', HTML.indexOf('</ol>', a));
        const part = a >= 0 && b > a ? HTML.slice(a, b) : '';
        const count = (s) => part.split(s).length - 1;
        return count('<ol>') === 1 && count('</ol>') === 1 && count('<li>') === 5 && count('</li>') === 5; }],
    ['claude screen: Copy sends the address to main.js, which writes it to the clipboard', () =>
        HTML.includes('id="copy-address"') && HTML.includes("send('setup:copy-claude-address')")
        && /ipcMain\.on\('setup:copy-claude-address'[\s\S]{0,300}clipboard\.writeText\(address\)/.test(SRC)
        && /const address = setup\.claudeAddress\(readCaptureServerUrl\(\)\)/.test(SRC)],
    ['claude screen: Done is there and finishes setup; the permissions screen has no Done', () =>
        HTML.includes("else if (view.screen === 'claude') send('setup:done');")
        && !HTML.includes("else if (view.screen === 'permissions') send('setup:done');")
        && HTML.includes("primary.style.display = v.screen === 'permissions' ? 'none' : '';")],
    ['Dock: no icon — LSUIElement true in build-app.sh and app.dock.hide() at boot', () =>
        /set_key LSUIElement\s+bool\s+true/.test(BUILD) && whenReadyBody.includes('if (app.dock) app.dock.hide();')],
    ['build number: CFBundleVersion is the build\'s UTC time, not the version string', () =>
        /set_key CFBundleVersion\s+string "\$\(date -u \+%Y%m%d%H%M\)"/.test(BUILD) && !/set_key CFBundleVersion\s+string "\$VERSION"/.test(BUILD)],
    ['Info.plist: Electron\'s camera and both Bluetooth texts are deleted', () =>
        ['NSCameraUsageDescription', 'NSBluetoothPeripheralUsageDescription', 'NSBluetoothAlwaysUsageDescription'].every(k => BUILD.includes(k))
        && /\$PB -c "Delete :\$key" "\$PLIST"/.test(BUILD)],
    ['build-app.sh header: no longer says "no login-item registration"', () =>
        !BUILD.includes('no login-item registration') && BUILD.includes('Launch at login')],

    // 8. Every bundled component against THIRD_PARTY_NOTICES (SAA-198 step 7)
    ['notices: every binary build-app.sh installs has an entry, apart from Clipwise\'s own four', () => {
        const OWN = new Set(['systemtap', 'miccap', 'audiodevs', 'micwatch']);
        const ENTRY = {
            diarize: 'Speaker separation\n---',
            parakeet: 'The transcription engine that runs this model is built with the FluidAudio SDK,',
            aec: 'Echo cancellation\n---',
            ffmpeg: 'Clipwise converts each recorded track to 16 kHz with FFmpeg 9.0.2',
        };
        const names = [...BUILD.matchAll(/install -m 755 "\$\w+"\s+"\$C\/Resources\/bin\/([\w-]+)"/g)].map(m => m[1]);
        const unlisted = names.filter(n => !OWN.has(n) && !(ENTRY[n] && NOTICES.includes(ENTRY[n])));
        return names.length === 8 && unlisted.length === 0; }],
    ['notices: both model sets have an entry (speaker separation, Parakeet)', () =>
        /cp -R "\$DIARIZE_MODELS_DIR" "\$C\/Resources\/models\/diarize/.test(BUILD) && NOTICES.includes('Clipwise bundles these files, which are modified Core ML conversions:')
        && /cp -R "\$PARAKEET_MODELS_DIR" "\$C\/Resources\/models\/parakeet/.test(BUILD) && NOTICES.includes('NVIDIA Parakeet TDT 0.6B v2')],
    ['notices: Python has an entry: the release, the asset\'s SHA-256, and CPython\'s licence with its incorporated-software acknowledgements', () =>
        NOTICES.includes('Python\n-----------------------------')
        && NOTICES.includes('Python 3.14.7 from python-build-standalone, release\n20260924')
        && NOTICES.includes('f0fb6b233971672dd7add4efa90f8c209a63253e457ffabd0148b9f734638319')
        && NOTICES.includes('PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2')
        && NOTICES.includes('Licenses and Acknowledgements for Incorporated Software')],
    ['notices: each library PYTHON.json lists for the bundled Python has its licence text', () =>
        ['bzip2 (LICENSE.bzip2.txt):', 'OpenSSL (OpenSSL 3 licence) (LICENSE.openssl-3.txt):', 'OpenSSL (OpenSSL 1.1 licence, as python-build-standalone lists it) (LICENSE.openssl-1.1.txt):',
         'expat (LICENSE.expat.txt):', 'libffi (LICENSE.libffi.txt):', 'liblzma (xz) (LICENSE.liblzma.txt):', 'mpdecimal (LICENSE.mpdecimal.txt):',
         'SQLite (LICENSE.sqlite.txt):', 'libuuid (LICENSE.libuuid.txt):', 'zstd 1.5.7 (LICENSE from https://github.com/python/cpython-source-deps, tag']
            .every(h => NOTICES.split(h).length - 1 === 1)
        && NOTICES.includes('BSD License\n\n    For Zstandard software')],
    ['notices: what the notices say is removed from Python, build-app.sh removes before signing', () => {
        const rm = BUILD.indexOf('rm -rf "$PY/lib/python3.14/site-packages/pip"');
        const sign = BUILD.indexOf('# --- 4. sign');
        return rm > 0 && sign > rm
            && ['"$PY/lib/python3.14/ensurepip"', '"$PY/lib/libtcl9.0.dylib"', '"$PY/lib/libtcl9tk9.0.dylib"', '"$PY/lib/tcl9"', '"$PY/lib/tcl9.0"',
                '"$PY/lib/tk9.0"', '"$PY/lib/itcl4.3.8"', '"$PY/lib/thread3.0.6"', '_tkinter.cpython-314-darwin.so'].every(p => BUILD.includes(p))
            && NOTICES.includes('pip, ensurepip and Tcl/Tk are removed from the copy Clipwise carries.'); }],
    ['notices: Electron\'s LICENSE and LICENSES.chromium.html ship beside the notices, which name them', () =>
        BUILD.includes('cp "$ELECTRON_DIST/LICENSE" "$C/Resources/LICENSE.electron"')
        && BUILD.includes('cp "$ELECTRON_DIST/LICENSES.chromium.html" "$C/Resources/LICENSES.chromium.html"')
        && NOTICES.includes('LICENSE.electron') && NOTICES.includes('LICENSES.chromium.html')],
    ['notices: every framework Electron bundles is covered: Squirrel.Mac by LICENSES.chromium.html, Mantle and ReactiveObjC by their own entries', () => {
        const fw = (() => { try { return fs.readdirSync(path.join(__dirname, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Frameworks')); } catch { return []; } })();
        const chromium = (() => { try { return fs.readFileSync(path.join(__dirname, 'node_modules', 'electron', 'dist', 'LICENSES.chromium.html'), 'utf8'); } catch { return ''; } })();
        const covered = (f) =>
            /^Electron (Framework\.framework|Helper)/.test(f) ? NOTICES.includes('LICENSES.chromium.html')
            : f === 'Squirrel.framework' ? chromium.includes('<span class="title">Squirrel</span>') && NOTICES.includes('Squirrel.Mac')
            : f === 'Mantle.framework' ? NOTICES.includes('Mantle (https://github.com/Mantle/Mantle, commit 2a8e2123a3931038179ee06105c9e6ec336b12ea):')
            : f === 'ReactiveObjC.framework' ? NOTICES.includes('ReactiveObjC (https://github.com/ReactiveCocoa/ReactiveObjC, commit 74ab5baccc6f7202c8ac69a8d1e152c29dc1ea76):')
            : false;
        return fw.length >= 4 && fw.every(covered); }],
    ['notices: ffmpeg\'s entry gives the upstream source and its SHA-256, says a copy is available beside the app, and ends with the full LGPL 2.1', () =>
        NOTICES.includes('Source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz')
        && NOTICES.includes('SHA-256: 8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e')
        && NOTICES.includes('A copy of that exact source tarball is available from the same place as the\nClipwise app.')
        && NOTICES.includes('GNU LESSER GENERAL PUBLIC LICENSE') && NOTICES.includes('Version 2.1, February 1999')],
    ['notices: notarize.sh puts the verified ffmpeg source tarball beside the .dmg (build.sh --source)', () =>
        NOTARIZE.includes('FFMPEG_SOURCE="$("$APP_SRC/../ffmpeg/build.sh" --source)"')
        && NOTARIZE.includes('cp "$FFMPEG_SOURCE" "$OUT_DIR/$(basename "$FFMPEG_SOURCE")"')
        && /if \[ "\$\{1:-\}" = "--source" \]; then[\s\S]{0,300}fetch_source/.test(FFMPEG_BUILD)
        && /shasum -a 256 -c -/.test(FFMPEG_BUILD)],
    ['README: an install section says Apple silicon and macOS 14.2, and ffmpeg on PATH is for a checkout only', () =>
        README.includes('## Installing the app\n\nClipwise needs an Apple silicon Mac with macOS 14.2 or later. It doesn\'t open on an Intel Mac.')
        && README.includes('`brew install ffmpeg`, for running from a checkout only.')
        && !README.includes('`brew install ffmpeg`. Not optional')],
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
