// The identity answer on disk: the files what the prompt collects waits in
// until ingest reads them, and the tray's lists read from those files. For
// main.js and the checks only; the page never loads this file (SAA-243 window
// hardening). What goes into the files is shaped by identity-rules.js, which
// the page does load.
//
// Split out of main.js because it has no Electron in it. Kept here it can be
// exercised directly, without a window and without a person to type into one.

const fs = require('fs');
const path = require('path');

// The saved answer for a capture, or null when there is none or it can't be read.
function readAnswer(dir, stem) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, `identity-${stem}.json`), 'utf8'));
    } catch {
        return null;
    }
}

// Where the answer lives until there is a row to attach it to.
//
// A capture stops minutes before its recording row exists: the pipeline
// transcribes first and ingest inserts the row after that. So the answer goes
// to identity-<stem>.json in the capture directory, beside the manifest and
// the audio it describes. Nothing is held in the recorder's memory and nothing
// is handed to the running pipeline, which is why a crash, a quit or a reboot
// between the answer and the ingest costs nothing — the file is still there,
// and ingest reads it whenever it gets there.
//
// Written to a temporary file in the same directory and renamed, so an
// interrupted write leaves either the old state or the new one, never half a
// JSON document for ingest to guess about.
function writeAnswer(dir, doc) {
    const finalPath = path.join(dir, `identity-${doc.stem}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmpPath, finalPath);
    return finalPath;
}

// Written whole or not at all, as writeAnswer.
function writeInviteeNames(dir, doc) {
    const finalPath = path.join(dir, `invitee-names-${doc.stem}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmpPath, finalPath);
    return finalPath;
}

function readInviteeNames(dir, stem) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, `invitee-names-${stem}.json`), 'utf8'));
    } catch {
        return null;
    }
}

// --- step 1 deferred: "Later" (SAA-197) -------------------------------------
//
// Closing the prompt's window without Save or Skip is Later, not Skip — the
// capture stays unanswered, but unlike Skip it comes back as a tray item
// rather than being dropped for good. Skip itself writes nothing (unchanged,
// SAA-197 is explicit that it keeps its current meaning), so a marker is the
// only way to tell "closed without answering" apart from "skipped" once both
// have left identity-<stem>.json unwritten — same reasoning as voices-<stem>
// vs voice-names-<stem> one step over. Written from exactly the fields
// promptForIdentity needs to reopen the same prompt (stem, recordingId,
// inferredScope, durationMs) — everything else (self, known names) is read
// fresh from disk when it reopens, the same as the first time.
function laterMarkerPathFor(dir, stem) {
    return path.join(dir, `identity-later-${stem}.json`);
}

function writeLaterMarker(dir, capture) {
    const finalPath = laterMarkerPathFor(dir, capture.stem);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(capture, null, 2) + '\n');
    fs.renameSync(tmpPath, finalPath);
    return finalPath;
}

function readLaterMarker(dir, stem) {
    try {
        return JSON.parse(fs.readFileSync(laterMarkerPathFor(dir, stem), 'utf8'));
    } catch {
        return null;
    }
}

// Called once identity-<stem>.json exists (Save) or the window resolves as a
// genuine Skip — either way this capture is no longer pending, whether or
// not it was ever deferred. A no-op when there is nothing to remove.
function deleteLaterMarker(dir, stem) {
    try {
        fs.unlinkSync(laterMarkerPathFor(dir, stem));
    } catch {
        // Nothing to remove — the common case, since most captures are never
        // deferred at all.
    }
}

// A capture is waiting on step 1 when it was deferred (a marker exists) and
// nobody has answered since (no identity-<stem>.json) — same shape as
// pendingVoiceNamingStems just above one step earlier. Ascending, oldest
// first, same convention.
function pendingIdentityStems(dir) {
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const stems = [];
    for (const file of files) {
        const m = /^identity-later-(.+)\.json$/.exec(file);
        if (!m) continue;
        const stem = m[1];
        if (files.includes(`identity-${stem}.json`)) continue; // already answered
        if (files.includes(`trashed-${stem}.json`)) continue; // in the trash (SAA-154)
        stems.push(stem);
    }
    stems.sort();
    return stems;
}

const IDENTITY_STEM_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/;

function stemTimestampMs(stem) {
    const m = IDENTITY_STEM_PATTERN.exec(stem || '');
    if (!m) return null;
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    return Number.isNaN(t) ? null : t;
}

// The tray's actual display list: pendingIdentityStems, narrowed to the
// DEFAULT_MAX_ITEMS most recent calls from the last DEFAULT_WINDOW_MS —
// a capture prompted for weeks ago and never answered is not a "who was on
// this call" question worth asking today. Older markers are left on disk
// untouched (nothing here deletes one) — recovery can still pick up a late
// identity-<stem>.json answer whenever it arrives; this only controls what
// the tray lists. `now` is a parameter, not Date.now() inline, so this is
// exercisable without mocking the clock.
function recentPendingIdentityStems(dir, opts = {}) {
    return recentStems(pendingIdentityStems(dir), opts);
}

// The ascending `stems` narrowed to the maxItems most recent from the last
// windowMs (3 and 7 days unless given), shared by both tray lists.
function recentStems(stems, opts = {}) {
    const now = opts.now ?? Date.now();
    const maxItems = opts.maxItems ?? 3;
    const windowMs = opts.windowMs ?? 7 * 24 * 60 * 60 * 1000;
    const cutoff = now - windowMs;
    const recent = stems.filter((stem) => {
        const t = stemTimestampMs(stem);
        return t !== null && t >= cutoff;
    });
    return recent.slice(-maxItems);
}

