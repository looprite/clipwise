// The identity answer: what the prompt collects, and how it reaches disk.
//
// Split out of main.js because it is the half of SAA-114 with no Electron in
// it — parsing what someone typed, and writing the file that carries it to
// ingest. Kept here it can be exercised directly, without a window and without
// a person to type into one; inside main.js it could only ever be verified by
// re-implementing it somewhere else, which verifies the re-implementation.
//
// The reader is server/src/ingest/identity.ts. IDENTITY_VERSION is shared
// between them by hand, so bump both or neither.

const fs = require('fs');
const path = require('path');

// Bumped 1 -> 2 for `scope` (SAA-153) and the selection-vs-typing split
// (SAA-169) — the shape this writes changed. Nothing reads this number to
// gate behavior; it is a shared marker so identity.ts's copy gets bumped in
// the same change rather than drifting.
const IDENTITY_VERSION = 2;

// The prompt window's content box. Height is not a constant: the page measures
// itself and asks to be resized, because a fixed height is a bet that the copy
// will never change and 7dae4a9 lost that bet — a hint added to the names
// field pushed Save and Skip below the bottom edge of a 460×320 window with no
// way to scroll to them.
//
// The clamp is what keeps a measurement bug from producing a 3-pixel or a
// full-screen prompt. Between the two bounds the window fits its content; past
// the upper one the page scrolls internally and the buttons stay pinned, so
// they are reachable at every height either way.
const IDENTITY_WINDOW = { width: 460, minHeight: 220, maxHeight: 560 };

function contentHeightFor(measured) {
    const h = Math.ceil(Number(measured));
    if (!Number.isFinite(h)) return IDENTITY_WINDOW.minHeight;
    return Math.min(IDENTITY_WINDOW.maxHeight, Math.max(IDENTITY_WINDOW.minHeight, h));
}

// Newlines and commas both separate, because both are what people type.
// Duplicates are dropped case-insensitively; the first spelling wins.
function parseNames(raw) {
    const seen = new Set();
    const names = [];
    for (const part of String(raw || '').split(/[\n,]/)) {
        const name = part.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(name);
    }
    return names;
}

// SAA-169: every previously-written identity-<stem>.json in `dir` is a
// record of a name someone typed at this exact prompt before. Scanning them
// is the "known names" roster the picker offers, so the same person is
// selected rather than retyped — no server round trip, no new local cache
// to keep in sync, just the answers already sitting on disk. Self is not
// included: it is one person, already remembered separately via
// identity-self.json (readSelfName in main.js).
//
// Same dedup rule as parseNames: case-insensitive, first spelling kept.
// Sorted for a stable, scannable list rather than insertion/file order,
// which is filesystem-dependent and not meaningful here.
function knownGuestNames(dir) {
    const seen = new Set();
    const names = [];
    let files;
    try {
        files = fs.readdirSync(dir).filter((f) => /^identity-.*\.json$/.test(f));
    } catch {
        return names;
    }
    for (const file of files) {
        let doc;
        try {
            doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        } catch {
            continue;
        }
        for (const guest of (doc && doc.guests) || []) {
            const name = typeof guest?.name === 'string' ? guest.name.trim() : '';
            if (!name) continue;
            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            names.push(name);
        }
    }
    names.sort((a, b) => a.localeCompare(b));
    return names;
}

// The submitted guest list is two sources merged: names picked from the
// known-names list (selection, SAA-169's fix) and names typed into the
// "someone new" field (parseNames, unchanged — this is still exactly how a
// first meeting with anyone works). Selected names win the case-insensitive
// dedup on overlap, since they are already the canonical on-disk spelling
// rather than freshly typed text.
function mergeGuestNames(selected, typedRaw) {
    const seen = new Set();
    const names = [];
    for (const raw of selected || []) {
        const name = String(raw || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(name);
    }
    for (const name of parseNames(typedRaw)) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(name);
    }
    return names;
}

