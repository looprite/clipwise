// The identity window's rules, with nothing under them but people-name.js
// (split out of identity-answer.js for SAA-243's window hardening): the answer
// documents and what they keep, the people field, the voices part, what the
// page keeps from the calendar preview, and the Mac's copy of assignVoice. No
// fs, no path, no Electron, no DOM. identity.html loads this file as a page
// script; main.js and the checks require it.
//
// Split out of main.js in the first place because it is the half of SAA-114
// with no Electron in it — parsing what someone typed, and shaping the file
// that carries it to ingest. Kept here it can be exercised directly, without a
// window and without a person to type into one; inside main.js it could only
// ever be verified by re-implementing it somewhere else, which verifies the
// re-implementation.
//
// Loaded either way by the wrapper below. Required, it requires people-name.js
// and exports through module.exports. As a page script, it takes people-name.js's
// global (that script is loaded first) and sets window.identityRules. The body
// is left unindented inside the wrapper so it reads line for line as it did in
// identity-answer.js.
//
// The reader is server/src/ingest/identity.ts. IDENTITY_VERSION is shared
// between them by hand, so bump both or neither.

(function (root, factory) {
    if (typeof module === 'object' && module && module.exports) module.exports = factory(require('./people-name.js'));
    else root.identityRules = factory(root.peopleName);
}(globalThis, function (peopleName) {

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
// full-screen prompt. Between the two bounds the window fits its content.
//
// SAA-260 step 4: the page itself never scrolls. Only the chip box does: it
// stops at four rows of chips and scrolls inside, and past two voices the rest
// are behind "Show them", so the content stays under the upper bound and Save
// and Skip are always on screen. 600 was measured on the one-field window at
// 460 wide: a group call with six chips, the "new" line, Recent, two voice rows
// and the footer needed 471 px, 498 with long names.
const IDENTITY_WINDOW = { width: 460, minHeight: 220, maxHeight: 600 };

function contentHeightFor(measured) {
    const h = Math.ceil(Number(measured));
    if (!Number.isFinite(h)) return IDENTITY_WINDOW.minHeight;
    return Math.min(IDENTITY_WINDOW.maxHeight, Math.max(IDENTITY_WINDOW.minHeight, h));
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
//
// SAA-260 step 4: `guests` is [{ name, personId? }], one per chip. personId is
// the person the chip stands for (picked from search or Recent, or kept from a
// saved answer). The server uses it only when the member may see that person
// (attendee-people.ts chosenPeople), and refuses the whole capture if one is
// not a uuid (captures.ts identitySchema), so only a uuid is written. The host
// name comes from the account (GET /captures/me, or its cache), hence
// account_display_name. IDENTITY_VERSION stays 2: the server takes personId at
// that version (captures.ts:126), and nothing compares the number.
function buildAnswerDoc({ stem, recordingId, guests, selfName, scope, answeredAt, corrects }) {
    const self = selfName && !hasAt(selfName) ? String(selfName).trim() || null : null;
    const out = [];
    for (const guest of guests || []) {
        const raw = guest && typeof guest.name === 'string' ? guest.name : '';
        if (hasAt(raw)) continue;
        const name = peopleName.normalizeName(raw);
        if (!name) continue;
        out.push(isUuid(guest.personId) ? { name, personId: guest.personId } : { name });
    }
    return {
        identity_version: IDENTITY_VERSION,
        recording_id: recordingId,
        stem,
        answered_at: answeredAt || new Date().toISOString(),
        self: {
            name: self,
            source: self ? 'account_display_name' : null,
        },
        guests: out,
        scope: scope === 'work' || scope === 'personal' ? scope : null,
        ...(corrects ? { corrects } : {}),
    };
}

// The uuid shape the server's schema accepts for guests[].personId: zod 3's
// z.string().uuid() (server node_modules/zod/v3/types.cjs:377, zod 3.25.76).
const UUID_PATTERN = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
function isUuid(value) {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

// Whether the people or the scope on Save differ from a saved answer (SAA-260
// step 4). Guests are compared as a set, each by its name key and personId as
// the answer file writes them (buildAnswerDoc: names normalised, a personId only
// when it is a uuid), so the same people in another order are no change.
function answerChanged(saved, guests, scope) {
    const keys = (list) => [...new Set(
        buildAnswerDoc({ stem: '', guests: list || [], selfName: null, scope: null }).guests
            .map((g) => JSON.stringify([peopleName.nameKey(g.name), g.personId || null])),
    )].sort();
    const scopeOf = (s) => (s === 'work' || s === 'personal' ? s : null);
    return JSON.stringify(keys(saved && saved.guests)) !== JSON.stringify(keys(guests))
        || scopeOf(saved && saved.scope) !== scopeOf(scope);
}

// A saved answer as the identity window may see it (identity:init): a guest
// whose name holds an @ is dropped, as buildAnswerDoc drops one, and so is a
// self name holding one, so an answer written before SAA-221 never puts an
// address on the page. Everything else as saved. Null stays null.
function answerForPage(saved) {
    if (!saved || typeof saved !== 'object') return null;
    const guests = (Array.isArray(saved.guests) ? saved.guests : [])
        .filter((g) => g && typeof g.name === 'string' && !hasAt(g.name));
    const self = saved.self && typeof saved.self === 'object' && typeof saved.self.name === 'string' && hasAt(saved.self.name)
        ? { ...saved.self, name: null }
        : saved.self;
    return { ...saved, self, guests };
}

// The naming data (voices-<stem>.json) as the identity window may see it: the
// fields of voice-clips.ts's NamingVoice and nothing else, whatever else the
// file holds. Per voice voiceIndex, clipPaths and lines; per line text, start
// and end (voice-clips.ts:183, `lines: Array<{ text: string; start: number;
// end: number }>`), copied as they are. Null when it has no voices list.
function namingDataForPage(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.voices)) return null;
    return {
        voices: data.voices
            .filter((v) => v && Number.isInteger(v.voiceIndex))
            .map((v) => ({
                voiceIndex: v.voiceIndex,
                clipPaths: (Array.isArray(v.clipPaths) ? v.clipPaths : []).filter((p) => typeof p === 'string'),
                lines: (Array.isArray(v.lines) ? v.lines : [])
                    .filter((l) => l && typeof l.text === 'string')
                    .map((l) => ({ text: l.text, start: l.start, end: l.end })),
            })),
    };
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

// --- the calendar's guests (SAA-221) ----------------------------------------
//
// At stop, main.js asks the server (POST /captures/calendar-preview) who the
// calendar says the call was with. calendarPrefillFrom keeps only what the page
// may use from the reply. The page turns it into chips (applyInvitees, in the
// people field below).

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

// --- the people field (SAA-260 step 4) ---------------------------------------
//
// The window's one field: a chip per person on the call. identity.html renders
// it and calls these on each click and keystroke; nothing here touches a DOM,
// so check-calendar-prefill.js runs the same rules without a window. Names are
// compared as the server compares them (people-name.js, a copy of
// capture-people.ts's nameKey), so one chip is one person to ingest's same-name
// rule too.
//
// A chip: { id, name, email, personId, tag, typed }
//   name      the normalised name, or null for an invitee known only by address
//             until the member names it
//   email     that invitee's address, else null. It is never sent in the
//             identity answer: only as a name-once pair, and only for a name the
//             member typed (inviteePairs)
//   personId  the person the chip stands for: picked from search or Recent,
//             matched exactly by a search, or kept from a saved answer. Else null
//   tag       'invited' (from the calendar), 'new' (typed, and the search
//             answered without that name), 'not checked' (typed while the search
//             could not answer), or null
//   typed     the name was typed, not picked: an address chip named this way
//             sends a name-once pair
// The host's own name (the account's display name, or the cached one) never
// becomes a chip, whichever way it arrives: typed, picked (the backfilled person
// carrying the member's name), invited, or in a saved answer.

// More invitees than this and the calendar's list is one chip, "N invited · not
// confirmed", kept as invitees and not as attendees (decided 10-31; a safeguard,
// untuned: no past capture has had more than 4 besides the owner).
const LARGE_CALL_INVITEES = 6;

function peopleField({ hostNames = [] } = {}) {
    const hostKeys = new Set();
    for (const n of hostNames) {
        const key = peopleName.nameKey(n);
        if (key) hostKeys.add(key);
    }
    return { chips: [], large: null, hostKeys, nextId: 1 };
}

function chipKey(chip) {
    return chip.name ? peopleName.nameKey(chip.name) : null;
}
function chipByKey(field, key) {
    return field.chips.find((c) => chipKey(c) === key) || null;
}
function pushChip(field, fields) {
    const chip = { id: field.nextId++, name: null, email: null, personId: null, tag: null, typed: false, ...fields };
    field.chips.push(chip);
    return chip;
}

// The calendar preview's invitees (calendarPrefillFrom's named and unnamed), at
// most once per window.
function applyInvitees(field, prefill) {
    if (!prefill) return;
    const named = (prefill.named || []).filter((n) => typeof n === 'string' && !hasAt(n));
    const unnamed = (prefill.unnamed || []).filter((e) => typeof e === 'string' && hasAt(e));
    if (named.length + unnamed.length > LARGE_CALL_INVITEES) {
        field.large = { count: named.length + unnamed.length, named, unnamed };
        return;
    }
    for (const n of named) addInvitedName(field, n);
    for (const email of unnamed) addInvitedAddress(field, email);
}
function addInvitedName(field, raw) {
    const name = peopleName.normalizeName(raw);
    const key = name && peopleName.nameKey(name);
    if (!name || field.hostKeys.has(key) || chipByKey(field, key)) return null;
    return pushChip(field, { name, tag: 'invited' });
}
function addInvitedAddress(field, raw) {
    const email = String(raw).trim().toLowerCase();
    if (!email || field.chips.some((c) => c.email === email)) return null;
    return pushChip(field, { email, tag: 'invited' });
}

function largeCallLabel(field) {
    return field.large ? `${field.large.count} invited · not confirmed` : null;
}
// "Show the N": each large-call invitee not yet a chip, as a suggestion ({ name }
// or { email }). Adding one makes an ordinary "invited" chip.
function largeCallSuggestions(field) {
    if (!field.large) return [];
    const names = field.large.named.filter((n) => {
        const key = peopleName.nameKey(n);
        return key && !field.hostKeys.has(key) && !chipByKey(field, key);
    }).map((name) => ({ name }));
    const emails = field.large.unnamed.filter((e) => !field.chips.some((c) => c.email === e.toLowerCase())).map((email) => ({ email }));
    return [...names, ...emails];
}
function addSuggestion(field, suggestion) {
    if (!suggestion) return null;
    if (suggestion.name) return addInvitedName(field, suggestion.name);
    if (suggestion.email) return addInvitedAddress(field, suggestion.email);
    return null;
}

// A person picked from search or Recent. -> { chip } or { refused }.
function addPerson(field, person) {
    const name = peopleName.normalizeName(person && person.name);
    if (!name) return { refused: 'empty' };
    const key = peopleName.nameKey(name);
    if (field.hostKeys.has(key)) return { refused: 'host' };
    const id = isUuid(person.id) ? person.id : null;
    const same = (id && field.chips.find((c) => c.personId === id)) || chipByKey(field, key);
    if (same) {
        if (id && !same.personId) { same.personId = id; same.tag = same.tag === 'invited' ? 'invited' : null; same.typed = false; }
        return { chip: same };
    }
    return { chip: pushChip(field, { name, personId: id }) };
}

// What a typed name becomes, given what the search said: exactly one result with
// the same name is that person; two or more, a name only (ingest's same-name
// rule leaves it unlinked, correct or absent); none, "new" if the search
// answered and "not checked" if it could not.
function resolveTyped(field, text, search) {
    if (hasAt(text)) return { refused: 'at' };
    const name = peopleName.normalizeName(text);
    if (!name) return { refused: 'empty' };
    const key = peopleName.nameKey(name);
    if (field.hostKeys.has(key)) return { refused: 'host' };
    const results = (search && Array.isArray(search.results)) ? search.results : [];
    const ids = [...new Set(results.filter((r) => peopleName.nameKey(r && r.name) === key && !field.hostKeys.has(key)).map((r) => r.id))];
    if (ids.length === 1) return { name: peopleName.normalizeName(results.find((r) => r.id === ids[0]).name), personId: isUuid(ids[0]) ? ids[0] : null, tag: null, typed: false };
    if (ids.length > 1) return { name, personId: null, tag: null, typed: true };
    return { name, personId: null, tag: search && search.searched ? 'new' : 'not checked', typed: true };
}
function addTyped(field, text, search) {
    const r = resolveTyped(field, text, search);
    if (r.refused) return r;
    const existing = (r.personId && field.chips.find((c) => c.personId === r.personId)) || chipByKey(field, peopleName.nameKey(r.name));
    if (existing) {
        if (r.personId && !existing.personId) { existing.personId = r.personId; existing.tag = existing.tag === 'invited' ? 'invited' : null; existing.typed = false; }
        return { chip: existing };
    }
    return { chip: pushChip(field, { name: r.name, personId: r.personId, tag: r.tag, typed: r.typed }) };
}

// Naming an invitee known only by address: typed text (with the search's answer)
// or a picked person ({ id, name }). A picked person sends their personId and no
// name-once pair; typed text sends a pair. A name another chip already has is
// refused ('duplicate'), so one person is never two chips.
function nameAddress(field, chipId, value, search) {
    const chip = field.chips.find((c) => c.id === chipId && c.email);
    if (!chip) return { refused: 'no_chip' };
    let r;
    if (value && typeof value === 'object') {
        const name = peopleName.normalizeName(value.name);
        if (!name) return { refused: 'empty' };
        if (field.hostKeys.has(peopleName.nameKey(name))) return { refused: 'host' };
        r = { name, personId: isUuid(value.id) ? value.id : null, tag: chip.tag, typed: false };
    } else {
        r = resolveTyped(field, value, search);
        if (r.refused) return r;
        if (!r.typed) r.tag = chip.tag;
    }
    const other = field.chips.find((c) => c !== chip && ((r.personId && c.personId === r.personId) || chipKey(c) === peopleName.nameKey(r.name)));
    if (other) return { refused: 'duplicate' };
    Object.assign(chip, { name: r.name, personId: r.personId, tag: r.tag, typed: r.typed });
    return { chip };
}

function removeChip(field, chipId) {
    field.chips = field.chips.filter((c) => c.id !== chipId);
}

function newNameLine(field) {
    const chip = field.chips.find((c) => c.tag === 'new' && c.name);
    return chip ? `${chip.name} is someone new. Check the spelling before saving.` : null;
}

// Search results or the Recent row, less the host's name and anyone already on a
// chip, in the server's order (most recently seen first), at most `limit`.
function filterSuggestions(field, people, limit = 4) {
    const seen = new Set();
    const out = [];
    for (const p of people || []) {
        const key = peopleName.nameKey(p && p.name);
        if (!key || field.hostKeys.has(key) || seen.has(p.id)) continue;
        if (field.chips.some((c) => (c.personId && c.personId === p.id) || chipKey(c) === key)) continue;
        seen.add(p.id);
        out.push({ id: p.id, name: peopleName.normalizeName(p.name) });
        if (out.length >= limit) break;
    }
    return out;
}

// What Save sends. Only chips with a name; the large-call chip and an unnamed
// address are not attendees (invited is not attended).
function answerGuests(field) {
    return field.chips.filter((c) => c.name).map((c) => (isUuid(c.personId) ? { name: c.name, personId: c.personId } : { name: c.name }));
}
function inviteePairs(field) {
    return field.chips.filter((c) => c.email && c.name && c.typed).map((c) => ({ email: c.email, name: c.name }));
}

// Any text that would carry an @ blocks Save (SAA-221): the field's text box and
// an address chip's name box.
function saveBlocked(texts) {
    return (texts || []).some((t) => String(t || '').trim().includes('@'));
}

// The footer, and where the host's name comes from: the account's display name
// when GET /captures/me answers with one, else the last one cached
// (identity-self.json), else none.
function usableHostName(raw) {
    if (typeof raw !== 'string') return null;
    const name = raw.trim();
    return name && !name.includes('@') ? name : null;
}
function recordedByLine(name) {
    const n = usableHostName(name);
    return n ? `Recorded by ${n} (you)` : 'Recorded by you';
}
function selfNameFrom(me, cached) {
    return usableHostName(me && me.displayName) || usableHostName(cached) || null;
}

// A saved answer, reopened (Change attendees…, Name voices / Fix names): its
// guests as chips, a valid personId kept, the host's name never a chip.
function peopleFieldFromAnswer(saved, { hostNames = [] } = {}) {
    const field = peopleField({ hostNames });
    for (const guest of (saved && Array.isArray(saved.guests) ? saved.guests : [])) {
        const name = peopleName.normalizeName(guest && guest.name);
        const key = name && peopleName.nameKey(name);
        if (!name || field.hostKeys.has(key) || chipByKey(field, key)) continue;
        pushChip(field, { name, personId: isUuid(guest.personId) ? guest.personId : null });
    }
    return field;
}

// --- the voices part (SAA-260 step 4) ------------------------------------------
//
// Group calls only: the voices diarize found, once their naming data exists.
// Each row: a clip, "Voice N" with its talk time (diarize-<stem>.json's
// totalSeconds; the naming data has none), and a choice among the people on
// chips, "Leave unnamed" and "Add someone…". Longest first; past `shown`, the
// rest are behind "Show them".

const LEAVE_UNNAMED = 'Leave unnamed';
const ADD_SOMEONE = 'Add someone…';

function showVoicesPart(namingData) {
    return !!namingData && Array.isArray(namingData.voices) && namingData.voices.length >= 2;
}
function talkTime(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    return s < 60 ? `${s} sec` : `${Math.round(s / 60)} min`;
}
function voiceRows(namingData, diarize, shown = 2) {
    const secs = new Map(((diarize && diarize.voices) || []).map((v) => [v.voiceIndex, Number(v.totalSeconds) || 0]));
    const all = ((namingData && namingData.voices) || []).map((v) => ({
        voiceIndex: v.voiceIndex,
        clipPaths: Array.isArray(v.clipPaths) ? v.clipPaths : [],
        lines: Array.isArray(v.lines) ? v.lines : [],
        seconds: secs.get(v.voiceIndex) || 0,
        talk: talkTime(secs.get(v.voiceIndex) || 0),
    })).sort((a, b) => b.seconds - a.seconds || a.voiceIndex - b.voiceIndex);
    const n = Math.max(0, shown);
    return { rows: all.slice(0, n), hidden: Math.max(0, all.length - n), all };
}
function voiceOptions(field) {
    return [...field.chips.filter((c) => c.name).map((c) => c.name), LEAVE_UNNAMED, ADD_SOMEONE];
}
// voiceIndex -> name | null. A name chosen for one voice moves off any other
// voice that had it (SAA-195): no two voices share a name.
function chooseVoice(choices, voiceIndex, name) {
    choices.set(voiceIndex, name || null);
    if (!name) return choices;
    const key = peopleName.nameKey(name);
    for (const [other, otherName] of choices) {
        if (other !== voiceIndex && otherName && peopleName.nameKey(otherName) === key) choices.set(other, null);
    }
    return choices;
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

return {
    IDENTITY_VERSION,
    IDENTITY_WINDOW,
    contentHeightFor,
    buildAnswerDoc,
    answerChanged,
    answerForPage,
    namingDataForPage,
    correctsFor,
    CALENDAR_PREVIEW_WAIT_MS,
    calendarPrefillFrom,
    isUuid,
    LARGE_CALL_INVITEES,
    peopleField,
    applyInvitees,
    largeCallLabel,
    largeCallSuggestions,
    addSuggestion,
    addPerson,
    addTyped,
    nameAddress,
    removeChip,
    newNameLine,
    filterSuggestions,
    answerGuests,
    inviteePairs,
    saveBlocked,
    recordedByLine,
    selfNameFrom,
    peopleFieldFromAnswer,
    LEAVE_UNNAMED,
    ADD_SOMEONE,
    showVoicesPart,
    voiceRows,
    voiceOptions,
    chooseVoice,
    INVITEE_NAMES_VERSION,
    buildInviteeNamesDoc,
    VOICE_NAMES_VERSION,
    buildVoiceNamesDoc,
    assignVoice,
};
}));
