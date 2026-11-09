// The first-run acknowledgement (SAA-216): what is recorded once, when the
// window opens, what its button says, what happens after it is answered, and
// the one line the tray copies for the meeting chat.
//
// Clipwise is bot-free, so nothing appears in the meeting and nobody else on
// the call can tell it is recording. Before the first capture can run, the
// person is told that, and that telling the people they record is their job.
// Not shown again once agreed to, unless STATEMENT_VERSION is raised on
// purpose (a change in what is stored about people on a call is the kind of
// thing that would).
//
// Split out of main.js, like identity-answer.js and autostop.js, so no
// Electron is needed to exercise it: check-consent.js runs these rules against
// a temp directory instead of clicking through a packaged app.
//
// The gate itself is main.js's startRecording(), the one function every way of
// starting a capture goes through. This file decides; it does not stop anything.

'use strict';

const fs = require('fs');
const path = require('path');

// Raised only to ask everyone again, deliberately. A file written at a lower
// version counts as not acknowledged; a higher one (a newer build's file read
// by an older build) does not. Each version's text is
// notice/recording-notice-v<N>.txt (readNotice, below).
const STATEMENT_VERSION = 1;

// Single line, plain ASCII, on purpose. A line break in a pasted chat message
// can send it in two pieces, and a curly quote or a dash is the kind of
// character a chat box is free to alter. To be confirmed by the Meet paste test.
const NOTICE_LINE = "I'm recording this call with Clipwise to take notes. Let me know if you'd rather I didn't.";

function consentPath(supportDir) {
    return path.join(supportDir, 'consent.json');
}

// The notice's text, one file per version in the repo and the bundle:
// notice/recording-notice-v<N>.txt. Raising STATEMENT_VERSION means adding the
// next file; the earlier ones stay as the record of what each version said.
//
// The format, plain text:
//   the first non-blank line   the title
//   "## " at a line's start    a heading                     -> { tag: 'h2', text }
//   "- " at a line's start     a bullet; consecutive bullets  -> { tag: 'ul', items }
//                              are one list, a blank line ends it
//   any other lines            a paragraph; lines run together, a blank line
//                              ends it                        -> { tag: 'p', text }
// The page draws these three tags with textContent and nothing else, never as
// markup, so nothing in the file can become HTML.
const NOTICE_DIR = path.join(__dirname, 'notice');

// Throws when the file for that version is missing, has no title, or has
// nothing after it: a bundle without it must fail loudly, never show an empty
// notice that could be agreed to.
function readNotice(version = STATEMENT_VERSION, dir = NOTICE_DIR) {
    const lines = fs.readFileSync(path.join(dir, `recording-notice-v${version}.txt`), 'utf8').replace(/\r\n/g, '\n').split('\n');
    const clean = (s) => s.replace(/\s+/g, ' ').trim();
    let title = null;
    const blocks = [];
    let open = null; // the paragraph or list being added to
    for (const raw of lines) {
        const line = raw.trimEnd();
        if (line.trim() === '') { open = null; continue; }
        if (title === null) { title = clean(line); continue; }
        if (line.startsWith('## ')) {
            blocks.push({ tag: 'h2', text: clean(line.slice(3)) });
            open = null;
        } else if (line.startsWith('- ')) {
            if (!open || open.tag !== 'ul') { open = { tag: 'ul', items: [] }; blocks.push(open); }
            open.items.push(clean(line.slice(2)));
        } else if (open && open.tag === 'p') {
            open.text = clean(`${open.text} ${line}`);
        } else {
            open = { tag: 'p', text: clean(line) };
            blocks.push(open);
        }
    }
    if (!title || blocks.length === 0) throw new Error(`recording-notice-v${version}.txt has no title or no text after it`);
    return { version, title, blocks, paragraphs: blocks.filter((b) => b.tag === 'p').map((b) => b.text) };
}

// Whether a notice as the page gets it can be agreed to: a title and at least
// one block. A notice that could not be read (null) or is empty cannot: the page
// disables its button, and main.js records nothing for it.
function noticeAgreeable(notice) {
    return !!(notice && notice.title && Array.isArray(notice.blocks) && notice.blocks.length > 0);
}

// Never throws: a missing, unreadable, garbled or wrongly-shaped file is the
// same answer, "nothing recorded", and the gate then asks.
function readConsent(supportDir) {
    try {
        const doc = JSON.parse(fs.readFileSync(consentPath(supportDir), 'utf8'));
        if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
        return doc;
    } catch {
        return null;
    }
}

function isAcknowledged(supportDir) {
    const doc = readConsent(supportDir);
    return !!doc
        && typeof doc.version === 'number'
        && doc.version >= STATEMENT_VERSION
        && typeof doc.acknowledged_at === 'string'
        && doc.acknowledged_at.length > 0;
}

// Writes the acknowledgement, atomically (temp file, then rename), creating the
// directory first because a fresh install has none. Idempotent: if it is
// already acknowledged at this version the first timestamp is kept and nothing
// is rewritten. Throws if it cannot be written, so the caller does not treat
// an answer that was lost as given.
function recordAcknowledgement(supportDir, now = new Date()) {
    if (isAcknowledged(supportDir)) return readConsent(supportDir);
    fs.mkdirSync(supportDir, { recursive: true });
    const doc = { version: STATEMENT_VERSION, acknowledged_at: now.toISOString() };
    const finalPath = consentPath(supportDir);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmpPath, finalPath);
    return doc;
}

// The acknowledgement in force now, as the manifest stamps it at capture start
// and the recorder sends it to the server (SAA-227 part I): the version and when
// it was agreed to, nothing else from the file. Null when it is not agreed to.
function noticeStamp(supportDir) {
    if (!isAcknowledged(supportDir)) return null;
    const doc = readConsent(supportDir);
    return { version: doc.version, acknowledged_at: doc.acknowledged_at };
}

// The acknowledgement as POST /captures/notice takes it (Gate 1, the member
// notice): the version and when it was agreed to, nothing else. Null when it is
// not agreed to. The capture's notice stamp carries the same and stays the
// fallback for an answer given while offline or signed out.
function noticeReport(supportDir) {
    const stamp = noticeStamp(supportDir);
    return stamp ? { version: stamp.version, acknowledgedAt: stamp.acknowledged_at } : null;
}

// 'launch': the window opened by itself when the app started.
// 'blocked': it opened because something tried to start a capture.
// 'reread': opened from the tray to read it again once agreed; its one button
//   closes it and writes nothing.
function buttonLabel(mode) {
    if (mode === 'reread') return 'Close';
    return mode === 'blocked' ? 'I understand — start recording' : 'I understand';
}

// After "I understand" is saved, should a capture start now?
//   launch   -> never: nothing asked for one.
//   blocked, a hand-started capture (no trigger) -> yes, the person pressed Start.
//   blocked, started by an app -> only if that app still holds the mic, i.e. the
//     call is still going. Otherwise it has ended and there is nothing to record.
// `holdsMic` is a function of a trigger key, so this stays free of main.js's
// detectActive map.
function shouldStartAfterAcknowledgement(mode, blockedStart, holdsMic) {
    if (mode !== 'blocked' || !blockedStart) return false;
    const trigger = blockedStart.trigger;
    if (!trigger || !trigger.key) return true;
    return !!holdsMic(trigger.key);
}

module.exports = {
    STATEMENT_VERSION, NOTICE_LINE, NOTICE_DIR,
    consentPath, readNotice, noticeAgreeable, readConsent, isAcknowledged, recordAcknowledgement, noticeStamp, noticeReport,
    buttonLabel, shouldStartAfterAcknowledgement,
};