// `self` is the person answering: the prompt asks who the call was *with*, so
// their own row is implied by the question rather than typed into it. A null
// name is a real answer — attendance without a claim about who — and is what
// this carries until they say what they are called. It is never derived from
// the OS account: `id -F` on the machine this was written on answers "JD".
// `scope` (SAA-153) is the same "one more choice on a prompt already being
// answered" the issue settled on — personal vs. work, asked once per call
// rather than inferred. Anything other than the literal 'work' or
// 'personal' is written as null: an unrecognised value is not a scope
// server-side (recordings_scope_valid only permits those two), and null is
// the honest "not answered" rather than a guess at which one was meant.
//
// `corrects` (SAA-258) is set only on a correction from Recent meetings: the
// answered_at of the answer it replaces (correctsFor below). The server applies
// a correction in place of that answer, and refuses one whose answer it no
// longer holds.
//
// A name with an @ is an address, not a name (SAA-221): the page blocks Save on
// one, and this drops any that get past it, so identity files carry no
// addresses. ingest/identity.ts drops them again on the server.
function buildAnswerDoc({ stem, recordingId, names, selfName, scope, answeredAt, corrects }) {
    const self = selfName && !hasAt(selfName) ? selfName : null;
    return {
        identity_version: IDENTITY_VERSION,
        recording_id: recordingId,
        stem,
        answered_at: answeredAt || new Date().toISOString(),
        self: {
            name: self,
            source: self ? 'recorder_identity_prompt' : null,
        },
        guests: (names || []).filter((name) => !hasAt(name)).map(name => ({ name })),
        scope: scope === 'work' || scope === 'personal' ? scope : null,
        ...(corrects ? { corrects } : {}),
    };
}

// The saved answer for a capture, or null when there is none or it can't be read.
function readAnswer(dir, stem) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, `identity-${stem}.json`), 'utf8'));
    } catch {
        return null;
    }
}

