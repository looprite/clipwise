#!/usr/bin/env node
// The day log carries no call content: no names, no meeting titles, no
// notification text (SAA-243 item 7).
//
//   node check-log-lines.js
//   CLIPWISE_CHECK_SOURCE=c5b1408 node check-log-lines.js
//
// Cases 1-5 run code. The logging paths that handle content (identity, voice
// names, transcript saved, transcript save failed on a real fs error, notify and
// its delivered line) are given a fixture holding a known name and meeting title,
// written to a day log in main.js's format, and the log is grepped. The
// formatters are log-lines.js; with CLIPWISE_CHECK_SOURCE set, they are the
// c5b1408 line formats instead, copied into this file (not run from git), so
// case 4 fails there. Case 5 runs that copy every time as the control.
//
// Cases 6-8 read main.js and build-app.sh as text: they show which values the
// console lines interpolate, that every notify() names a fixed kind, and that
// the bundle gets the module, not that any of it runs.
//
// Cases 9-10 (SAA-221): the calendar preview and invitee-names lines are given
// a preview holding the title, the guest's name and an invitee's address, and
// the day log holds no @; the control plants an address line in a copy of it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildAnswerDoc, buildVoiceNamesDoc, calendarPrefillFrom, buildInviteeNamesDoc } = require('./identity-answer.js');

const REV = process.env.CLIPWISE_CHECK_SOURCE || '';
const fromRev = (file) => execFileSync('git', ['show', `${REV}:recorder/app/${file}`], { cwd: __dirname, encoding: 'utf8' });
const SRC = REV ? fromRev('main.js') : fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const BUILD = REV ? fromRev('build-app.sh') : fs.readFileSync(path.join(__dirname, 'build-app.sh'), 'utf8');

const SELF = 'Yvette Quillfeather';
const GUEST = 'Desmond Arkwright';
const TITLE = 'Made-Up Sync Orchard Review';
const NEEDLES = [SELF, GUEST, TITLE];
const ADDRESS = 'desmond.arkwright@example.test';
const STEM = '2026-03-02T15-00-00Z';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-check-log-lines-'));
const outdir = path.join(root, 'recordings');
fs.mkdirSync(outdir);

// The fixture: what the paths are handed, as main.js hands it to them.
const fixture = {
    answer: { names: [GUEST], selfName: SELF, scope: 'work' },
    voices: [{ voice: 'S1', name: SELF }, { voice: 'S2', name: GUEST }],
    suggestedFileName: `2026-03-02 ${TITLE} – transcript.txt`,
    meta: { turns: 12, unattributedTurns: 1 },
    // The server's calendar-preview reply and what the member typed (SAA-221).
    preview: { matched: true, title: TITLE, named: [SELF], unnamed: [ADDRESS] },
    inviteeNames: [{ email: ADDRESS, name: GUEST }],
};
const fixturePath = path.join(root, 'fixture.json');
fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n');
const identityDoc = buildAnswerDoc({ stem: STEM, recordingId: 'R', ...fixture.answer });
const voicesDoc = buildVoiceNamesDoc({ stem: STEM, recordingId: 'R', voices: fixture.voices });
const identityPath = path.join(outdir, `identity-${STEM}.json`);
const voicesPath = path.join(outdir, `voice-names-${STEM}.json`);
const prefill = calendarPrefillFrom(fixture.preview);
const inviteeDoc = buildInviteeNamesDoc({ stem: STEM, recordingId: 'R', pairs: fixture.inviteeNames, allowed: prefill.unnamed });
const inviteePath = path.join(outdir, `invitee-names-${STEM}.json`);
const savedPath = path.join(root, 'Downloads', fixture.suggestedFileName);

// A real failed write to a title-bearing path: a folder the copy cannot write into.
const readOnly = path.join(root, 'read-only');
fs.mkdirSync(readOnly);
fs.chmodSync(readOnly, 0o500);
const tmp = path.join(root, 'clipwise-transcript-tmp.txt');
fs.writeFileSync(tmp, 'transcript\n');
let writeErr = null;
try { fs.copyFileSync(tmp, path.join(readOnly, fixture.suggestedFileName)); } catch (err) { writeErr = err; }

