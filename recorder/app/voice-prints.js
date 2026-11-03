// Voice prints kept on this Mac, watch only (SAA-260 step 3, SAA-196).
//
// Off by default; turned on only from the opt-in screen (voice-prints.html),
// which records the statement version the member agreed to. While off, nothing
// here enrols, matches or logs. Turning it off writes the setting off first,
// then deletes every print kept here for recognising people (the store, the
// score log and any waiting host print), then removes the per-voice embedding
// from each recording's diarize file (SAA-243 item 7). The recordings
// themselves are otherwise untouched. While off, the same pass runs at launch,
// so a turn-off cut short is finished, and for a capture's stem when its
// pipeline ends, for a pipeline started while prints were still on.
//
// Everything lives in SUPPORT_DIR/voice-prints/ (folder mode 700, files 600):
//   setting.json   { enabled, statementVersion, consentedAt | turnedOffAt },
//                  plain: it holds no voice data
//   profiles.json  the prints, encrypted with the function main.js passes in
//                  (Electron safeStorage, as the capture token is). Inside:
//                  { version, self, people: { <personId>: profile } }, where a
//                  profile is { name, embedding, count, sources: [{ stem,
//                  voice, vec }] }: embedding is the normalised mean of its
//                  sources' normalised vectors, count is how many there are.
//                  self is the member's own print, from diarize's
//                  host-print-<stem>.json
//   scores.jsonl   the matcher's log (voice-match.js), plain: person ids,
//                  scores and stems only, never a name or an embedding
//
// Nothing in this folder is ever uploaded. The server only ever sends person
// ids back (POST /captures' `people`), and the capture body is built from the
// recordings folder alone (capture-payload.js). check-capture-payload.js and
// check-voice-prints.js check both.
//
// Enrolment is on a confirmed name only, correct or absent:
//   Voice N   the person the server put on that voice (the voice-names copy
//             from the attendee row, server/src/ingest/voice-names.ts)
//   them      on a call diarize heard as exactly one voice, whose answer names
//             exactly one guest, when the server gives that guest's person
// Refused: a voice with no person (the name was left unlinked, "Not sure", or
// someone the server does not know), `them` when diarize heard two or more
// voices (they were merged), and a voice that matches the member's own print
// at or above SELF_MATCH_CUTOFF (the member's own voice, under any name).
//
// A capture's contributions are replaced as a whole each time its mapping
// arrives, so a correction that unnames a voice takes that voice out, and the
// same mapping twice changes nothing. Deleting a recording takes out its
// contributions and its score lines.

const fs = require('fs');
const path = require('path');

// The opt-in screen's statement (voice-prints.html). Bump with its text.
const STATEMENT_VERSION = 1;
// diarize's hostEchoCosineThreshold (recorder/diarize/Sources/diarize/main.swift):
// a tap voice this close to the member's own print is the member.
const SELF_MATCH_CUTOFF = 0.55;
const STORE_VERSION = 1;
const STEM = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

function norm(v) {
    let s = 0;
    for (const x of v) s += x * x;
    return Math.sqrt(s);
}

// The unit vector, or null for an empty, non-numeric or all-zero one.
function normalise(v) {
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    const n = norm(v);
    return n > 0 ? v.map((x) => x / n) : null;
}

function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return null;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    const d = norm(a) * norm(b);
    return d > 0 ? dot / d : null;
}

// The normalised mean of unit vectors, or null when there are none.
function meanOf(vecs) {
    const ok = vecs.filter((v) => Array.isArray(v) && v.length > 0);
    if (ok.length === 0) return null;
    const dim = ok[0].length;
    const sum = new Array(dim).fill(0);
    for (const v of ok) {
        if (v.length !== dim) continue;
        for (let i = 0; i < dim; i++) sum[i] += v[i];
    }
    return normalise(sum);
}

function withTotals(profile) {
    profile.embedding = meanOf(profile.sources.map((s) => s.vec));
    profile.count = profile.sources.length;
    return profile;
}

function isPersonId(x) {
    return typeof x === 'string' && /^[0-9a-f-]{8,64}$/i.test(x);
}