// Same write-to-temp-then-rename durability as writeAnswer above, and a
// different filename (voice-names-<stem>.json, not identity-<stem>.json) so
// the two answers — who was on the call, and who's speaking — never collide
// and either can arrive without the other existing yet.
function writeVoiceNamesAnswer(dir, doc) {
    const finalPath = path.join(dir, `voice-names-${doc.stem}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmpPath, finalPath);
    return finalPath;
}

// The naming-data file the server writes (voice-clips.ts) once diarize
// splits a recording — clip paths and longest lines per voice. Read here,
// not derived: main.js has no database access, the same reason
// identity-<stem>.json exists as a file rather than a query.
function readNamingData(dir, stem) {
    const p = path.join(dir, `voices-${stem}.json`);
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

// The answer already on file for a capture, if any — read here so the
// "Rename voices…" reopen can pre-select each voice's current name rather
// than starting from "Not sure" again.
function readVoiceNamesAnswer(dir, stem) {
    const p = path.join(dir, `voice-names-${stem}.json`);
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

// Whether naming a call's voices is settled, so nothing asks for it again
// (SAA-255): a voice-names answer exists, or the identity answer names exactly
// one guest. That guest is the other side of the call, so there is no voice
// left to put a name to, whether or not diarize left naming data for it.
// Guests are counted as the server counts them for the same rule
// (server/src/ingest/identity.ts attendeeRowsFrom and applySpeakerNames:
// trimmed, non-empty, exactly one), so the naming is settled here exactly when
// the server names `them` from this answer. Duplicates are not merged: the
// server does not merge them either.
function namingSettled(dir, stem) {
    if (fs.existsSync(path.join(dir, `voice-names-${stem}.json`))) return true;
    let identity;
    try {
        identity = JSON.parse(fs.readFileSync(path.join(dir, `identity-${stem}.json`), 'utf8'));
    } catch {
        return false;
    }
    const guests = (identity && Array.isArray(identity.guests) ? identity.guests : [])
        .filter((guest) => typeof guest?.name === 'string' && guest.name.trim());
    return guests.length === 1;
}

// A capture has voices waiting to be named when the server produced naming
// data for it and its naming is not settled (namingSettled). All of it is
// files on disk — main.js has no other way to know any of it.
function pendingVoiceNamingStems(dir) {
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const stems = [];
    for (const file of files) {
        const m = /^voices-(.+)\.json$/.exec(file);
        if (!m) continue;
        const stem = m[1];
        if (namingSettled(dir, stem)) continue; // answered, or a one-guest call (SAA-255)
        if (files.includes(`trashed-${stem}.json`)) continue; // in the trash (SAA-154)
        stems.push(stem);
    }
    stems.sort();
    return stems;
}

// The tray's "Name N voices…" list (SAA-255): pendingVoiceNamingStems less any
// stem still pending on identity (naming voices before knowing who was on the
// call isn't useful), then narrowed the way recentPendingIdentityStems narrows
// its list. The exclusion comes first so the slots go to calls that can be
// named. Older calls stay in Recent meetings, which doesn't read this.
function recentPendingVoiceNamingStems(dir, opts = {}) {
    const pendingIdentity = new Set(pendingIdentityStems(dir));
    return recentStems(pendingVoiceNamingStems(dir).filter((stem) => !pendingIdentity.has(stem)), opts);
}

// The newest capture that already has a saved voice-names answer — the one
// and only "Rename voices…" candidate (SAA-195: only one call gets this
// item, never a list of past calls).
function mostRecentNamedStem(dir) {
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return null;
    }
    const stems = [];
    for (const file of files) {
        const m = /^voice-names-(.+)\.json$/.exec(file);
        // A trashed capture is not a candidate (SAA-154).
        if (m && !files.includes(`trashed-${m[1]}.json`)) stems.push(m[1]);
    }
    if (stems.length === 0) return null;
    stems.sort();
    return stems[stems.length - 1];
}

// The newest capture on disk, named or not — every capture writes a
// manifest, so this is "the most recent recording" independent of voice
// naming state. Used to decide whether the "Rename voices…" item's
// recording is still the latest one (SAA-195): stems sort lexicographically
// in chronological order, same convention as mostRecentNamedStem above.
function mostRecentCaptureStem(dir) {
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return null;
    }
    const stems = [];
    for (const file of files) {
        const m = /^manifest-(.+)\.json$/.exec(file);
        // The newest capture that is not in the trash (SAA-154).
        if (m && !files.includes(`trashed-${m[1]}.json`)) stems.push(m[1]);
    }
    if (stems.length === 0) return null;
    stems.sort();
    return stems[stems.length - 1];
}

module.exports = {
    writeAnswer,
    readAnswer,
    writeInviteeNames,
    readInviteeNames,
    writeLaterMarker,
    readLaterMarker,
    deleteLaterMarker,
    pendingIdentityStems,
    recentPendingIdentityStems,
    writeVoiceNamesAnswer,
    readNamingData,
    namingSettled,
    pendingVoiceNamingStems,
    recentPendingVoiceNamingStems,
    readVoiceNamesAnswer,
    mostRecentNamedStem,
    mostRecentCaptureStem,
};