// The new lines: log-lines.js, given what main.js gives it. The counts are taken
// from the built docs as main.js takes them (a copy of those two expressions).
function newLines() {
    const L = require('./log-lines.js');
    return [
        L.identityLine(STEM, !!identityDoc.self.name, identityDoc.guests.length, identityDoc.scope, identityPath),
        L.voiceNamesLine(STEM, voicesDoc.voices.length, voicesDoc.voices.filter((v) => v.name).length, voicesPath),
        L.saveTranscriptSavedLine(STEM, fixture.meta.turns, fixture.meta.unattributedTurns),
        L.notifyLine('transcript-saved'),
        L.notifyDeliveredLine('transcript-saved'),
        L.saveTranscriptFailedLine(STEM, writeErr),
        L.notifyLine('transcript-not-saved'),
        L.calendarPreviewLine(STEM, 'applied', 812, prefill),
        L.calendarPreviewLine(STEM, 'not_signed_in'),
        L.inviteeNamesLine(STEM, inviteeDoc.invitees.length, inviteePath),
        L.inviteeNamesFailedLine(STEM, writeErr),
    ];
}

// COPY of the c5b1408 line formats (main.js 1007, 1014, 1050-1052, 1696, 1721,
// 3545-3548, 3904-3906), not run from git.
function oldLinesCopy() {
    const notify = (title, body) => [`notify: ${title} — ${body}`, `notify: delivered — ${title}`];
    return [
        `[clipwise-recorder] identity ${STEM}: `
            + `self=${JSON.stringify(fixture.answer.selfName)} guests=${JSON.stringify(fixture.answer.names)} `
            + `scope=${JSON.stringify(identityDoc.scope)} -> ${identityPath}`,
        `[clipwise-recorder] voice-names ${STEM}: ${JSON.stringify(voicesDoc.voices)} -> ${voicesPath}`,
        `[clipwise-recorder] save-transcript ${STEM}: saved ${fixture.meta.turns} turns `
            + `(${fixture.meta.unattributedTurns} unattributed) -> ${savedPath}`,
        ...notify('Clipwise: transcript saved', path.basename(savedPath)),
        `[clipwise-recorder] save-transcript ${STEM}: ${String(writeErr)}`,
        ...notify('Clipwise: transcript not saved', String(writeErr && writeErr.message)),
    ];
}

// main.js's day log: recorder-YYYY-MM-DD.log, `${ISO time} ${line}\n` appended.
function writeDayLog(dir, lines) {
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const file = path.join(dir, `recorder-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`);
    for (const line of lines) fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    return file;
}

// grep -F -c: how many lines of the file hold the string.
function grepCount(needle, file) {
    try {
        return Number(execFileSync('grep', ['-F', '-c', needle, file], { encoding: 'utf8' }).trim());
    } catch (err) {
        if (err.status === 1) return 0;
        throw err;
    }
}

const checkedLines = REV ? oldLinesCopy() : newLines();
const checkedLog = writeDayLog(path.join(root, 'checked'), checkedLines);
const oldLog = writeDayLog(path.join(root, 'old-copy'), oldLinesCopy());
const counts = (file) => NEEDLES.map((n) => `${JSON.stringify(n)}=${grepCount(n, file)}`).join(' ');

// Every console.error/console.log call in main.js, from its start to where its
// parentheses balance, with the line it starts on.
function consoleCalls(src) {
    const lines = src.split('\n');
    const out = [];
    lines.forEach((l, i) => {
        const at = l.search(/console\.(error|log)\(/);
        if (at < 0 || /^\s*\/\//.test(l)) return;
        let text = l.slice(at);
        let j = i;
        const depth = (t) => (t.match(/\(/g) || []).length - (t.match(/\)/g) || []).length;
        while (depth(text) > 0 && j < i + 8 && j + 1 < lines.length) text += '\n' + lines[++j];
        out.push({ line: i + 1, text });
    });
    return out;
}
const CONTENT = /\$\{[^}]*\b(title|body|selfName|names|filePath)\b(?!\.error)[^}]*\}|\$\{[^}]*\bdoc\.voices\b[^}]*\}|console\.(error|log)\(\s*(title|body|selfName|names|filePath)\s*[,)]/;
const leaking = consoleCalls(SRC).filter((c) => CONTENT.test(c.text));