// Which voices of one capture to enrol, and which to refuse with a reason. Pure.
//   voices     diarize's voices: [{ voiceIndex, embedding }]
//   mapping    the server's `people`: { voices: [{ voiceIndex, personId }], them }
//   guestCount how many guests the capture's answer names
//   self       the member's own print (a unit vector) or null
// -> { enrol: [{ voice, voiceIndex, personId, vec }], refused: [{ voice, reason }] }
// voice is the voice's index, or 'them' for the 1:1 track.
function decideEnrolment({ voices, mapping, guestCount, self }) {
    const enrol = [];
    const refused = [];
    const byIndex = new Map((Array.isArray(voices) ? voices : []).map((v) => [v.voiceIndex, v]));
    const mapped = Array.isArray(mapping && mapping.voices) ? mapping.voices.filter((m) => m && Number.isInteger(m.voiceIndex) && isPersonId(m.personId)) : [];
    const selfScore = (vec) => (self ? cosine(vec, self) : null);
    const consider = (voice, voiceIndex, personId, embedding) => {
        const vec = normalise(embedding);
        if (!vec) return refused.push({ voice, reason: 'no_embedding' });
        const s = selfScore(vec);
        if (s !== null && s >= SELF_MATCH_CUTOFF) return refused.push({ voice, reason: 'matches_own_print' });
        enrol.push({ voice, voiceIndex, personId, vec });
    };
    for (const m of mapped) {
        const v = byIndex.get(m.voiceIndex);
        if (!v) { refused.push({ voice: m.voiceIndex, reason: 'no_diarize_voice' }); continue; }
        consider(m.voiceIndex, m.voiceIndex, m.personId, v.embedding);
    }
    const mappedIndexes = new Set(mapped.map((m) => m.voiceIndex));
    const them = mapping && isPersonId(mapping.them) && mapped.length === 0 ? mapping.them : null;
    if (them) {
        if (byIndex.size === 0) refused.push({ voice: 'them', reason: 'no_diarize_voice' });
        else if (byIndex.size > 1) refused.push({ voice: 'them', reason: 'them_is_several_voices' });
        else if (guestCount !== 1) refused.push({ voice: 'them', reason: 'them_not_one_guest' });
        else {
            const only = [...byIndex.values()][0];
            mappedIndexes.add(only.voiceIndex);
            consider('them', only.voiceIndex, them, only.embedding);
        }
    }
    for (const v of byIndex.values()) {
        if (!mappedIndexes.has(v.voiceIndex)) refused.push({ voice: v.voiceIndex, reason: 'no_person' });
    }
    return { enrol, refused };
}

function readJsonIn(dir, name) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

function cleanName(x) {
    return typeof x === 'string' && x.trim() ? x.trim().replace(/\s+/g, ' ') : null;
}

// diarize-<stem>.json and the early run's diarize-<stem>.json.early.
const DIARIZE_FILE = /^diarize-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.json(\.early)?$/;

// Removes voices[].embedding from the recordings folder's diarize files,
// keeping everything else: each file that holds one is written again, less
// that key, to a temp file beside it (same mode), then renamed over it. A file
// with no embedding is not written. Never throws: a file that cannot be read
// or written is counted in `failed` and left as it was.
//   stem  only that capture's files; otherwise every capture's
//   skip  (stem) -> true for a capture to leave alone (its pipeline is running)
// -> { files, changed, skipped, failed }
function removeDiarizeEmbeddings(outdir, { stem = null, skip = () => false } = {}) {
    const out = { files: 0, changed: 0, skipped: 0, failed: 0 };
    let names = [];
    try { names = fs.readdirSync(outdir); } catch { return out; }
    for (const name of names) {
        const m = DIARIZE_FILE.exec(name);
        if (!m || (stem && m[1] !== stem)) continue;
        out.files++;
        if (skip(m[1])) { out.skipped++; continue; }
        const file = path.join(outdir, name);
        const tmp = `${file}.strip`;
        try {
            const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
            const voices = doc && Array.isArray(doc.voices) ? doc.voices : [];
            if (!voices.some((v) => v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'embedding'))) continue;
            for (const v of voices) if (v && typeof v === 'object') delete v.embedding;
            const mode = fs.statSync(file).mode & 0o777;
            fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode });
            fs.chmodSync(tmp, mode);
            fs.renameSync(tmp, file);
            out.changed++;
        } catch {
            out.failed++;
            try { fs.rmSync(tmp, { force: true }); } catch {}
        }
    }
    return out;
}

