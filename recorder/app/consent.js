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
// by an older build) does not.
const STATEMENT_VERSION = 1;

// Single line, plain ASCII, on purpose. A line break in a pasted chat message
// can send it in two pieces, and a curly quote or a dash is the kind of
// character a chat box is free to alter. To be confirmed by the Meet paste test.
const NOTICE_LINE = "I'm recording this call with Clipwise to take notes. Let me know if you'd rather I didn't.";

function consentPath(supportDir) {
    return path.join(supportDir, 'consent.json');
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

// 'launch': the window opened by itself when the app started.
// 'blocked': it opened because something tried to start a capture.
function buttonLabel(mode) {
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
    STATEMENT_VERSION, NOTICE_LINE,
    consentPath, readConsent, isAcknowledged, recordAcknowledgement,
    buttonLabel, shouldStartAfterAcknowledgement,
};