// What a new correction corrects (SAA-258): the answer the server holds. Only
// this Mac changes a recording's answer, so that is the last one the server
// accepted (`acceptedAt`, the queue entry's identityAcceptedAt), whatever is on
// disk: an unsent correction the queue never sent, or one the server refused as
// stale. With none known yet (a capture sent before this was recorded, or not
// sent at all), the answer on disk (`previous`) says: what it corrects if it is
// itself an unsent correction, else its own answered_at.
function correctsFor(previous, acceptedAt) {
    if (acceptedAt) return acceptedAt;
    if (!previous || !previous.answered_at) return null;
    return previous.corrects || previous.answered_at;
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

// --- the calendar's guests (SAA-221) ----------------------------------------
//
// At stop, main.js asks the server (POST /captures/calendar-preview) who the
// calendar says the call was with. calendarPrefillFrom keeps only what the page
// may use from the reply. The guest list below is what the page checks and
// submits, kept here so check-calendar-prefill.js can exercise it without a
// window. SAA-260 replaces the checklist; nothing on the server depends on it.

// A preview is applied only if it arrives this soon after the stop.
const CALENDAR_PREVIEW_WAIT_MS = 5000;
const MAX_PREFILL = 50;

function hasAt(value) {
    return String(value).includes('@');
}

// The server's reply, or null when it is not a match. Named entries are names
// (none with an @); unnamed entries are addresses (each with one), lowercased
// and once each.
function calendarPrefillFrom(json) {
    if (!json || json.matched !== true) return null;
    const strings = (list) => (Array.isArray(list) ? list : [])
        .filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
    const named = strings(json.named).filter((n) => !hasAt(n)).slice(0, MAX_PREFILL);
    const unnamed = [...new Set(strings(json.unnamed).filter(hasAt).map((e) => e.toLowerCase()))].slice(0, MAX_PREFILL);
    const title = typeof json.title === 'string' && json.title.trim() ? json.title.trim().slice(0, 200) : null;
    return { title, named, unnamed };
}

// Step 1's guest list: one box per name, checked or not, and the names the
// member typed for invitees the calendar could not name (entries, address ->
// { name, created, borrowed }). An entry is its own record: unchecking a box
// takes that person out of the guests and keeps the entry, so they are still
// named once.
//   created   the box the entry added, or null. Only a created box is ever
//             renamed or removed.
//   borrowed  { box, wasChecked, toggled } when the entry checked a box that
//             existed before it: the box, its checked state before, and whether
//             the member has toggled it since. When the entry moves off the
//             box (retyped or cleared) the box goes back to wasChecked, unless
//             toggled; a borrowed box is never removed.
// `touched` is set by any change the member makes to the list; after that the
// calendar preselects nothing.
function guestList(knownNames, checkedNames) {
    const checked = new Set((checkedNames || []).map((n) => String(n).toLowerCase()));
    return {
        boxes: (knownNames || []).map((name) => ({ name, checked: checked.has(String(name).toLowerCase()) })),
        entries: new Map(),
        touched: false,
    };
}

function boxFor(list, name, except) {
    const key = String(name).toLowerCase();
    return list.boxes.find((b) => b !== except && b.name.toLowerCase() === key) || null;
}

// Another entry than `email`'s that borrows `box`, or null.
function borrowerOf(list, email, box) {
    for (const [otherEmail, other] of list.entries) {
        if (otherEmail !== email && other.borrowed && other.borrowed.box === box) return other;
    }
    return null;
}

// The calendar's named invitees: a box for each, an existing one or a new one,
// checked only while the list is untouched.
function applyCalendarNames(list, named) {
    for (const name of named || []) {
        if (!name || hasAt(name)) continue;
        let box = boxFor(list, name);
        if (!box) {
            box = { name, checked: false };
            list.boxes.push(box);
        }
        if (!list.touched) box.checked = true;
    }
}

// The member toggling a box directly. An entry borrowing it then leaves it as
// the member set it.
function setGuestChecked(list, name, checked) {
    list.touched = true;
    const box = boxFor(list, name);
    if (!box) return;
    box.checked = !!checked;
    for (const entry of list.entries.values()) {
        if (entry.borrowed && entry.borrowed.box === box) entry.borrowed.toggled = true;
    }
}

// Any other change to the guest list (typing in "Someone new?").
function touchGuests(list) {
    list.touched = true;
}

// `email`'s entry moving off its box. A created box passes to an entry that
// borrows it, which then owns it, or else is removed. A borrowed box goes back
// to its state from before, unless the member toggled it or another entry
// still holds it.
function letGoOfBox(list, email, entry) {
    if (entry.created) {
        const box = entry.created;
        entry.created = null;
        const heir = borrowerOf(list, email, box);
        if (heir) {
            heir.created = box;
            heir.borrowed = null;
        } else {
            list.boxes = list.boxes.filter((b) => b !== box);
        }
    }
    if (entry.borrowed) {
        const { box, wasChecked, toggled } = entry.borrowed;
        entry.borrowed = null;
        const stillHeld = borrowerOf(list, email, box)
            || [...list.entries].some(([e, other]) => e !== email && other.created === box);
        if (!stillHeld && !toggled && list.boxes.includes(box)) box.checked = wasChecked;
    }
}

// A name committed for an invitee's address (the page calls this on the
// field's change event, and for every field on Save). Records the entry and
// checks its box:
//   first name     a box with that name is borrowed and checked, or one is
//                  created
//   retyped        the box this entry created is renamed in place, unless the
//                  new name already has its own box or another entry borrows
//                  it: then the entry lets go of it and takes the new name's
//                  box. A borrowed box goes back to its state from before.
//   same name      nothing changes (a box the member unchecked stays so)
//   cleared        the entry goes, and lets go of its box
//   name with @    nothing changes (the page blocks Save on it)
// Returns the entry's box, or null.
function nameInvitee(list, email, name) {
    list.touched = true;
    const n = String(name || '').trim();
    if (hasAt(n)) return null;
    const entry = list.entries.get(email) || null;
    if (!n) {
        if (entry) letGoOfBox(list, email, entry);
        list.entries.delete(email);
        return null;
    }
    if (entry && entry.name === n) return entry.created || (entry.borrowed && entry.borrowed.box) || null;
    if (entry && entry.created && !boxFor(list, n, entry.created) && !borrowerOf(list, email, entry.created)) {
        entry.created.name = n;
        entry.created.checked = true;
        entry.name = n;
        return entry.created;
    }
    if (entry) letGoOfBox(list, email, entry);
    let box = boxFor(list, n);
    if (!box) {
        box = { name: n, checked: true };
        list.boxes.push(box);
        list.entries.set(email, { name: n, created: box, borrowed: null });
        return box;
    }
    // A box another entry already borrows was checked by that entry: its state
    // from before is the one that entry recorded.
    const earlier = borrowerOf(list, email, box);
    const wasChecked = earlier ? earlier.borrowed.wasChecked : box.checked;
    box.checked = true;
    list.entries.set(email, { name: n, created: null, borrowed: { box, wasChecked, toggled: false } });
    return box;
}

function checkedGuestNames(list) {
    return list.boxes.filter((b) => b.checked).map((b) => b.name);
}

function inviteeEntries(list) {
    return [...list.entries].map(([email, entry]) => ({ email, name: entry.name }));
}

const INVITEE_NAMES_VERSION = 1;

// What the member typed for invitees the calendar could not name, for POST
// /captures' inviteeNames (server/src/ingest/invitee-names.ts). A file of its
// own, invitee-names-<stem>.json, never the identity file: identity files carry
// no addresses. `allowed` is the addresses the preview offered: a pair for any
// other address, an empty name, a name with an @ or one past the server's
// bounds is dropped, and each address is kept once.
function buildInviteeNamesDoc({ stem, recordingId, pairs, allowed }) {
    const ok = new Set((allowed || []).map((e) => String(e).toLowerCase()));
    const seen = new Set();
    const invitees = [];
    for (const pair of pairs || []) {
        const email = String(pair?.email || '').trim().toLowerCase();
        const name = String(pair?.name || '').trim();
        if (!ok.has(email) || seen.has(email)) continue;
        if (!name || hasAt(name) || name.length > 256 || email.length > 320) continue;
        seen.add(email);
        invitees.push({ email, name });
    }
    return {
        invitee_names_version: INVITEE_NAMES_VERSION,
        recording_id: recordingId,
        stem,
        invitees: invitees.slice(0, MAX_PREFILL),
    };
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

// --- step 2: naming the voices (SAA-195) -----------------------------------

const VOICE_NAMES_VERSION = 1;

// `voices` is [{ voiceIndex, name }], name null/absent for "Not sure" —
// SAA-165's correct-or-absent rule again, same as guests above: never a
// fallback name of any kind. `rename` is set only by the "Rename voices…"
// reopen (the most recent named call only) — server/src/ingest/voice-
// names.ts's applyVoiceNames reads it to decide whether an already-named
// voice may be overwritten or cleared; ordinary first-time naming never
// sets it.
function buildVoiceNamesDoc({ stem, recordingId, voices, answeredAt, rename }) {
    return {
        voice_names_version: VOICE_NAMES_VERSION,
        recording_id: recordingId,
        stem,
        answered_at: answeredAt || new Date().toISOString(),
        voices: (voices || []).map(v => ({
            voiceIndex: v.voiceIndex,
            name: v.name || null,
        })),
        ...(rename ? { rename: true } : {}),
    };
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

// The majority rule that puts a `them` segment on a diarized voice, for the
// capture builder in main.js (SAA-227 decision 1): the Mac does the assignment
// and sends each segment's voice index. A copy of assignVoice in
// server/src/pipeline/voice-clips.ts, which has the reasoning;
// check-assign-voice.ts runs both over the same cases. Times in seconds. A turn
// with no voiceIndex (an excluded voice) counts toward no voice. Null when no
// voice covers more than half the segment.
const ASSIGN_VOICE_MAJORITY_FRACTION = 0.5;
function assignVoice(segStart, segEnd, diarized) {
    const segDuration = segEnd - segStart;
    if (segDuration <= 0) return null;
    const overlapByVoice = new Map();
    for (const d of diarized) {
        if (d.voiceIndex == null) continue;
        const overlap = Math.min(segEnd, d.end) - Math.max(segStart, d.start);
        if (overlap <= 0) continue;
        overlapByVoice.set(d.voiceIndex, (overlapByVoice.get(d.voiceIndex) || 0) + overlap);
    }
    let bestVoice = null;
    let bestOverlap = 0;
    for (const [voice, overlap] of overlapByVoice) {
        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestVoice = voice;
        }
    }
    return bestVoice !== null && bestOverlap > segDuration * ASSIGN_VOICE_MAJORITY_FRACTION ? bestVoice : null;
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
    IDENTITY_VERSION,
    IDENTITY_WINDOW,
    contentHeightFor,
    parseNames,
    knownGuestNames,
    mergeGuestNames,
    buildAnswerDoc,
    writeAnswer,
    readAnswer,
    correctsFor,
    CALENDAR_PREVIEW_WAIT_MS,
    calendarPrefillFrom,
    guestList,
    applyCalendarNames,
    setGuestChecked,
    touchGuests,
    nameInvitee,
    checkedGuestNames,
    inviteeEntries,
    INVITEE_NAMES_VERSION,
    buildInviteeNamesDoc,
    writeInviteeNames,
    readInviteeNames,
    writeLaterMarker,
    readLaterMarker,
    deleteLaterMarker,
    pendingIdentityStems,
    recentPendingIdentityStems,
    VOICE_NAMES_VERSION,
    buildVoiceNamesDoc,
    writeVoiceNamesAnswer,
    readNamingData,
    namingSettled,
    pendingVoiceNamingStems,
    recentPendingVoiceNamingStems,
    readVoiceNamesAnswer,
    assignVoice,
    mostRecentNamedStem,
    mostRecentCaptureStem,
};