// Which captures the removal leaves alone, from main.js's state. While a
// recovery pass runs, every one: main.js does not know which capture it is on,
// and its exit runs the pass again. Otherwise the capture whose pipeline is
// running, unless that is the process that just ended (its own exit's pass).
function removalSkip({ pipeline, recovering, endedProc = null }) {
    const running = pipeline && pipeline.state === 'running' && pipeline.proc !== endedProc ? pipeline.stem : null;
    return (stem) => !!recovering || (running !== null && stem === running);
}

// The removal while off as main.js runs it, at launch, at a pipeline exit and
// at a recovery exit. Never throws, whatever getStore or the pass throws, so a
// launch always finishes. The day log gets counts, or one fixed line on a
// failure: never a name, a path or an error message. reason is one of
// REMOVAL_REASONS, anything else is logged as "other".
//   getStore () -> createVoicePrints(...)'s store
//   log      (line) -> undefined
const REMOVAL_REASONS = ['launch', 'pipeline exit', 'recovery exit'];
function runRemovalWhileOff(getStore, { reason, stem = null, skip, log }) {
    const why = REMOVAL_REASONS.includes(reason) ? reason : 'other';
    try {
        const r = getStore().removeWhileOff({ stem, skip });
        if (r.skipped) return r;
        const e = r.embeddings;
        if (r.profiles || r.scores || r.hostPrints || e.changed || e.skipped || e.failed) {
            log(`[clipwise-recorder] voice prints off (${why}): store ${r.profiles ? 'deleted' : 'none'}, score log ${r.scores ? 'deleted' : 'none'}, host prints ${r.hostPrints}, `
                + `embeddings removed from ${e.changed} of ${e.files} diarize file(s), ${e.skipped} skipped, ${e.failed} failed`);
        }
        return r;
    } catch {
        try { log(`[clipwise-recorder] voice prints off (${why}): removal failed`); } catch {}
        return { failed: true };
    }
}