// Every notify( call site in main.js: its first argument.
const notifySites = [];
SRC.split('\n').forEach((l, i) => {
    if (/^\s*\/\//.test(l) || /^function notify\(/.test(l)) return;
    const m = /(^|[^\w.])notify\(([^,]*)/.exec(l);
    if (m) notifySites.push({ line: i + 1, first: m[2].trim() });
});
const unkinded = notifySites.filter((s) => !/^'[a-z][a-z-]*'$/.test(s.first));

const CASES = [
    ['control: grep finds the name, the guest and the title in the fixture', () =>
        NEEDLES.every((n) => grepCount(n, fixturePath) > 0)],
    ['control: the failed write is a real fs error whose message names the title-bearing file', () =>
        writeErr && typeof writeErr.code === 'string' && String(writeErr.message).includes(TITLE)],
    ['every path wrote its line to the day log', () =>
        checkedLines.length >= 7 && fs.readFileSync(checkedLog, 'utf8').trim().split('\n').length === checkedLines.length],
    ['the day log holds none of the name, the guest and the title', () =>
        NEEDLES.every((n) => grepCount(n, checkedLog) === 0)],
    ['control (COPY of c5b1408 line formats): the same grep finds all three in that day log', () =>
        NEEDLES.every((n) => grepCount(n, oldLog) > 0)],
    ['main.js (text): no console line interpolates title, body, selfName, names, doc.voices or filePath', () =>
        leaking.length === 0],
    ['main.js (text): every notify() call site passes a fixed kind first', () =>
        notifySites.length > 0 && unkinded.length === 0],
    ['build-app.sh (text): copies log-lines.js into the bundle (main.js requires it)', () =>
        BUILD.includes('cp "$APP_SRC/log-lines.js" "$C/Resources/app/log-lines.js"')],
    ['SAA-221: the day log, with the calendar-preview and invitee-names lines, holds no @ (fixture holds the address)', () =>
        grepCount(ADDRESS, fixturePath) > 0 && inviteeDoc.invitees.length === 1 && grepCount('@', checkedLog) === 0],
    ['control: the same grep finds an @ planted in a copy of that day log', () => {
        const planted = path.join(root, 'planted.log');
        fs.writeFileSync(planted, fs.readFileSync(checkedLog, 'utf8') + `x calendar-preview ${STEM}: ${ADDRESS}\n`);
        return grepCount('@', planted) > 0;
    }],
];

console.log(`source: ${REV ? `${REV} main.js and build-app.sh; line formats: COPY of c5b1408, not run from git` : 'log-lines.js, main.js and build-app.sh in the checkout'}`);
console.log('expected to fail on c5b1408: cases 4, 6, 7 and 8, and nothing else');
console.log(`grep counts, fixture:           ${counts(fixturePath)}`);
console.log(`grep counts, checked day log:   ${counts(checkedLog)}`);
console.log(`grep counts, c5b1408 copy log:  ${counts(oldLog)}`);
console.log(`checked day log:\n${fs.readFileSync(checkedLog, 'utf8').replace(/^\S+ /gm, '    ')}`);
for (const c of leaking) console.log(`console line interpolating content: main.js:${c.line}`);
for (const s of unkinded) console.log(`notify() without a fixed kind: main.js:${s.line}`);
let fails = 0;
CASES.forEach(([name, fn], i) => {
    let ok = false;
    try { ok = !!fn(); } catch { ok = false; }
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${i + 1}. ${name}`);
});
fs.chmodSync(readOnly, 0o700);
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${CASES.length - fails}/${CASES.length} as expected`);
process.exit(fails ? 1 : 0);
