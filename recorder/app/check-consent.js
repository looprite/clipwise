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
//      the recording time; launch at login, the move offer, where the app runs
//      from, and the quit warning; and static checks
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
// The page: its markup and its script (setup-page.js since SAA-243's CSP moved
// it out), read as one text as it was before.
const HTML = [readOr('setup.html'), readOr('setup-page.js')].join('\n');
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
// The same for team-notice.js (Gate 1, item 2).
let teamNotice = null;
try { teamNotice = require('./team-notice.js'); } catch {}
// The same for tray-menu.js (SAA-281): without it the menu cases fail one by one.
let trayMenu = null;
try { trayMenu = require('./tray-menu.js'); } catch {}
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
// The running build, for the move offer's installed-copy cases.
const RUNNING = { commit: 'bbbbbbb', built_at: '2026-10-27T10:00:00Z' };
const offerWith = (installed) => setup.shouldOfferMove({ bundled: true, inApplications: false, running: RUNNING, installed });
// One phase's { message, detail } as written in confirmQuit's text table, or null.
const quitText = (phase) => {
    const m = new RegExp(`\\n\\s*${phase}: +\\{ message: (['"])(.*?)\\1,\\s*detail: (['"])(.*?)\\3 \\}`).exec(fnBody('confirmQuit'));
    return m ? { message: m[2], detail: m[4] } : null;
};
const noteAt = (o) => setup.locationWarning({ bundled: true, inApplications: false, appPath: '/Users/jd/code/x/Clipwise.app', home: '/Users/jd', ...o });
// A menu item that quits without asking: Electron's quit role, or the app menu role that contains it.
const QUIT_ROLE = /role: '(quit|appMenu)'/;
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

// The approved text of notice v1 (SAA-216), as it stood in setup.html before it
// moved to notice/recording-notice-v1.txt, entities written as the characters.
const APPROVED_NOTICE = {
    title: 'Before you record',
    paragraphs: [
        'Clipwise records calls on this Mac without joining them. No bot appears in the meeting, so nobody else on the call can see that it is recording.',
        'You are responsible for telling the people you record, and for following the laws and workplace rules that apply to you. In many places everyone on a call has to agree to be recorded.',
        'When you start recording, Clipwise shows a short line you can say to let everyone know. On calls with a chat, “Copy recording notice” in the menu bar copies it for you.',
    ],
};

// Notice v2 (Gate 1, SAA-280): its title, its headings in order, its two lists,
// and how many paragraphs it has. The words are the file's; these pin its shape.
// The 26 is a hand count of the file's layout (2, 3, 3, 4, 3, 3, 3, 2, 3 across
// the nine sections), not taken from readNotice's output.
const APPROVED_NOTICE_V2 = {
    title: 'Before you record',
    headings: [
        'What Clipwise does',
        'Telling the people on your calls',
        'What stays on your Mac',
        'What goes to the team server, and who can see it',
        'Voices',
        'When someone else speaks into your mic',
        'Who else processes your calls',
        'Deleting a call',
        'Signing out, being removed, and a lost Mac',
    ],
    lists: [
        [
            'Anthropic: the server sends each transcript to Claude to pull out the moments.',
            'Voyage: the server sends each moment’s title and summary, and the words of your searches, so moments can be found.',
        ],
        [
            'your own Mac backups, until they roll over;',
            'the server’s database backups, for up to 14 days;',
            'anything Anthropic or Voyage keeps under their terms;',
            'any transcript you saved or exported yourself, and Clipwise’s own logs on your Mac.',
        ],
    ],
    paragraphs: 26,
};