// The store. encrypt(string) -> Buffer and decrypt(Buffer) -> string are
// Electron safeStorage's in the app, and a stand-in in the checks.
function createVoicePrints({ supportDir, outdir, encrypt, decrypt, now = () => new Date() }) {
    if (typeof encrypt !== 'function' || typeof decrypt !== 'function') throw new Error('voice prints need encrypt and decrypt');
    const dir = path.join(supportDir, 'voice-prints');
    const settingPath = path.join(dir, 'setting.json');
    const profilesPath = path.join(dir, 'profiles.json');
    const scoresPath = path.join(dir, 'scores.jsonl');

    const ensureDir = () => {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
    };
    const writePrivate = (file, data) => {
        ensureDir();
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, data, { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
    };

    function setting() {
        try {
            const s = JSON.parse(fs.readFileSync(settingPath, 'utf8'));
            return s && typeof s === 'object' ? s : { enabled: false };
        } catch {
            return { enabled: false };
        }
    }
    function isEnabled() {
        const s = setting();
        return s.enabled === true && s.statementVersion === STATEMENT_VERSION;
    }
    function enable(statementVersion) {
        if (statementVersion !== STATEMENT_VERSION) throw new Error(`statement version ${statementVersion} is not ${STATEMENT_VERSION}`);
        writePrivate(settingPath, JSON.stringify({ enabled: true, statementVersion, consentedAt: now().toISOString() }) + '\n');
    }

    function emptyStore() {
        return { version: STORE_VERSION, self: null, people: {} };
    }
    function load() {
        let buf;
        try {
            buf = fs.readFileSync(profilesPath);
        } catch (err) {
            if (err.code === 'ENOENT') return emptyStore();
            throw err;
        }
        const store = JSON.parse(decrypt(buf));
        if (!store || store.version !== STORE_VERSION) throw new Error('voice prints: unknown store version');
        store.people = store.people || {};
        return store;
    }
    function save(store) {
        writePrivate(profilesPath, encrypt(JSON.stringify(store)));
    }

    function appendScoreLines(lines) {
        if (!lines.length) return;
        ensureDir();
        fs.appendFileSync(scoresPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });
        fs.chmodSync(scoresPath, 0o600);
    }
    function readScoreLines() {
        try {
            return fs.readFileSync(scoresPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        } catch (err) {
            if (err.code === 'ENOENT') return [];
            throw err;
        }
    }

    // Removes every host-print-<stem>.json in the recordings folder, or only
    // the given stem's.
    function removeHostPrints(stem = null) {
        let removed = 0;
        let names = [];
        try { names = fs.readdirSync(outdir); } catch { return 0; }
        for (const n of names) {
            if (stem ? n !== `host-print-${stem}.json` : !/^host-print-.+\.json$/.test(n)) continue;
            try { fs.unlinkSync(path.join(outdir, n)); removed++; } catch {}
        }
        return removed;
    }

    // With prints off: the store, the score log, waiting host prints and the
    // diarize files' embeddings are deleted. With a stem, only that capture's
    // host print and embeddings. Throws only if the store or score log is
    // there and cannot be deleted.
    function removeAllOff({ stem = null, skip = () => false } = {}) {
        const gone = { profiles: false, scores: false, hostPrints: 0, embeddings: null };
        if (!stem) {
            for (const [key, file] of [['profiles', profilesPath], ['scores', scoresPath]]) {
                try { fs.unlinkSync(file); gone[key] = true; } catch (err) { if (err.code !== 'ENOENT') throw err; }
            }
        }
        gone.hostPrints = removeHostPrints(stem);
        gone.embeddings = removeDiarizeEmbeddings(outdir, { stem, skip });
        return gone;
    }

    // Turning prints off: the setting says off first, so a turn-off cut short
    // anywhere after it is finished by removeWhileOff at the next launch; then
    // every print, the score log, any waiting host print and each diarize
    // file's embeddings are deleted. skip as removeDiarizeEmbeddings's.
    function disable({ skip } = {}) {
        writePrivate(settingPath, JSON.stringify({ enabled: false, turnedOffAt: now().toISOString() }) + '\n');
        return removeAllOff({ skip });
    }

    // The pass that runs while off: at launch (everything) and when a
    // capture's pipeline ends (its stem). With prints on it does nothing.
    function removeWhileOff({ stem = null, skip } = {}) {
        if (isEnabled()) return { skipped: 'on' };
        if (stem !== null && !STEM.test(stem)) return { skipped: 'bad_stem' };
        return removeAllOff({ stem, skip });
    }

    // diarize's host-print-<stem>.json: the member's own print from this
    // capture, into `self`, then the file is deleted. While off, the file is
    // only deleted.
    function ingestHostPrint(stem) {
        if (!STEM.test(stem)) return 'bad_stem';
        const file = path.join(outdir, `host-print-${stem}.json`);
        if (!fs.existsSync(file)) return 'none';
        if (!isEnabled()) {
            fs.unlinkSync(file);
            return 'deleted_off';
        }
        let doc = null;
        try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
        const vec = normalise(doc && doc.embedding);
        if (vec) {
            const store = load();
            const self = store.self || { sources: [] };
            self.sources = self.sources.filter((s) => s.stem !== stem);
            self.sources.push({ stem, vec, seconds: typeof doc.seconds === 'number' ? doc.seconds : null });
            store.self = withTotals(self);
            save(store);
        }
        fs.unlinkSync(file);
        return vec ? 'ingested' : 'unreadable';
    }

    // The server's mapping for one capture -> its contributions, replacing
    // whatever that capture contributed before. Appends one `confirmed` line
    // per voice to the score log, the ground truth for setting a cut-off.
    function enrolFromMapping(stem, mapping) {
        if (!isEnabled()) return { skipped: 'off' };
        if (!STEM.test(stem)) return { skipped: 'bad_stem' };
        const diarized = readJsonIn(outdir, `diarize-${stem}.json`);
        if (!diarized || diarized.error || !Array.isArray(diarized.voices)) return { skipped: 'no_diarize_file' };
        const identity = readJsonIn(outdir, `identity-${stem}.json`);
        const voiceNames = readJsonIn(outdir, `voice-names-${stem}.json`);
        const guests = (identity && Array.isArray(identity.guests) ? identity.guests : []).map((g) => cleanName(g && g.name)).filter(Boolean);
        const store = load();
        const { enrol, refused } = decideEnrolment({
            voices: diarized.voices, mapping, guestCount: guests.length, self: store.self ? store.self.embedding : null,
        });
        const nameFor = (e) => {
            if (e.voice === 'them') return guests[0] || null;
            const entry = (voiceNames && Array.isArray(voiceNames.voices) ? voiceNames.voices : []).find((v) => v && v.voiceIndex === e.voiceIndex);
            return cleanName(entry && entry.name);
        };
        let removed = 0;
        for (const [pid, p] of Object.entries(store.people)) {
            const before = p.sources.length;
            p.sources = p.sources.filter((s) => s.stem !== stem);
            removed += before - p.sources.length;
            if (p.sources.length === 0) delete store.people[pid];
            else withTotals(p);
        }
        for (const e of enrol) {
            const p = store.people[e.personId] || { name: null, sources: [] };
            p.sources.push({ stem, voice: e.voice, vec: e.vec });
            p.name = nameFor(e) || p.name;
            store.people[e.personId] = withTotals(p);
        }
        save(store);
        const at = now().toISOString();
        appendScoreLines([
            ...enrol.map((e) => ({ kind: 'confirmed', at, stem, voice: e.voiceIndex, track: e.voice === 'them' ? 'them' : 'voice', personId: e.personId })),
            ...refused.map((r) => ({ kind: 'confirmed', at, stem, voice: r.voice, personId: null, reason: r.reason })),
        ]);
        return { enrolled: enrol.length, refused: refused.length, removed };
    }

    // One person's print, from the opt-in screen. A later confirmed name makes
    // a new one.
    function deleteProfile(personId) {
        const store = load();
        if (!store.people[personId]) return false;
        delete store.people[personId];
        save(store);
        return true;
    }

    // A recording deleted from the trash: its contributions and its score lines.
    function removeRecording(stem) {
        let changed = 0;
        if (fs.existsSync(profilesPath)) {
            const store = load();
            for (const [pid, p] of Object.entries(store.people)) {
                const before = p.sources.length;
                p.sources = p.sources.filter((s) => s.stem !== stem);
                changed += before - p.sources.length;
                if (p.sources.length === 0) delete store.people[pid];
                else withTotals(p);
            }
            if (store.self) {
                const before = store.self.sources.length;
                store.self.sources = store.self.sources.filter((s) => s.stem !== stem);
                changed += before - store.self.sources.length;
                store.self = store.self.sources.length ? withTotals(store.self) : null;
            }
            save(store);
        }
        const lines = readScoreLines();
        const kept = lines.filter((l) => l.stem !== stem);
        if (kept.length !== lines.length) {
            if (kept.length) writePrivate(scoresPath, kept.map((l) => JSON.stringify(l)).join('\n') + '\n');
            else fs.unlinkSync(scoresPath);
        }
        return { contributions: changed, scoreLines: lines.length - kept.length };
    }

    // For the opt-in screen: who has a print, by the last confirmed name.
    function listProfiles() {
        if (!fs.existsSync(profilesPath)) return { self: null, people: [] };
        const store = load();
        return {
            self: store.self ? { count: store.self.count } : null,
            people: Object.entries(store.people)
                .map(([personId, p]) => ({ personId, name: p.name, count: p.count }))
                .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
        };
    }

    // For the matcher: each profile, and the member's own, without the given
    // capture's contributions, so a capture never matches against itself.
    function matchProfiles(excludeStem) {
        const store = load();
        const people = [];
        for (const [id, p] of Object.entries(store.people)) {
            const embedding = meanOf(p.sources.filter((s) => s.stem !== excludeStem).map((s) => s.vec));
            if (embedding) people.push({ id, embedding });
        }
        const self = store.self ? meanOf(store.self.sources.filter((s) => s.stem !== excludeStem).map((s) => s.vec)) : null;
        return { people, self };
    }

    return {
        dir, settingPath, profilesPath, scoresPath,
        setting, isEnabled, enable, disable, removeWhileOff, load, ingestHostPrint, enrolFromMapping,
        deleteProfile, removeRecording, listProfiles, matchProfiles, appendScoreLines, readScoreLines,
    };
}

module.exports = {
    STATEMENT_VERSION, SELF_MATCH_CUTOFF, normalise, cosine, meanOf, decideEnrolment,
    removeDiarizeEmbeddings, removalSkip, runRemovalWhileOff, createVoicePrints,
};