// The short v2 text the acknowledgement window shows (Gate 1, SAA-280), as Jon
// approved it: the title and four paragraphs, no headings.
const APPROVED_NOTICE_V2_ACK = {
    title: 'Before you record',
    paragraphs: [
        'Clipwise records your calls on your Mac. No bot joins the meeting.',
        'It records two tracks: your microphone, and the sound the call plays through your Mac. Your Mac turns the audio into a transcript. After each call, use the Clipwise connector in Claude to ask for decisions, commitments and questions.',
        'You are responsible for telling the people on your calls that you are recording. Some locations require everyone on the call to agree before you record. Follow the law where you and they are.',
        'When you start recording, Clipwise shows a short line you can say to let everyone know. On calls with a chat, “Copy recording notice” in the menu bar copies it for you.',
    ],
};
const SETUP_PAGE = readOr('setup-page.js');

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
    // The notice's text (Gate 1, the member notice): one copy in the repo per
    // version, notice/recording-notice-v<N>.txt, read by consent.js for
    // STATEMENT_VERSION. The page draws what main.js sends; none of it is in the
    // page itself.
    ['notice: the repo copy for the current version exists (notice/recording-notice-v<N>.txt)', () =>
        fs.existsSync(path.join(__dirname, 'notice', `recording-notice-v${consent.STATEMENT_VERSION}.txt`))],
    ['notice: consent.readNotice gives v1 exactly as approved: the title, then three paragraphs and nothing else (control)', () => {
        const n = consent.readNotice(1);
        return n.version === 1 && n.title === APPROVED_NOTICE.title
            && JSON.stringify(n.blocks) === JSON.stringify(APPROVED_NOTICE.paragraphs.map((text) => ({ tag: 'p', text })))
            && JSON.stringify(n.paragraphs) === JSON.stringify(APPROVED_NOTICE.paragraphs); }],
    // Notice v2 (Gate 1, SAA-280): the current version, its text, and that an
    // answer given to v1 alone no longer counts.
    ['notice v2: the current version is 2', () => consent.STATEMENT_VERSION === 2],
    ['notice v2: readNotice() for the current version gives the v2 title, its nine headings in order, its two lists and its 26 paragraphs', () => {
        const n = consent.readNotice();
        const of = (tag) => n.blocks.filter((b) => b.tag === tag);
        return n.version === 2 && n.title === APPROVED_NOTICE_V2.title
            && JSON.stringify(of('h2').map((b) => b.text)) === JSON.stringify(APPROVED_NOTICE_V2.headings)
            && JSON.stringify(of('ul').map((b) => b.items)) === JSON.stringify(APPROVED_NOTICE_V2.lists)
            && of('p').length === APPROVED_NOTICE_V2.paragraphs
            && n.blocks[0].tag === 'h2' && n.blocks[0].text === APPROVED_NOTICE_V2.headings[0]; }],
    ['notice v2: every block is one the page draws (h2, ul, p), it can be agreed to, and no markup, straight quote or leftover "## "/"- " is in its text', () => {
        const n = consent.readNotice();
        const texts = [n.title, ...n.blocks.flatMap((b) => (b.tag === 'ul' ? b.items : [b.text]))];
        return n.version === 2 && consent.noticeAgreeable(n)
            && n.blocks.every((b) => ['h2', 'ul', 'p'].includes(b.tag))
            && texts.every((t) => typeof t === 'string' && t.length > 0 && !/['"<>]/.test(t) && !/^(## |- )/.test(t)); }],
    // Instructions live in the setup guide, not the full notice (SAA-280, 2026-11-10).
    ['notice v2: the full notice holds no setup instructions: none of "System Settings", "Change attendees", "Only keep voice prints"', () => {
        const n = consent.readNotice(2);
        const text = [n.title, ...n.blocks.flatMap((b) => (b.tag === 'ul' ? b.items : [b.text]))].join('\n');
        return n.version === 2 && n.blocks.length > 0
            && ['System Settings', 'Change attendees', 'Only keep voice prints'].every((s) => !text.includes(s)); }],
    ['notice v2: the v1 file is still in the repo, unchanged (v1 control above), beside the v2 file', () =>
        fs.existsSync(path.join(__dirname, 'notice', 'recording-notice-v1.txt'))
        && fs.existsSync(path.join(__dirname, 'notice', 'recording-notice-v2.txt'))],
    ['notice v2: someone who accepted only v1 is asked again: not agreed to, no stamp, no report, and the tray offers the notice', () => withDir(d => {
        put(d, good(1));
        return !isAcknowledged(d) && consent.noticeStamp(d) === null && consent.noticeReport(d) === null
            && setup.trayAccountItems({ ...ALL_DONE, acknowledged: consent.isAcknowledged(d), setupCompleted: true }).includes('recording-notice'); })],
    ['notice v2: agreeing over a v1 answer records version 2 with the new time', () => withDir(d => {
        put(d, good(1));
        consent.recordAcknowledgement(d, new Date('2026-11-09T12:00:00Z'));
        const doc = consent.readConsent(d);
        return doc.version === 2 && doc.acknowledged_at === '2026-11-09T12:00:00.000Z'
            && JSON.stringify(consent.noticeReport(d)) === JSON.stringify({ version: 2, acknowledgedAt: '2026-11-09T12:00:00.000Z' }); })],
    ['notice v2: the admin window heading for this build reads "Current notice: version 2"', () =>
        teamNotice && teamNotice.formatTeamNotice([], consent.STATEMENT_VERSION).heading === 'Current notice: version 2'],
    // The short acknowledgement and the full notice, one version (Gate 1, SAA-280).
    ['notice ack: readNotice(2, NOTICE_DIR, \'ack\') gives the approved title and exactly the four approved paragraphs, with no headings or lists', () => {
        const n = consent.readNotice(2, consent.NOTICE_DIR, 'ack');
        return n.version === 2 && n.kind === 'ack' && n.title === APPROVED_NOTICE_V2_ACK.title
            && JSON.stringify(n.blocks) === JSON.stringify(APPROVED_NOTICE_V2_ACK.paragraphs.map((text) => ({ tag: 'p', text }))); }],
    ['notice ack: the short text is not the full one (control: the full v2 has nine headings)', () =>
        consent.readNotice(2, consent.NOTICE_DIR, 'ack').blocks.length === 4
        && consent.readNotice(2, consent.NOTICE_DIR, 'full').blocks.filter((b) => b.tag === 'h2').length === 9],
    ['notice ack: a version with no -ack file throws for kind \'ack\' (v1 has none), never falling back to the full text', () => {
        try { consent.readNotice(1, consent.NOTICE_DIR, 'ack'); return false; } catch { return true; } }],
    ['notice ack: noticeForPage gives the full text for "reread" and the short text for every other mode', () =>
        /function noticeForPage\(mode\) \{\s*const kind = mode === 'reread' \? 'full' : 'ack';/.test(SRC)],
    ['notice ack: the acknowledge guard checks the text the window showed (the short one), noticeForPage(setupWindow.mode), the same call setupView draws with, before anything is saved', () => {
        const a = SRC.indexOf("ipcMain.on('setup:acknowledge'");
        const b = SRC.indexOf("ipcMain.on('setup:later'", a);
        const handler = a >= 0 && b > a ? SRC.slice(a, b) : '';
        const guard = handler.indexOf('if (!consent.noticeAgreeable(noticeForPage(setupWindow.mode)))');
        const saved = handler.indexOf('consent.recordAcknowledgement(SUPPORT_DIR)');
        const reported = handler.indexOf("reportNoticeToServer('acknowledged')");
        return guard >= 0 && saved > guard && reported > guard
            && /notice: noticeForPage\(w\.mode\),/.test(fnBody('setupView')); }],
    ['notice ack: "Read the full notice" is offered on the acknowledgement only: setupView sends the full text there and never on a reread', () =>
        fnBody('setupView').includes("fullNotice: screen === 'notice' && w.mode !== 'reread' ? noticeForPage('reread') : null,")
        && readOr('setup.html').includes('<a id="notice-full-link">Read the full notice</a>')
        && SETUP_PAGE.includes("const fullOffered = v.screen === 'notice' && !v.rereading && !!(v.fullNotice && v.fullNotice.title);")],
    ['notice ack: opening the full text from the link, and Back, record nothing: neither sends anything, and the window has no new channel', () => {
        const link = /\$\('notice-full-link'\)\.addEventListener\('click', \(\) => \{([^}]*)\}\);/.exec(SETUP_PAGE);
        const back = /if \(view\.screen === 'notice' && showingFull\) \{([^}]*)\}/.exec(SETUP_PAGE);
        const pre = readOr('setup-preload.js');
        return !!link && !/send\(|ipcRenderer/.test(link[1]) && /showingFull = true; draw\(view\);/.test(link[1])
            && !!back && !/send\(|ipcRenderer/.test(back[1]) && /showingFull = false; draw\(view\); return;/.test(back[1])
            // Back is handled before the primary button's sends, and the full view shows Back, not "I understand".
            && SETUP_PAGE.indexOf("if (view.screen === 'notice' && showingFull)") < SETUP_PAGE.indexOf("send('setup:acknowledge')")
            && /if \(v\.screen === 'notice' && showingFull\) \{[\s\S]{0,200}primary\.textContent = 'Back';/.test(SETUP_PAGE)
            && /const SEND = \['setup:ready', 'setup:acknowledge', 'setup:later', 'setup:address', 'setup:change-address',\s*'setup:signin', 'setup:permission-request', 'setup:permission-settings', 'setup:filevault-settings',\s*'setup:done', 'setup:copy-claude-address'\];/.test(pre); }],
    ['notice ack: build-app.sh bundles the whole notice folder, so the -ack file ships with the full one', () =>
        BUILD.includes('cp -R "$APP_SRC/notice" "$C/Resources/app/notice"')
        && fs.existsSync(path.join(__dirname, 'notice', 'recording-notice-v2-ack.txt'))],
    ['notice: a heading, a two-item list and a paragraph read in order as h2, ul with both items, p', () => withDir(d => {
        fs.writeFileSync(path.join(d, 'recording-notice-v8.txt'),
            'The title\n\n## What is stored\n- Your microphone\n- The sound your Mac plays\n\nA closing paragraph\nthat runs over two lines.\n');
        const n = consent.readNotice(8, d);
        return n.title === 'The title' && JSON.stringify(n.blocks) === JSON.stringify([
            { tag: 'h2', text: 'What is stored' },
            { tag: 'ul', items: ['Your microphone', 'The sound your Mac plays'] },
            { tag: 'p', text: 'A closing paragraph that runs over two lines.' },
        ]); })],
    ['notice: a blank line ends a list; the next bullets start a second list', () => withDir(d => {
        fs.writeFileSync(path.join(d, 'recording-notice-v9.txt'), 'T\n\n- a\n- b\n\n- c\n');
        const n = consent.readNotice(9, d);
        return JSON.stringify(n.blocks) === JSON.stringify([{ tag: 'ul', items: ['a', 'b'] }, { tag: 'ul', items: ['c'] }]); })],
    ['notice: markup in the file stays text (the page never parses it)', () => withDir(d => {
        fs.writeFileSync(path.join(d, 'recording-notice-v10.txt'), 'T\n\n<b>bold</b> & more\n');
        const n = consent.readNotice(10, d);
        return n.blocks.length === 1 && n.blocks[0].tag === 'p' && n.blocks[0].text === '<b>bold</b> & more'; })],
    ['notice: the page draws h2, ul with li, and p from the blocks, by textContent, and no other tag', () => {
        const page = readOr('setup-page.js');
        return /NOTICE_TAGS = new Set\(\['h2', 'ul', 'p'\]\)/.test(page)
            && /createElement\('li'\)/.test(page) && /li\.textContent = /.test(page)
            && /el\.textContent = b\.text/.test(page) && /if \(!NOTICE_TAGS\.has\(b\.tag\)\) continue;/.test(page)
            && !/innerHTML|insertAdjacentHTML|outerHTML/.test(page); }],
    ['notice: readNotice of a version with no file throws, never an empty notice', () => {
        try { consent.readNotice(consent.STATEMENT_VERSION + 1000); return false; } catch { return true; } }],
    ['notice: a notice file is read for the version it is asked for (a later version is its own file)', () => withDir(d => {
        fs.writeFileSync(path.join(d, 'recording-notice-v7.txt'), 'A title\n\nFirst.\n\nSecond, with a “quote”.\n');
        const n = consent.readNotice(7, d);
        return n.version === 7 && n.title === 'A title'
            && JSON.stringify(n.blocks) === JSON.stringify([{ tag: 'p', text: 'First.' }, { tag: 'p', text: 'Second, with a “quote”.' }]); })],
    ['notice: setup.html holds none of the notice text; the page draws it from v.notice as text', () =>
        !HTML.includes('Clipwise records calls on this Mac without joining them')
        && !HTML.includes('You are responsible for telling the people you record')
        && !/<h1>Before you record<\/h1>/.test(HTML)
        && /v\.notice/.test(readOr('setup-page.js')) && /textContent = /.test(readOr('setup-page.js'))
        && !/innerHTML/.test(readOr('setup-page.js'))],
    ['notice: setupView sends the notice through noticeForPage, which reads it with consent.readNotice and turns a failure into null', () => {
        const body = fnBody('noticeForPage');
        return /notice: noticeForPage\(w\.mode\)/.test(fnBody('setupView'))
            && /try \{[\s\S]*consent\.readNotice\(consent\.STATEMENT_VERSION, consent\.NOTICE_DIR, kind\)[\s\S]*\} catch/.test(body) && /return null;/.test(body); }],
    // A notice that is missing or empty can't be agreed to.
    ['notice not loaded: consent.noticeAgreeable is false for null, no blocks, an empty list of blocks, or no title', () =>
        !consent.noticeAgreeable(null) && !consent.noticeAgreeable({ title: 'T' })
        && !consent.noticeAgreeable({ title: 'T', blocks: [] }) && !consent.noticeAgreeable({ title: '', blocks: [{ tag: 'p', text: 'x' }] })],
    ['notice not loaded: the page disables "I understand" and shows one line, "The notice couldn\'t be loaded"', () => {
        const page = readOr('setup-page.js');
        return /const agreeable = !!\(v\.notice && v\.notice\.title && Array\.isArray\(v\.notice\.blocks\) && v\.notice\.blocks\.length > 0\);/.test(page)
            && /primary\.disabled = !!v\.busy \|\| \(v\.screen === 'notice' && !agreeable && !v\.rereading\);/.test(page)
            && /\$\('notice-error'\)\.textContent = agreeable \? '' : "The notice couldn't be loaded";/.test(page)
            && HTML.includes('id="notice-error"'); }],
    ['notice not loaded: main.js records no acknowledgement for it, whatever the page sends', () => {
        const a = SRC.indexOf("ipcMain.on('setup:acknowledge'");
        const b = SRC.indexOf("ipcMain.on('setup:later'", a);
        const handler = a >= 0 && b > a ? SRC.slice(a, b) : '';
        const guard = handler.indexOf('if (!consent.noticeAgreeable(noticeForPage(setupWindow.mode)))');
        const saved = handler.indexOf('consent.recordAcknowledgement(SUPPORT_DIR)');
        return guard >= 0 && saved > guard; }],
    ['control: the loaded notice is agreeable, so the button stays enabled', () => consent.noticeAgreeable(consent.readNotice())],
    ['notice: "Not now" is still the window\'s second button', () => HTML.includes('Not now')],
    ['build-app.sh copies the notice directory into the bundle', () =>
        /cp -R "\$APP_SRC\/notice" "\$C\/Resources\/app\/notice"/.test(BUILD)],

    // Reading it again once agreed (Gate 1's setup-guide note).
    ['reread: the button is "Close" when the notice is reread', () => consent.buttonLabel('reread') === 'Close'],
    ['reread: the tray offers "Read the recording notice…" once setup is finished and the notice agreed to', () =>
        setup.trayAccountItems({ ...ALL_DONE, setupCompleted: true }).includes('read-notice')],
    ['reread: not offered while the notice is not agreed to (the "Recording notice…" item asks instead), nor before setup is finished', () =>
        !setup.trayAccountItems({ ...ALL_DONE, acknowledged: false, setupCompleted: true }).includes('read-notice')
        && setup.trayAccountItems({ ...ALL_DONE, acknowledged: false, setupCompleted: true }).includes('recording-notice')
        && !setup.trayAccountItems({ ...ALL_DONE, setupCompleted: false }).includes('read-notice')],
    ['reread: main.js draws the tray item and opens the window as "reread"', () =>
        /item === 'read-notice'\) \{\s*items\.push\(\{ label: 'Read the recording notice…', click: \(\) => showSetupWindow\('reread'\) \}\);/.test(SRC)],
    ['reread: an agreed install opens the notice window only when it is asked to reread it', () =>
        /if \(noticeOnly && mode !== 'reread' && consent\.isAcknowledged\(SUPPORT_DIR\)\) return;/.test(fnBody('showSetupWindow'))],
    ['reread: the page hides "Not now", and its button closes the window without sending an acknowledgement', () => {
        const page = readOr('setup-page.js');
        return /rereading/.test(fnBody('setupView')) && /v\.rereading/.test(page)
            && /view\.rereading\) send\('setup:later'\)/.test(page); }],

    // The acknowledgement reaches the server at once (POST /captures/notice);
    // the capture's notice stamp stays the fallback.
    ['report: consent.noticeReport is null when the notice is not agreed to', () => withDir(d => consent.noticeReport(d) === null)],
    ['report: consent.noticeReport is the version and acknowledged_at as the route takes them, nothing else', () => withDir(d => {
        put(d, JSON.stringify({ version: consent.STATEMENT_VERSION, acknowledged_at: '2026-10-07T20:00:00.000Z', extra: 'x' }));
        return JSON.stringify(consent.noticeReport(d)) === JSON.stringify({ version: consent.STATEMENT_VERSION, acknowledgedAt: '2026-10-07T20:00:00.000Z' }); })],
    ['report: reportNoticeToServer posts consent.noticeReport to /captures/notice, only when signed in', () => {
        const body = fnBody('reportNoticeToServer');
        return /const server = signedInServer\(\);/.test(body) && /consent\.noticeReport\(SUPPORT_DIR\)/.test(body)
            && /captureServerRequest\(server, 'POST', '\/captures\/notice', report\)/.test(body); }],
    ['report: "I understand" reports it, after the answer is saved', () => {
        const a = SRC.indexOf("ipcMain.on('setup:acknowledge'");
        const b = SRC.indexOf("ipcMain.on('setup:later'", a);
        const handler = a >= 0 && b > a ? SRC.slice(a, b) : '';
        const saved = handler.indexOf('consent.recordAcknowledgement(SUPPORT_DIR)');
        const report = handler.indexOf("reportNoticeToServer('acknowledged')");
        return saved >= 0 && report > saved; }],
    ['report: signing in reports it (the notice is agreed to before sign-in in setup)', () => {
        const signed = SRC.indexOf('sign-in: signed in to ${server}');
        const report = SRC.indexOf("reportNoticeToServer('signed in')", signed);
        return signed >= 0 && report > signed && report - signed < 400; }],
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
        !!trayMenu && trayMenu.trayMenuOrder({ active: true }).includes('copy-notice') && !trayMenu.trayMenuOrder({ active: false }).includes('copy-notice')
        // renderTray's own `active` (state !== 'stopped') is what the order is given.
        && /const active = state !== 'stopped';/.test(fnBody('renderTray'))
        && /trayMenu\.trayMenuOrder\(\{[\s\S]*?\n        active,\n[\s\S]*?\}\);/.test(fnBody('renderTray'))
        && /item === 'copy-notice'\) \{[\s\S]{0,200}items\.push\(\{ label: 'Copy recording notice', click: copyRecordingNotice \}\);/.test(fnBody('renderTray'))],
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
        && /if \(noticeOnly && mode !== 'reread' && consent\.isAcknowledged\(SUPPORT_DIR\)\) return;/.test(fnBody('showSetupWindow'))],
    ['build-app.sh copies consent.js into the bundle', () => /cp "\$APP_SRC\/consent\.js" "\$C\/Resources\/app\/consent\.js"/.test(BUILD)],
    ['build-app.sh copies setup.js, setup.html, its script setup-page.js and its preload setup-preload.js into the bundle', () =>
        /cp "\$APP_SRC\/setup\.js" "\$C\/Resources\/app\/setup\.js"/.test(BUILD)
        && /cp "\$APP_SRC\/setup\.html" "\$C\/Resources\/app\/setup\.html"/.test(BUILD)
        && /cp "\$APP_SRC\/setup-page\.js" "\$C\/Resources\/app\/setup-page\.js"/.test(BUILD)
        && /cp "\$APP_SRC\/setup-preload\.js" "\$C\/Resources\/app\/setup-preload\.js"/.test(BUILD)],

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
    // The builder lives in capture-payload.js since SAA-260 step 3; before that,
    // in main.js.
    ['builder: the capture body sends the manifest\'s stamp as notice', () => {
        const payloadPath = path.join(__dirname, 'capture-payload.js');
        const builder = fs.existsSync(payloadPath) ? fs.readFileSync(payloadPath, 'utf8') : SRC;
        return /notice: manifest\.notice\s*\?\s*\{ version: manifest\.notice\.version, acknowledgedAt: manifest\.notice\.acknowledged_at \}/.test(builder); }],

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
    // Since Gate 1's reread item, an agreed install also offers "Read the recording notice…" first.
    ['tray: setup finished, then signed out -> "Sign in to Clipwise", not "Finish setting up"', () =>
        JSON.stringify(setup.trayAccountItems({ setupCompleted: true, acknowledged: true, server: 'https://t.example.com', signedIn: false })) === JSON.stringify(['read-notice', 'sign-in'])],
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
    ['build-app.sh copies capture-sign-in.js into the bundle (main.js requires it)', () =>
        /cp "\$APP_SRC\/capture-sign-in\.js" "\$C\/Resources\/app\/capture-sign-in\.js"/.test(BUILD)
        && SRC.includes("require('./capture-sign-in.js')")],
    ['build-app.sh copies detect-answer.js into the bundle (main.js requires it)', () =>
        /cp "\$APP_SRC\/detect-answer\.js" "\$C\/Resources\/app\/detect-answer\.js"/.test(BUILD)
        && SRC.includes("require('./detect-answer.js')")],
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
    ['move: an older installed app keeps the offer (a newer .dmg is the update path)', () =>
        offerWith({ commit: 'aaaaaaa', built_at: '2026-10-13T09:00:00Z' }) === true],
    ['move: an installed app of the same commit skips the offer', () =>
        offerWith({ commit: RUNNING.commit, built_at: '2026-10-13T09:00:00Z' }) === false],
    ['move: a newer installed app skips the offer', () =>
        offerWith({ commit: 'ccccccc', built_at: '2026-10-28T09:00:00Z' }) === false],
    ['move: an installed app with no readable build-info, or no usable built_at, keeps the offer', () =>
        offerWith(null) === true && offerWith({ commit: 'ccccccc', built_at: 'garbled' }) === true],
    ['move: the installed build-info is read from /Applications/Clipwise.app/Contents/Resources/app/build-info.json, only off the Applications path, and passed with this build\'s', () => {
        const body = fnBody('offerMoveToApplications');
        const gate = body.indexOf('if (!bundled || inApplications) return false;');
        const read = body.indexOf('readInstalledBuildInfo()');
        return SRC.includes("const INSTALLED_APP = '/Applications/Clipwise.app';")
            && fnBody('readInstalledBuildInfo').includes("path.join(INSTALLED_APP, 'Contents', 'Resources', 'app', 'build-info.json')")
            && gate >= 0 && read > gate
            && body.includes('setup.shouldOfferMove({ bundled, inApplications, running: BUILD_INFO, installed })'); }],
    ['location: no note in Applications or from a checkout; outside Applications, one naming the path', () => {
        const out = noteAt({});
        return noteAt({ inApplications: true }) === null && noteAt({ bundled: false }) === null
            && out.tray === 'Not the installed app: running from ~/code/x/Clipwise.app'
            && out.body.startsWith('~/code/x/Clipwise.app\n'); }],
    ['location: a path outside home, or one that only shares its prefix, is shown whole', () =>
        noteAt({ appPath: '/Volumes/Clipwise/Clipwise.app' }).tray.endsWith(' /Volumes/Clipwise/Clipwise.app')
        && noteAt({ appPath: '/Users/jdx/Clipwise.app' }).tray.endsWith(' /Users/jdx/Clipwise.app')],
    ['location: the launch line names the app\'s path, from process.execPath', () =>
        SRC.includes("const APP_BUNDLE_PATH = path.resolve(process.execPath, '..', '..', '..');")
        && /launched from bundle[\s\S]{0,200}`app \$\{APP_BUNDLE_PATH\}`/.test(SRC)],
    ['location: set at launch after the move offer and before the tray, from app.isInApplicationsFolder(); notified; the tray line sits under Status', () => {
        const m = whenReadyBody.indexOf('if (await offerMoveToApplications()) return;');
        const l = whenReadyBody.indexOf('locationNote = setup.locationWarning({');
        const t = whenReadyBody.indexOf('tray = new Tray(');
        return m >= 0 && l > m && t > l
            && /locationNote = setup\.locationWarning\(\{\s*bundled: !!BUILD_INFO, inApplications: app\.isInApplicationsFolder\(\),/.test(whenReadyBody)
            && whenReadyBody.includes("if (locationNote) notify('not-in-applications', locationNote.title, locationNote.body);")
            && !!trayMenu && JSON.stringify(trayMenu.trayMenuOrder({ 'location-note': true }).slice(0, 2)) === JSON.stringify(['status', 'location-note'])
            && fnBody('renderTray').includes("'location-note': !!locationNote,")
            && /item === 'location-note'\) \{\s*items\.push\(\{ label: locationNote\.tray, enabled: false \}\);/.test(fnBody('renderTray')); }],
    ['location: can it update itself here: in Applications and writable yes; translocated, outside Applications or not writable no; a checkout is not asked (SAA-253 decision 6)', () =>
        setup.updateBlocker({ bundled: true, inApplications: true, appPath: '/Applications/Clipwise.app', parentWritable: true }) === null
        && setup.updateBlocker({ bundled: true, inApplications: true, appPath: '/private/var/folders/x/T/AppTranslocation/ABC/d/Clipwise.app', parentWritable: true }) === 'translocated'
        && setup.updateBlocker({ bundled: true, inApplications: false, appPath: '/Users/jd/Downloads/Clipwise.app', parentWritable: true }) === 'outside-applications'
        && setup.updateBlocker({ bundled: true, inApplications: true, appPath: '/Applications/Clipwise.app', parentWritable: false }) === 'not-writable'
        && setup.updateBlocker({ bundled: false, inApplications: false, appPath: '/x/Electron.app', parentWritable: false }) === null],
    ['location: outside Applications or translocated, the notification says it can\'t update itself there; the tray line is unchanged', () => {
        const out = noteAt({});
        const tl = noteAt({ inApplications: true, appPath: '/private/var/folders/x/T/AppTranslocation/ABC/d/Clipwise.app' });
        return out.body === "~/code/x/Clipwise.app\nIt keeps recording, but it may be an old build, and it can't update itself here."
            && out.tray === 'Not the installed app: running from ~/code/x/Clipwise.app'
            && !!tl && tl.body.endsWith("it can't update itself here."); }],
    ['location: in Applications but not writable by this account, a warning that it can\'t update; writable, none (the control)', () => {
        const nw = noteAt({ inApplications: true, appPath: '/Applications/Clipwise.app', parentWritable: false });
        return !!nw && nw.tray === "Can't update itself: this account can't replace /Applications/Clipwise.app"
            && nw.title === "Clipwise can't update itself"
            && nw.body === "/Applications/Clipwise.app\nIt keeps recording, but this account can't replace it, so it stays on this build."
            && noteAt({ inApplications: true, appPath: '/Applications/Clipwise.app', parentWritable: true }) === null; }],
    ['location: launch reads whether the app\'s folder is writable once, and passes the same answer to the warning and to the updater', () =>
        whenReadyBody.includes('const parentWritable = folderWritable(path.dirname(APP_BUNDLE_PATH));')
        && /locationNote = setup\.locationWarning\(\{[\s\S]{0,200}parentWritable,\s*\}\);/.test(whenReadyBody)
        && whenReadyBody.includes('startUpdates(parentWritable);')],
    ['quit: the tray\'s Quit… asks first, and only Quit or Restart (response 0) reaches quitApp', () => {
        const body = fnBody('confirmQuit');
        return SRC.includes("items.push({ label: 'Quit…', click: confirmQuit });") && !SRC.includes('click: quitApp')
            && body.includes("buttons: [install ? 'Restart' : 'Quit', 'Cancel'], defaultId: 1, cancelId: 1,")
            && body.includes('if (response === 0) quitApp({ install });'); }],
    ['quit: quitApp is called from confirmQuit (asked) and applyUpdateNow (the idle gate passed), and nowhere else (SAA-253)', () =>
        SRC.split(/\bquitApp\(/).length - 1 === 3
        && SRC.includes('\nfunction quitApp(opts = {}) {')
        && fnBody('confirmQuit').includes('quitApp({ install });')
        && fnBody('applyUpdateNow').includes('quitApp({ install: true });')],
    ['quit: asked to update, the question says Restart, and that Clipwise opens again once it has updated', () => {
        const body = fnBody('confirmQuit');
        return body.includes('const install = !!opts.install && !!updateReady;')
            && body.includes("starting: { message: 'Clipwise is about to record this call',\n                    detail: 'Restarting now stops it before anything is recorded, so nothing from this call is processed. Clipwise opens again once it has updated.' },")
            && body.includes("capture:  { message: 'Clipwise is recording this call',\n                    detail: \"Restarting stops the recording now. What's been recorded so far is still processed. Clipwise opens again once it has updated.\" },"); }],
    ['quit: three phases: stopped, starting, and capture for both recording and stalled', () =>
        fnBody('confirmQuit').includes("const phase = state === 'stopped' ? 'stopped' : state === 'starting' ? 'starting' : 'capture';")],
    ['quit: stopped says Clipwise won\'t record until opened again, with no detail', () => {
        const t = quitText('stopped');
        return !!t && t.message === "Clipwise won't record meetings until you open it again" && t.detail === ''; }],
    ['quit: starting says it is about to record, and that nothing from the call is processed', () => {
        const t = quitText('starting');
        return !!t && t.message === 'Clipwise is about to record this call'
            && t.detail === "Quitting now stops it before anything is recorded, so nothing from this call is processed. Clipwise won't record meetings until you open it again."; }],
    ['quit: recording or stalled says it is recording, and that what was recorded is still processed', () => {
        const t = quitText('capture');
        return !!t && t.message === 'Clipwise is recording this call'
            && t.detail === "Quitting stops the recording now. What's been recorded so far is still processed. Clipwise won't record meetings until you open it again."; }],
    ['quit: control: starting\'s detail has no "still processed"; the same test finds it in capture\'s', () => {
        const s = quitText('starting'), c = quitText('capture');
        return !!s && !!c && !s.detail.includes('still processed') && c.detail.includes('still processed'); }],
    ['quit: the log line adds " (while starting)" or " (during a capture)", and nothing when stopped', () => {
        const body = fnBody('confirmQuit');
        return body.includes("const during = { stopped: '', starting: ' (while starting)', capture: ' (during a capture)' }[phase];")
            && body.includes("console.error(`[clipwise-recorder] quit: ${response === 0 ? 'confirmed' : 'cancelled'}${during}${install ? ' to update' : ''}`);"); }],
    ['quit: a logout or restart is never held up: no before-quit listener (control: the same pattern finds will-quit)', () =>
        !/app\.on\('before-quit'/.test(SRC) && /app\.on\('will-quit'/.test(SRC)],
    ['quit: confirmQuit resets quitConfirmOpen in a finally around the dialog, and nowhere else', () => {
        const body = fnBody('confirmQuit');
        const t = body.indexOf('try {\n        ({ response } = await dialog.showMessageBox(');
        const f = body.indexOf('} finally {');
        return t >= 0 && f > t
            && /\} finally \{\s*(\/\/[^\n]*\n\s*)?quitConfirmOpen = false;\s*\}/.test(body)
            && body.split('quitConfirmOpen = false;').length - 1 === 1; }],
    ['quit: Cmd+Q goes through confirmQuit: the app menu\'s Quit has Command+Q and click confirmQuit, and no item has role quit or appMenu', () =>
        fnBody('installAppMenu').includes("{ label: 'Quit Clipwise…', accelerator: 'Command+Q', click: confirmQuit },")
        && !QUIT_ROLE.test(SRC)],
    ['quit: control: the role pattern finds role quit and role appMenu when they are there', () =>
        QUIT_ROLE.test("{ role: 'quit' }") && QUIT_ROLE.test("{ role: 'appMenu' }") && !QUIT_ROLE.test("{ role: 'editMenu' }")],
    ['quit: the app menu is installed at launch, after the lock and before the move offer', () => {
        const l = whenReadyBody.indexOf('if (!GOT_SINGLE_INSTANCE_LOCK) return;');
        const i = whenReadyBody.indexOf('installAppMenu();');
        const m = whenReadyBody.indexOf('if (await offerMoveToApplications()) return;');
        return l >= 0 && i > l && m > i; }],
    ['quit: the app menu keeps Edit (paste in setup) and Window', () => {
        const body = fnBody('installAppMenu');
        return body.includes("{ role: 'editMenu' },") && body.includes("{ role: 'windowMenu' },"); }],
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
    ['permissions: after either prompt closes, the setup window is brought back to the front', () => {
        const b = fnBody('requestPermission');
        const after = b.indexOf('await promptForSystemAudio()');
        const gone = b.indexOf('if (setupWindow !== w) return;', after);
        const raise = b.indexOf('w.win.show(); app.focus({ steal: true });', gone);
        return after >= 0 && gone > after && raise > gone;
    }],
    ['window: a grant that is not granted, denied or notDetermined reads "Not available" in the muted style, never "Allowed" in green', () =>
        HTML.includes("const STATE_TEXT = { granted: 'Allowed', denied: 'Off', notDetermined: 'Not yet asked' };")
        && HTML.includes("(STATE_TEXT[state] || 'Not available')")
        && HTML.includes("el.className = `state ${state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : ''}`;")],
    ['window: the sign-in screen says Google asks once for read-only calendar access (SAA-198 step 5)', () =>
        HTML.includes('Google asks once for read-only access to your calendar, so your recordings get their meeting&rsquo;s title and invitees.')],
    // The notice's title is now drawn from its file (readNotice), into notice-title.
    ['window: setup.html has the five screens and a place for the notice\'s title and text', () =>
        ['screen-notice', 'screen-address', 'screen-signin', 'screen-permissions', 'screen-claude', 'id="notice-title"', 'id="notice-text"'].every(t => HTML.includes(t))],

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
        && /if \(noticeOnly && mode !== 'reread' && consent\.isAcknowledged\(SUPPORT_DIR\)\) return;/.test(fnBody('showSetupWindow')))],
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
    ['build number: CFBundleVersion is the build\'s UTC time, not the version string; the version\'s patch is that same number (SAA-253)', () =>
        BUILD.includes('BUILD_NUMBER="$(date -u +%Y%m%d%H%M)"')
        && /set_key CFBundleVersion\s+string "\$BUILD_NUMBER"/.test(BUILD) && !/set_key CFBundleVersion\s+string "\$VERSION"/.test(BUILD)
        && BUILD.includes('VERSION="${BASE_VERSION%.*}.$BUILD_NUMBER"')
        && BUILD.split('date -u +%Y%m%d%H%M').length - 1 === 1],
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

    // 9. Auto-update (SAA-253): main.js's wiring around update-gate.js, which
    //    check-update-gate.js covers on its own.
    ['update: the feed is update.electronjs.org, looprite/clipwise, darwin-arm64, at this build\'s version', () =>
        SRC.includes("const UPDATE_FEED_BASE = 'https://update.electronjs.org/looprite/clipwise/darwin-arm64';")
        && fnBody('startUpdates').includes('const url = `${UPDATE_FEED_BASE}/${app.getVersion()}`;')
        && fnBody('startUpdates').includes('autoUpdater.setFeedURL({ url });')],
    ['update: no feed from a checkout or from anywhere it can\'t update itself, and the log says why', () => {
        const body = fnBody('startUpdates');
        const g = body.indexOf('const blocker = setup.updateBlocker({');
        const s = body.indexOf('autoUpdater.setFeedURL(');
        return g >= 0 && s > g
            && body.includes("if (!BUILD_INFO) { updateLog('not checked — not a built app'); return; }")
            && body.includes('if (blocker) { updateLog(`not checked — ${blocker}: ${APP_BUNDLE_PATH}`); return; }'); }],
    ['update: started last at launch, after the detector', () => {
        const d = whenReadyBody.indexOf('startDetector();');
        const u = whenReadyBody.indexOf('startUpdates(parentWritable);');
        return d >= 0 && u > d; }],
    ['update: every updater event goes to the day log as "update: …"', () => {
        const body = fnBody('startUpdates');
        return SRC.includes('function updateLog(msg) { console.error(`[clipwise-recorder] update: ${msg}`); }')
            && ['checking-for-update', 'update-available', 'update-not-available', 'update-downloaded', 'error', 'before-quit-for-update']
                .every((ev) => new RegExp(`autoUpdater\\.on\\('${ev}', [^\\n]*updateLog\\(`).test(body)); }],
    ['update: a check runs only while idle; one that comes due while busy is logged once and waits', () => {
        const body = fnBody('requestUpdateCheck');
        const g = body.indexOf('const g = updateIdle();');
        const c = body.indexOf('autoUpdater.checkForUpdates();');
        return g >= 0 && c > g
            && body.includes('if (!g.idle) {')
            && body.includes('updateCheckDue = true;')
            && body.includes('if (!updateCheckDue) updateLog(`check deferred (${reason}) — ${g.reason}`);'); }],
    ['update: idle is update-gate.js given every visible window, this run\'s pipeline, recovery, each pipeline record, ps, and the upload drain', () => {
        const body = fnBody('updateIdle');
        return SRC.includes("const updateGate = require('./update-gate.js');")
            && body.includes('updateGate.idleState({')
            && body.includes('anyWindowOpen: BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible()),')
            && body.includes("pipelineRunning: !!(pipeline && pipeline.state === 'running'),")
            && body.includes('recoveryRunning: !!recoveryProc,')
            && body.includes("execFileSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8' })")
            && body.includes('entries: [CAPTURE_PIPELINE_ENTRY, CAPTURE_RECOVER_ENTRY],')
            && body.includes('uploadDraining: !!uploadDraining,')
            && !body.includes('listUploadQueue'); }],
    ['update: applied only after the idle gate, in the same tick, through quitApp', () => {
        const body = fnBody('maybeApplyUpdate');
        const g = body.indexOf('const g = updateIdle();');
        const a = body.indexOf('applyUpdateNow();');
        return g >= 0 && a > g && !/await|setTimeout|setImmediate|\.then\(/.test(body); }],
    ['update: applyUpdateNow has one caller, maybeApplyUpdate, after the gate', () =>
        SRC.split(/\bapplyUpdateNow\(/).length - 1 === 2
        && SRC.includes('\nfunction applyUpdateNow() {')
        && fnBody('maybeApplyUpdate').includes('applyUpdateNow();')],
    ['update: a deferral is logged when its reason changes, and every time the tray asked', () =>
        fnBody('maybeApplyUpdate').includes("if (g.reason !== updateDeferredReason || trigger === 'tray') updateLog(`apply deferred (${trigger}) — ${g.reason}`);")],
    ['update: tried when the download lands, after every upload drain (which follows each pipeline and recovery exit), and on the minute tick', () =>
        /autoUpdater\.on\('update-downloaded',[\s\S]{0,400}maybeApplyUpdate\('update-downloaded'\)/.test(fnBody('startUpdates'))
        && /\.finally\(\(\) => \{\s*uploadDraining = null;[\s\S]{0,200}maybeApplyUpdate\('upload queue drained'\);/.test(fnBody('drainUploadQueue'))
        && fnBody('updateTick').includes("if (updateReady) { maybeApplyUpdate('minute tick'); return; }")],
    ['update: the install is in teardown\'s callback, after the pipeline is handed off; any other quit still exits', () => {
        const body = fnBody('quitApp');
        const p = body.indexOf('startPipeline(stem);');
        const i = body.indexOf('autoUpdater.quitAndInstall();');
        return p >= 0 && i > p
            && body.includes('if (opts.install && updateReady) {')
            && body.includes('app.exit(0);'); }],
    ['update: once downloaded the tray offers Restart to update; during a capture that asks first, otherwise it goes through the idle gate like any other try', () => {
        const body = fnBody('restartToUpdate');
        return fnBody('renderTray').includes('update: !!updateReady,')
            && /item === 'update'\) \{\s*items\.push\(\{ label: `Restart to update to \$\{updateReady\}`, click: restartToUpdate \}\);/.test(fnBody('renderTray'))
            && !!trayMenu && trayMenu.trayMenuOrder({ update: true }).includes('update') && !trayMenu.trayMenuOrder({}).includes('update')
            && /if \(state !== 'stopped' \|\| session\) \{ confirmQuit\(\{ install: true \}\); return; \}/.test(body)
            && body.includes("maybeApplyUpdate('tray');")
            && !body.includes('applyUpdateNow('); }],
    ['update: build-app.sh copies update-gate.js into the bundle', () =>
        BUILD.includes('cp "$APP_SRC/update-gate.js" "$C/Resources/app/update-gate.js"')],

    // 9. Who accepted the notice, for an admin (Gate 1, item 2): a tray item and a
    // small window, admins only; the role from GET /captures/me.
    ['team: the tray offers "Who accepted the notice…" to a signed-in admin', () =>
        setup.trayAccountItems({ ...ALL_DONE, setupCompleted: true, teamRole: 'admin' }).includes('team-notice')],
    ['team: not to a member, not to an admin who is signed out, and not while the role is unknown', () =>
        !setup.trayAccountItems({ ...ALL_DONE, setupCompleted: true, teamRole: 'member' }).includes('team-notice')
        && !setup.trayAccountItems({ ...ALL_DONE, setupCompleted: true, signedIn: false, teamRole: 'admin' }).includes('team-notice')
        && !setup.trayAccountItems({ ...ALL_DONE, setupCompleted: true }).includes('team-notice')],
    ['team: main.js draws the item and opens the team window', () =>
        /item === 'team-notice'\) \{\s*items\.push\(\{ label: 'Who accepted the notice…', click: openTeamNoticeWindow \}\);/.test(SRC)
        && !SRC.includes('Team: who accepted the notice')],
    ['team: the role is part of setupStatus, so the tray rule sees it', () => /teamRole,/.test(fnBody('setupStatus'))],
    ['team: the role is read from GET /captures/me, kept only as "admin" or "member", and the tray redrawn when it changes', () => {
        const body = fnBody('refreshTeamRole');
        return /captureServerRequest\(server, 'GET', '\/captures\/me'\)/.test(body)
            && /role === 'admin' \|\| role === 'member' \? role : null/.test(body) && /renderTray\(\)/.test(body); }],
    ['team: the role is read at launch and at sign-in, and forgotten at sign-out', () => {
        const signed = SRC.indexOf('sign-in: signed in to ${server}');
        return /loadCaptureTokens\(\);\s*void refreshTeamRole\('launch'\);/.test(SRC)
            && SRC.indexOf("void refreshTeamRole('signed in')", signed) > signed
            && /captureTokens = null;\s*teamRole = null;/.test(fnBody('signOutOfCaptureServer')); }],
    ['team: a 403 from the list drops the role and redraws the tray', () =>
        /reply\.status === 403\) \{[\s\S]{0,200}teamRole = 'member';[\s\S]{0,80}renderTray\(\);/.test(fnBody('sendTeamNoticeData'))],
    ['team: the window asks GET /captures/members/notice and sends the formatted lines', () => {
        const body = fnBody('sendTeamNoticeData');
        return /captureServerRequest\(server, 'GET', '\/captures\/members\/notice'\)/.test(body)
            && /teamNotice\.formatTeamNotice\(reply\.json\.members, consent\.STATEMENT_VERSION\)/.test(body); }],
    ['team: format marks the current version in the heading', () =>
        teamNotice && teamNotice.formatTeamNotice([], 2).heading === 'Current notice: version 2'],
    ['team: a member on the current version shows it, marked current, and the date', () =>
        teamNotice && JSON.stringify(teamNotice.formatTeamNotice([{ name: 'Ana Ruiz', email: 'ana@x.test', role: 'member', latestVersion: 2, acceptedAt: '2026-11-09T10:30:00.000Z' }], 2).lines)
            === JSON.stringify(['Ana Ruiz (ana@x.test), member: accepted version 2 (current) on 2026-11-09'])],
    ['team: anyone not on the current version is "not yet", with their last version when there is one', () => {
        if (!teamNotice) return false;
        const { lines } = teamNotice.formatTeamNotice([
            { name: 'Ben Okafor', email: 'ben@x.test', role: 'admin', latestVersion: 1, acceptedAt: '2026-11-01T08:00:00.000Z' },
            { name: null, email: 'cy@x.test', role: 'member', latestVersion: null, acceptedAt: null },
        ], 2);
        return JSON.stringify(lines) === JSON.stringify([
            'Ben Okafor (ben@x.test), admin: not yet (last accepted version 1 on 2026-11-01)',
            'cy@x.test, member: not yet',
        ]); }],
    ['team: a name holding markup stays as it is in the line (the page draws it as text)', () =>
        teamNotice && teamNotice.formatTeamNotice([{ name: '<b>Dee</b>', email: 'd@x.test', role: 'member', latestVersion: null, acceptedAt: null }], 1).lines[0]
            === '<b>Dee</b> (d@x.test), member: not yet'],
    ['team: the page draws the heading, lines and error with textContent only', () => {
        const page = readOr('team-notice-page.js');
        return /textContent = /.test(page) && /createElement\('li'\)/.test(page) && !/innerHTML|insertAdjacentHTML|outerHTML/.test(page); }],
    ['team: the page loads only its own script, under the same Content-Security-Policy as the setup window', () => {
        const html = readOr('team-notice.html');
        const csp = (s) => (/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(s) || [])[1];
        return !!csp(html) && csp(html) === csp(readOr('setup.html')) && html.includes('<script src="team-notice-page.js"></script>')
            && !/<script>/.test(html); }],
    ['team: its preload lets through its two channels and no others', () => {
        const pre = readOr('team-notice-preload.js');
        return /const SEND = \['team-notice:ready'\];/.test(pre) && /const ON = \['team-notice:data'\];/.test(pre); }],
    ['team: the window opens with the hardened preferences', () => /webPreferences: windowPreferences\('team-notice-preload\.js'\)/.test(fnBody('openTeamNoticeWindow'))],
    ['team: the window-hardening check switch can open it', () => /'team-notice': openTeamNoticeWindow/.test(fnBody('openWindowsForCheck'))],
    ['team: build-app.sh copies team-notice.js, its page, its script and its preload into the bundle', () =>
        ['team-notice.js', 'team-notice.html', 'team-notice-page.js', 'team-notice-preload.js']
            .every((f) => BUILD.includes(`cp "$APP_SRC/${f}" "$C/Resources/app/${f}"`))],

    // 10. The menu (SAA-281): tray-menu.js's order and status line, and how
    // main.js's renderTray uses them.
    ['menu: stopped, signed-in admin: exactly status / Start or Stop / Recent meetings, Save transcript, Recognize voices / Detected applications, Open at login / Read the recording notice, Who accepted the notice, Sign out / About, Acknowledgements, Quit', () =>
        !!trayMenu && JSON.stringify(trayMenu.trayMenuOrder({ active: false, hasMeeting: true, accountItems: setup.trayAccountItems({ ...ALL_DONE, setupCompleted: true, teamRole: 'admin' }) }))
            === JSON.stringify(['status', '-', 'start-stop', '-', 'recent-meetings', 'save-transcript', 'recognize-voices', '-', 'detected-apps', 'open-at-login',
                '-', 'read-notice', 'team-notice', 'sign-out', '-', 'about', 'acknowledgements', 'quit'])],
    ['menu: recording: the same order, with "Copy recording notice" right under Start or Stop', () =>
        !!trayMenu && JSON.stringify(trayMenu.trayMenuOrder({ active: true, hasMeeting: true, accountItems: setup.trayAccountItems({ ...ALL_DONE, setupCompleted: true, teamRole: 'admin' }) }))
            === JSON.stringify(['status', '-', 'start-stop', 'copy-notice', '-', 'recent-meetings', 'save-transcript', 'recognize-voices', '-', 'detected-apps', 'open-at-login',
                '-', 'read-notice', 'team-notice', 'sign-out', '-', 'about', 'acknowledgements', 'quit'])],
    ['menu: one Start/Stop item whose label switches, and main.js draws no separate Start and Stop', () => {
        if (!trayMenu) return false;
        const one = (o) => o.filter((k) => k === 'start-stop').length === 1;
        const body = fnBody('renderTray');
        return one(trayMenu.trayMenuOrder({ active: false })) && one(trayMenu.trayMenuOrder({ active: true }))
            && trayMenu.startStopLabel(false) === 'Start recording' && trayMenu.startStopLabel(true) === 'Stop recording'
            && body.includes("items.push({ label: trayMenu.startStopLabel(active), click: active ? () => stopRecording('manual') : startRecording });")
            && !/label: 'Start'|label: 'Stop'/.test(body); }],
    ['menu: notes and prompts sit right under the status line, before Start or Stop, each prompt after a divider', () =>
        !!trayMenu && JSON.stringify(trayMenu.trayMenuOrder(Object.fromEntries([...trayMenu.NOTE_KEYS, ...trayMenu.PROMPT_KEYS].map((k) => [k, true]))).slice(0, 19))
            === JSON.stringify(['status', 'allow-audio', 'location-note', 'update', 'pipeline-note', 'permission-note',
                '-', 'detect-prompt', '-', 'permission-fixes', '-', 'retry-pipeline', '-', 'pending-identity', '-', 'voice-naming', '-', 'fix-speaker-names', '-'])
        && trayMenu.trayMenuOrder(Object.fromEntries([...trayMenu.NOTE_KEYS, ...trayMenu.PROMPT_KEYS].map((k) => [k, true])))[19] === 'start-stop'],
    ['menu: before setup or sign-in is done, Finish setting up, Recording notice and Sign in take the account group\'s slots', () => {
        if (!trayMenu) return false;
        const acct = (o) => { const o2 = trayMenu.trayMenuOrder({ accountItems: o }); const a = o2.indexOf('open-at-login') + 2; return o2.slice(a, o2.indexOf('about') - 1); };
        return JSON.stringify(acct(setup.trayAccountItems({ setupCompleted: false, acknowledged: false, server: null, signedIn: false }))) === JSON.stringify(['finish-setup'])
            && JSON.stringify(acct(setup.trayAccountItems({ setupCompleted: true, acknowledged: false, server: 'https://t.example.com', signedIn: false }))) === JSON.stringify(['recording-notice', 'sign-in']); }],
    ['menu: "Who accepted the notice…" only for a signed-in admin: not a member, not a signed-out admin, not an unknown role', () => {
        if (!trayMenu) return false;
        const has = (o) => trayMenu.trayMenuOrder({ accountItems: setup.trayAccountItems({ ...ALL_DONE, setupCompleted: true, ...o }) }).includes('team-notice');
        return has({ teamRole: 'admin' }) && !has({ teamRole: 'member' }) && !has({ teamRole: 'admin', signedIn: false }) && !has({}); }],
    ['menu: one status line, in place of "Status: …" and the upload lines', () => {
        if (!trayMenu) return false;
        const body = fnBody('renderTray');
        return trayMenu.trayMenuOrder({ active: true }).filter((k) => k === 'status').length === 1
            && /item === 'status'\) \{\s*items\.push\(\{ label: statusLine, enabled: false \}\);/.test(body)
            && !/label: `Status: /.test(SRC) && !body.includes('uploadTrayLabel') && !SRC.includes('function uploadTrayLabel'); }],
    ['menu: the status line says each state in its approved words', () => {
        if (!trayMenu) return false;
        const T = (ms) => (ms === 1000 ? '9:02 AM' : ms === 2000 ? '9:00 AM' : `?${ms}`);
        const stemMs = (stem) => (stem === 'S' ? 2000 : NaN);
        const on = { state: 'stopped', pipeline: null, server: true, signedIn: true };
        const up = (u) => trayMenu.trayStatusLine({ ...on, lastUpload: { stem: 'S', ...u } }, T, stemMs);
        const cases = [
            [trayMenu.trayStatusLine({ ...on, state: 'recording', startedAtMs: 1000 }, T, stemMs), 'Recording · started 9:02 AM'],
            [up({ state: 'sent', jobState: 'done' }), 'Stopped · last call ready 9:00 AM'],
            [up({ state: 'queued', attempts: 0 }), 'Stopped · last call processing'],
            [up({ state: 'sent', jobState: null }), 'Stopped · last call processing'],
            [trayMenu.trayStatusLine({ ...on, pipeline: 'running', lastUpload: null }, T, stemMs), 'Stopped · last call processing'],
            [up({ state: 'queued', attempts: 2 }), 'Stopped · last call retrying upload'],
            [up({ state: 'failed', lastStatus: 422 }), "Stopped · last call didn't upload — see Recent meetings"],
            [trayMenu.trayStatusLine({ ...on, signedIn: false, lastUpload: { stem: 'S', state: 'sent', jobState: 'done' } }, T, stemMs), 'Stopped · not signed in'],
            // The nine Jon worded on 2026-11-10.
            [trayMenu.trayStatusLine({ ...on, state: 'starting' }, T, stemMs), 'Starting recording…'],
            [trayMenu.trayStatusLine({ ...on, state: 'stalled', startedAtMs: 1000 }, T, stemMs), 'Recording · stalled — started 9:02 AM'],
            [up({ state: 'sent', jobState: 'failed' }), 'Stopped · last call failed to process — see Recent meetings'],
            [up({ state: 'sent', jobState: 'none' }), 'Stopped · last call uploaded'],
            [up({ state: 'sent', jobState: 'gone' }), 'Stopped · last call no longer on the server'],
            [up({ state: 'sent', jobState: 'stale' }), 'Stopped · last call status unknown'],
            [trayMenu.trayStatusLine({ ...on, lastUpload: null }, T, stemMs), 'Stopped'],
            [trayMenu.trayStatusLine({ ...on, server: false, signedIn: false, lastUpload: null }, T, stemMs), 'Stopped'],
            [trayMenu.trayStatusLine({ ...on, pipeline: 'failed', lastUpload: { stem: 'S', state: 'sent', jobState: 'done' } }, T, stemMs), 'Stopped · last call failed to process — see Retry below'],
        ];
        const wrong = cases.filter(([got, want]) => got !== want);
        if (wrong.length) console.log(`      status line mismatches: ${JSON.stringify(wrong)}`);
        return wrong.length === 0; }],
    ['menu: renderTray takes the newest upload, the capture\'s start time and the Mac\'s local time format for the status line', () => {
        const body = fnBody('renderTray');
        return body.includes('lastUpload: status.server ? (listUploadQueue().slice(-1)[0] || null) : null,')
            && body.includes('startedAtMs: session ? (session.startedAtMs || stemTimeMs(session.stem)) : null,')
            && body.includes("(ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })"); }],
    ['menu: main.js requires tray-menu.js, and build-app.sh copies it into the bundle', () =>
        SRC.includes("const trayMenu = require('./tray-menu.js');")
        && BUILD.includes('cp "$APP_SRC/tray-menu.js" "$C/Resources/app/tray-menu.js"')],
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
