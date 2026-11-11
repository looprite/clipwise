#!/usr/bin/env node
// Voice prints on this Mac (SAA-260 step 3): kept, refused, deleted and turned
// off as decided, and encrypted on disk.
//
//   node check-voice-prints.js
//
// Cases 1-21 run voice-prints.js against temporary folders, with a stand-in for
// Electron's safeStorage (an XOR and base64, reversible, so the file on disk
// holds no plaintext). Embeddings are made-up 256-number vectors: a person's
// two calls are one base vector plus small noise; different people are
// unrelated. Cases 22-25 read main.js and build-app.sh as text: they show the
// wiring is there, not that it runs. Cases 26-34 run the removal of each
// diarize file's per-voice embedding while prints are off (SAA-243 item 7)
// against temporary folders, with files the shape diarize writes. Cases 43-47
// run the mic box's two effects on the member's own print (SAA-260 11-07): a
// shared call's host print skipped, and a call's contribution removed. The module
// is required inside main(), so on code without it every case is reported as a
// FAIL.

const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `\n     ${detail}`}`);
    if (!ok) failures++;
}

// Deterministic made-up vectors.
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 2 ** 32 - 0.5;
    };
}
const vector = (seed, scale = 1) => { const r = rng(seed); return Array.from({ length: 256 }, () => r() * scale); };
const plus = (a, b) => a.map((x, i) => x + b[i]);
const ANN = vector(11);
const BOB = vector(22);
const SELF = vector(33);
const annCall = (n) => plus(ANN, vector(100 + n, 0.15));

// The stand-in for safeStorage.
const KEY = Buffer.from('stand-in key for the check only');
const xor = (buf) => Buffer.from(buf.map((b, i) => b ^ KEY[i % KEY.length]));
const encrypt = (s) => Buffer.from(xor(Buffer.from(s, 'utf8')).toString('base64'), 'ascii');
const decrypt = (b) => xor(Buffer.from(b.toString('ascii'), 'base64')).toString('utf8');

const STEM1 = '2026-10-31T10-00-00Z';
const STEM2 = '2026-10-31T11-00-00Z';
const STEM3 = '2026-10-31T12-00-00Z';
const P_ANN = '11111111-1111-4111-8111-111111111111';
const P_BOB = '22222222-2222-4222-8222-222222222222';

function fixture() {
    const support = fs.mkdtempSync(path.join(os.tmpdir(), 'check-voice-prints-'));
    const outdir = path.join(support, 'recordings');
    fs.mkdirSync(outdir);
    const write = (name, doc) => fs.writeFileSync(path.join(outdir, name), JSON.stringify(doc));
    return { support, outdir, write };
}
// A capture's files: diarize voices, the answer's guests, the voice names.
function capture(fx, stem, { voices, guests = [], voiceNames = null }) {
    fx.write(`diarize-${stem}.json`, { model: 'fluidaudio-community-1', modelRevision: 'r', voices, segments: [] });
    fx.write(`identity-${stem}.json`, { self: { name: 'Check Host' }, guests: guests.map((name) => ({ name })) });
    if (voiceNames) fx.write(`voice-names-${stem}.json`, { answered_at: 'x', voices: voiceNames });
}
const v = (voiceIndex, embedding, totalSeconds = 30) => ({ voiceIndex, totalSeconds, embedding, clipRanges: [] });

function main() {
    let mod = null;
    let why = '';
    try {
        mod = require('./voice-prints.js');
    } catch (err) {
        why = `module not present (${err.code || err.name})`;
    }
    const SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const BUILD = fs.readFileSync(path.join(__dirname, 'build-app.sh'), 'utf8');

    const cases = [];
    const add = (name, fn) => cases.push([name, fn]);

    const open = (fx) => mod.createVoicePrints({ supportDir: fx.support, outdir: fx.outdir, encrypt, decrypt });
    const on = (fx) => { const vp = open(fx); vp.enable(mod.STATEMENT_VERSION); return vp; };
    // A first qualifying call for each person, through enrolFromMapping on its
    // own stem (SAA-275 part 2): a print is kept from the second call, so a case
    // about what a call does to a print needs one before it. Its voices are
    // unrelated to every other vector here, and no print keeps them. Before the
    // tally (66e367e, no tallyPath) one call already made a print, so there it
    // does nothing and those cases run as they always did.
    const STEM0 = '2026-10-30T09-00-00Z';
    const firstCall = (fx, vp, ...ids) => {
        if (!vp.tallyPath) return null;
        capture(fx, STEM0, { voices: ids.map((_, i) => v(i + 1, vector(900 + i))), guests: ids.map((_, i) => `Earlier ${i + 1}`) });
        return vp.enrolFromMapping(STEM0, { voices: ids.map((personId, i) => ({ voiceIndex: i + 1, personId })), them: null });
    };

    add('1. off by default: no setting file means off, and enrolling writes nothing', () => {
        const fx = fixture();
        const vp = open(fx);
        capture(fx, STEM1, { voices: [v(1, ANN)], guests: ['Ann Example'], voiceNames: [{ voiceIndex: 1, name: 'Ann Example' }] });
        const r = vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        return [!vp.isEnabled() && r.skipped === 'off' && !fs.existsSync(vp.dir), JSON.stringify(r)];
    });
    add('2. control: turned on, the same mapping enrols Ann (count 1, her name kept)', () => {
        const fx = fixture();
        const vp = on(fx);
        firstCall(fx, vp, P_ANN);
        capture(fx, STEM1, { voices: [v(1, ANN)], guests: ['Ann Example'], voiceNames: [{ voiceIndex: 1, name: 'Ann Example' }] });
        const r = vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        const list = vp.listProfiles().people;
        return [r.enrolled === 1 && list.length === 1 && list[0].personId === P_ANN && list[0].count === 1 && list[0].name === 'Ann Example', JSON.stringify({ r, list })];
    });
    add('3. a second call averages the normalised contributions (count 2), and the profile stays a unit vector close to both', () => {
        const fx = fixture();
        const vp = on(fx);
        firstCall(fx, vp, P_ANN);
        capture(fx, STEM1, { voices: [v(1, annCall(1))], guests: ['Ann Example'], voiceNames: [{ voiceIndex: 1, name: 'Ann Example' }] });
        capture(fx, STEM2, { voices: [v(1, annCall(2), 200)], guests: ['Ann Example'], voiceNames: [{ voiceIndex: 1, name: 'Ann Example' }] });
        vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        vp.enrolFromMapping(STEM2, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        const p = vp.load().people[P_ANN];
        const n = Math.sqrt(p.embedding.reduce((s, x) => s + x * x, 0));
        const c1 = mod.cosine(p.embedding, annCall(1));
        const c2 = mod.cosine(p.embedding, annCall(2));
        return [p.count === 2 && Math.abs(n - 1) < 1e-9 && c1 > 0.95 && c2 > 0.95 && Math.abs(c1 - c2) < 0.02, `count ${p.count} norm ${n} cos ${c1} ${c2}`];
    });
    add('4. the same mapping again changes nothing (count stays 1)', () => {
        const fx = fixture();
        const vp = on(fx);
        firstCall(fx, vp, P_ANN);
        capture(fx, STEM1, { voices: [v(1, ANN)], guests: ['Ann Example'] });
        const m = { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null };
        vp.enrolFromMapping(STEM1, m);
        const before = JSON.stringify(vp.load());
        const r = vp.enrolFromMapping(STEM1, m);
        return [JSON.stringify(vp.load()) === before && r.removed === 1 && r.enrolled === 1, JSON.stringify(r)];
    });
    add('5. a correction that unnames a voice takes its contribution out; control: the other voice stays', () => {
        const fx = fixture();
        const vp = on(fx);
        firstCall(fx, vp, P_ANN, P_BOB);
        capture(fx, STEM1, { voices: [v(1, ANN), v(2, BOB)], guests: ['Ann Example', 'Bob Example'] });
        vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }, { voiceIndex: 2, personId: P_BOB }], them: null });
        const both = Object.keys(vp.load().people).sort().join(',');
        vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        const after = Object.keys(vp.load().people).join(',');
        return [both === [P_ANN, P_BOB].sort().join(',') && after === P_ANN, `${both} -> ${after}`];
    });
    add('6. refused: a voice the server gave no person (unlinked, "Not sure" or unknown)', () => {
        const fx = fixture();
        const vp = on(fx);
        capture(fx, STEM1, { voices: [v(1, ANN)], guests: ['Ann Example'] });
        const r = vp.enrolFromMapping(STEM1, { voices: [], them: null });
        const lines = vp.readScoreLines();
        return [r.enrolled === 0 && Object.keys(vp.load().people).length === 0 && lines.some((l) => l.kind === 'confirmed' && l.reason === 'no_person'), JSON.stringify({ r, lines })];
    });
    add('7. refused: `them` on a call diarize heard as two voices (merged)', () => {
        const fx = fixture();
        const vp = on(fx);
        capture(fx, STEM1, { voices: [v(1, ANN), v(2, BOB)], guests: ['Ann Example'] });
        const r = vp.enrolFromMapping(STEM1, { voices: [], them: P_ANN });
        const lines = vp.readScoreLines();
        return [r.enrolled === 0 && lines.some((l) => l.voice === 'them' && l.reason === 'them_is_several_voices'), JSON.stringify({ r, lines })];
    });
    add('8. control: `them` on a call diarize heard as one voice, one guest named, is enrolled', () => {
        const fx = fixture();
        const vp = on(fx);
        firstCall(fx, vp, P_ANN);
        capture(fx, STEM1, { voices: [v(1, ANN)], guests: ['Ann Example'] });
        const r = vp.enrolFromMapping(STEM1, { voices: [], them: P_ANN });
        const p = vp.load().people[P_ANN];
        return [r.enrolled === 1 && p && p.count === 1 && p.name === 'Ann Example' && p.sources[0].voice === 'them', JSON.stringify(r)];
    });
    add('9. refused: a voice that matches the member\'s own print (0.55 or more), even with a person id', () => {
        const fx = fixture();
        const vp = on(fx);
        fx.write(`host-print-${STEM1}.json`, { model: 'm', modelRevision: 'r', seconds: 20, embedding: SELF });
        vp.ingestHostPrint(STEM1);
        capture(fx, STEM2, { voices: [v(1, plus(SELF, vector(7, 0.1)))], guests: ['Ann Example'] });
        const r = vp.enrolFromMapping(STEM2, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        const lines = vp.readScoreLines();
        return [r.enrolled === 0 && lines.some((l) => l.reason === 'matches_own_print'), JSON.stringify({ r, lines })];
    });
    add('10. control: a voice unlike the member\'s own print, with a person id, is enrolled', () => {
        const fx = fixture();
        const vp = on(fx);
        firstCall(fx, vp, P_ANN);
        fx.write(`host-print-${STEM1}.json`, { model: 'm', modelRevision: 'r', seconds: 20, embedding: SELF });
        vp.ingestHostPrint(STEM1);
        capture(fx, STEM2, { voices: [v(1, ANN)], guests: ['Ann Example'] });
        const r = vp.enrolFromMapping(STEM2, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        return [r.enrolled === 1, JSON.stringify(r)];
    });
    add('11. the member\'s own print: host-print-<stem>.json is taken into `self` and the file is deleted', () => {
        const fx = fixture();
        const vp = on(fx);
        const f = path.join(fx.outdir, `host-print-${STEM1}.json`);
        fx.write(`host-print-${STEM1}.json`, { model: 'm', modelRevision: 'r', seconds: 20, embedding: SELF });
        const r = vp.ingestHostPrint(STEM1);
        const self = vp.load().self;
        return [r === 'ingested' && !fs.existsSync(f) && self && self.count === 1 && mod.cosine(self.embedding, SELF) > 0.9999, r];
    });
    add('12. while off, a host print that arrives is deleted and nothing is kept', () => {
        const fx = fixture();
        const vp = open(fx);
        const f = path.join(fx.outdir, `host-print-${STEM1}.json`);
        fx.write(`host-print-${STEM1}.json`, { model: 'm', modelRevision: 'r', seconds: 20, embedding: SELF });
        const r = vp.ingestHostPrint(STEM1);
        return [r === 'deleted_off' && !fs.existsSync(f) && !fs.existsSync(vp.profilesPath), r];
    });
    add('13. deleting one profile removes it; control: the other stays', () => {
        const fx = fixture();
        const vp = on(fx);
        firstCall(fx, vp, P_ANN, P_BOB);
        capture(fx, STEM1, { voices: [v(1, ANN), v(2, BOB)], guests: ['Ann Example', 'Bob Example'] });
        vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }, { voiceIndex: 2, personId: P_BOB }], them: null });
        const ok = vp.deleteProfile(P_ANN);
        const left = Object.keys(vp.load().people);
        return [ok && left.length === 1 && left[0] === P_BOB, left.join(',')];
    });
    add('14. turning off deletes the store, the score log and waiting host prints; control: other files stay', () => {
        const fx = fixture();
        const vp = on(fx);
        capture(fx, STEM1, { voices: [v(1, ANN)], guests: ['Ann Example'] });
        vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        fx.write(`host-print-${STEM2}.json`, { embedding: SELF });
        const had = fs.existsSync(vp.profilesPath) && fs.existsSync(vp.scoresPath);
        const gone = vp.disable();
        const left = fs.readdirSync(fx.outdir).sort();
        return [had && !vp.isEnabled() && !fs.existsSync(vp.profilesPath) && !fs.existsSync(vp.scoresPath) && gone.hostPrints === 1
            && left.includes(`diarize-${STEM1}.json`) && left.includes(`identity-${STEM1}.json`) && !left.some((n) => n.startsWith('host-print-')), JSON.stringify({ gone, left })];
    });
    add('15. after turning off, enrolling writes nothing again', () => {
        const fx = fixture();
        const vp = on(fx);
        vp.disable();
        capture(fx, STEM1, { voices: [v(1, ANN)], guests: ['Ann Example'] });
        const r = vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        return [r.skipped === 'off' && !fs.existsSync(vp.profilesPath) && !fs.existsSync(vp.scoresPath), JSON.stringify(r)];
    });
    add('16. deleting a recording removes its contributions (self too) and its score lines; control: another recording\'s stay', () => {
        const fx = fixture();
        const vp = on(fx);
        firstCall(fx, vp, P_ANN);
        fx.write(`host-print-${STEM1}.json`, { embedding: SELF });
        vp.ingestHostPrint(STEM1);
        capture(fx, STEM1, { voices: [v(1, annCall(1))], guests: ['Ann Example'] });
        capture(fx, STEM2, { voices: [v(1, annCall(2))], guests: ['Ann Example'] });
        vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        vp.enrolFromMapping(STEM2, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        const r = vp.removeRecording(STEM1);
        const store = vp.load();
        const lines = vp.readScoreLines();
        return [r.contributions === 2 && store.self === null && store.people[P_ANN].count === 1 && store.people[P_ANN].sources[0].stem === STEM2
            && lines.some((l) => l.stem === STEM2) && !lines.some((l) => l.stem === STEM1), JSON.stringify({ r, lines: lines.map((l) => l.stem) })];
    });
    add('17. the folder is mode 700, and the setting, store and score log 600', () => {
        const fx = fixture();
        const vp = on(fx);
        capture(fx, STEM1, { voices: [v(1, ANN)], guests: ['Ann Example'] });
        vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
        const got = [mode(vp.dir), mode(vp.settingPath), mode(vp.profilesPath), mode(vp.scoresPath)];
        return [got.join(' ') === '700 600 600 600', got.join(' ')];
    });
    add('18. control: the mode reading tells a 644 file apart', () => {
        const fx = fixture();
        const p = path.join(fx.support, 'loose.txt');
        fs.writeFileSync(p, 'x', { mode: 0o644 });
        fs.chmodSync(p, 0o644);
        return [(fs.statSync(p).mode & 0o777).toString(8) === '644', ''];
    });
    // The store is encrypted: the file holds none of the profile's numbers or its name.
    let disk = null;
    const diskFixture = () => {
        if (disk) return disk;
        const fx = fixture();
        const vp = on(fx);
        firstCall(fx, vp, P_ANN);
        fx.write(`host-print-${STEM3}.json`, { embedding: SELF });
        vp.ingestHostPrint(STEM3);
        capture(fx, STEM1, { voices: [v(1, ANN)], guests: ['Ann Example'], voiceNames: [{ voiceIndex: 1, name: 'Ann Example' }] });
        vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        const store = vp.load();
        const numbers = [
            ...store.people[P_ANN].embedding, ...store.people[P_ANN].sources[0].vec, ...store.self.embedding,
        ].map(String).filter((s) => s.replace(/[^0-9]/g, '').length >= 6);
        disk = { raw: fs.readFileSync(vp.profilesPath).toString('latin1'), plain: JSON.stringify(store), numbers, name: 'Ann Example' };
        return disk;
    };
    add('19. the store file on disk holds none of the profile\'s numbers (every one checked) and not the name', () => {
        const d = diskFixture();
        const found = d.numbers.filter((n) => d.raw.includes(n));
        return [d.numbers.length >= 700 && found.length === 0 && !d.raw.includes(d.name), `${d.numbers.length} numbers, ${found.length} found, name ${d.raw.includes(d.name)}`];
    });
    add('20. control: the stand-in\'s plaintext (the JSON it encrypts) holds them all and the name', () => {
        const d = diskFixture();
        return [d.numbers.every((n) => d.plain.includes(n)) && d.plain.includes(d.name), ''];
    });
    add('21. the score log holds ids and scores only: no name, no embedding', () => {
        const fx = fixture();
        const vp = on(fx);
        capture(fx, STEM1, { voices: [v(1, ANN), v(2, BOB)], guests: ['Ann Example', 'Bob Example'], voiceNames: [{ voiceIndex: 1, name: 'Ann Example' }, { voiceIndex: 2, name: 'Bob Example' }] });
        vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        const text = fs.readFileSync(vp.scoresPath, 'utf8');
        const keys = new Set(vp.readScoreLines().flatMap((l) => Object.keys(l)));
        const planted = text + JSON.stringify({ name: 'Ann Example' });
        return [!text.includes('Ann Example') && !text.includes('Bob Example') && !keys.has('embedding') && !keys.has('vec') && !keys.has('name')
            && planted.includes('Ann Example'), [...keys].join(',')];
    });
    // main.js and build-app.sh, as text.
    add('22. main.js (text): both pipelineSpawn branches pass the host-print flag only through withHostPrintFlag, which drops an inherited one', () => {
        const spawnFn = SRC.slice(SRC.indexOf('function pipelineSpawn('), SRC.indexOf('function withHostPrintFlag('));
        const flagFn = SRC.slice(SRC.indexOf('function withHostPrintFlag('), SRC.indexOf('function withHostPrintFlag(') + 400);
        return [(spawnFn.match(/env: withHostPrintFlag\(/g) || []).length === 2 && /delete env\.CLIPWISE_SAVE_HOST_PRINT/.test(flagFn) && /if \(voicePrintsOn\(\)\) env\.CLIPWISE_SAVE_HOST_PRINT = '1'/.test(flagFn), ''];
    });
    add('23. main.js (text): the trash delete removes the recording\'s voice prints before its files', () => {
        const at = SRC.indexOf('const files = removeCaptureFiles(OUTDIR, UPLOAD_QUEUE_DIR, stem);');
        const before = SRC.slice(Math.max(0, at - 300), at);
        return [at > 0 && before.includes('voicePrintsRemoveRecording(stem);') && (SRC.match(/removeCaptureFiles\(/g) || []).length === 1, `removeCaptureFiles calls: ${(SRC.match(/removeCaptureFiles\(/g) || []).length}`];
    });
    add('24. main.js (text): a pipeline exit (code 0) and a recovery exit match before the drain; a send enrols from `people`', () => {
        const exit = SRC.slice(SRC.indexOf("proc.once('exit', (code, signal) => {"), SRC.indexOf('// --- recovery (SAA-136)'));
        return [/if \(code === 0\) \{\s*pipeline = null;[\s\S]{0,200}voicePrintsAfterPipeline\(stem\);/.test(exit)
            && /for \(const recovered of queueRecoveredCaptures\(triggeredAtMs\)\) voicePrintsAfterPipeline\(recovered\);\s*drainUploadQueue\('recovery exit'\);/.test(SRC)
            && /if \(reply\.people\) voicePrintsAfterSend\(stem, reply\.people\);/.test(SRC), ''];
    });
    add('25. build-app.sh (text): copies capture-payload.js, voice-prints.js, voice-match.js, voice-prints.html, voice-prints-page.js and voice-prints-preload.js into the bundle', () => {
        const files = ['capture-payload.js', 'voice-prints.js', 'voice-match.js', 'voice-prints.html', 'voice-prints-page.js', 'voice-prints-preload.js'];
        const missing = files.filter((f) => !BUILD.includes(`cp "$APP_SRC/${f}" "$C/Resources/app/${f}"`));
        return [missing.length === 0, missing.join(', ')];
    });

    // Each recording's diarize file keeps a per-voice embedding. With prints
    // off none may stay (SAA-243 item 7): removed at turn-off, and by the pass
    // that runs at launch and when a pipeline ends while off.
    const diarizeDoc = (voices) => ({
        clusteringThreshold: 0.6, error: null, hostVoiceRanges: [{ start: 0, end: 1 }], model: 'fluidaudio-community-1', modelRevision: 'r',
        segments: [{ start: 1, end: 2, voiceIndex: 1 }, { start: 2, end: 3, voiceIndex: null }], voices,
    });
    const fullVoice = (voiceIndex, embedding) => ({ clipRanges: [{ start: 1, end: 2 }], embedding, sourceLabel: `S${voiceIndex}`, totalSeconds: 30, voiceIndex });
    const readDoc = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    const hasEmbedding = (doc) => (doc.voices || []).some((x) => x && Object.prototype.hasOwnProperty.call(x, 'embedding'));
    const fileHasEmbedding = (file) => hasEmbedding(readDoc(file));
    const withoutEmbedding = (doc) => ({ ...doc, voices: doc.voices.map(({ embedding, ...rest }) => rest) });
    // Prints on, two people enrolled from STEM1, and STEM2's file with the
    // early run's copy beside it: three files, each holding embeddings.
    function embeddingFixture() {
        const fx = fixture();
        const vp = on(fx);
        fx.write(`diarize-${STEM1}.json`, diarizeDoc([fullVoice(1, ANN), fullVoice(2, BOB)]));
        fx.write(`identity-${STEM1}.json`, { self: { name: 'Check Host' }, guests: [{ name: 'Ann Example' }, { name: 'Bob Example' }] });
        vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }, { voiceIndex: 2, personId: P_BOB }], them: null });
        fx.write(`diarize-${STEM2}.json`, diarizeDoc([fullVoice(1, annCall(2))]));
        fx.write(`diarize-${STEM2}.json.early`, { ...diarizeDoc([fullVoice(1, annCall(3))]), early_run: { exit_code: 0 } });
        fs.chmodSync(path.join(fx.outdir, `diarize-${STEM2}.json`), 0o644);
        fs.chmodSync(path.join(fx.outdir, `diarize-${STEM2}.json.early`), 0o600);
        const files = [`diarize-${STEM1}.json`, `diarize-${STEM2}.json`, `diarize-${STEM2}.json.early`].map((n) => path.join(fx.outdir, n));
        return { fx, vp, files };
    }
    const offFixture = () => {
        const fx = fixture();
        fx.write(`diarize-${STEM1}.json`, diarizeDoc([fullVoice(1, ANN)]));
        fx.write(`diarize-${STEM2}.json`, diarizeDoc([fullVoice(1, BOB)]));
        fx.write(`diarize-${STEM2}.json.early`, { ...diarizeDoc([fullVoice(1, BOB)]), early_run: { exit_code: 0 } });
        return { fx, at: (n) => path.join(fx.outdir, n) };
    };
    // fs.<name> replaced while fn runs, then put back.
    const stubbing = (name, stub, fn) => {
        const real = fs[name];
        fs[name] = stub(real);
        try { return fn(); } finally { fs[name] = real; }
    };

    add('26. control: the fixture\'s three diarize files (.json and .json.early) hold the planted embedding key, and the test for it tells a copy without the key apart', () => {
        const { files } = embeddingFixture();
        const docs = files.map(readDoc);
        return [docs.every(hasEmbedding) && !hasEmbedding(withoutEmbedding(docs[0])), files.map((f) => `${path.basename(f)} ${fileHasEmbedding(f)}`).join(', ')];
    });
    add('27. turning off removes voices[].embedding from every diarize-<stem>.json and .json.early, and every file stays', () => {
        const { vp, files } = embeddingFixture();
        vp.disable();
        const left = files.filter((f) => !fs.existsSync(f) || fileHasEmbedding(f));
        return [left.length === 0, `still holding it or gone: ${left.map((f) => path.basename(f)).join(', ')}`];
    });
    add('28. the removal keeps everything else: each file is its old content less the key, in the same key order and mode; other files are byte for byte the same; no temp file is left; a file with no embedding is not rewritten', () => {
        const { fx, vp, files } = embeddingFixture();
        fx.write(`diarize-${STEM3}.json`, diarizeDoc([{ clipRanges: [], sourceLabel: 'S1', totalSeconds: 5, voiceIndex: 1 }]));
        const plain = path.join(fx.outdir, `diarize-${STEM3}.json`);
        const mode = (p) => fs.statSync(p).mode & 0o777;
        const before = files.map((f) => ({ doc: readDoc(f), mode: mode(f) }));
        const identity = fs.readFileSync(path.join(fx.outdir, `identity-${STEM1}.json`));
        const plainStat = fs.statSync(plain, { bigint: true });
        const names = fs.readdirSync(fx.outdir).sort().join(',');
        vp.disable();
        const after = files.map((f) => ({ doc: readDoc(f), mode: mode(f) }));
        const same = before.every((b, i) => JSON.stringify(withoutEmbedding(b.doc)) === JSON.stringify(after[i].doc) && b.mode === after[i].mode);
        const plainAfter = fs.statSync(plain, { bigint: true });
        const ok = same
            && identity.equals(fs.readFileSync(path.join(fx.outdir, `identity-${STEM1}.json`)))
            && fs.readdirSync(fx.outdir).sort().join(',') === names
            && plainAfter.ino === plainStat.ino && plainAfter.mtimeNs === plainStat.mtimeNs;
        return [ok, JSON.stringify({ same, modes: after.map((a) => a.mode.toString(8)), names: fs.readdirSync(fx.outdir).sort() })];
    });
    add('29. with prints off, the pass for one stem (a pipeline ending) removes that stem\'s embeddings, .early included, and leaves another stem\'s', () => {
        const { fx, at } = offFixture();
        const r = open(fx).removeWhileOff({ stem: STEM2 });
        return [!fileHasEmbedding(at(`diarize-${STEM2}.json`)) && !fileHasEmbedding(at(`diarize-${STEM2}.json.early`)) && fileHasEmbedding(at(`diarize-${STEM1}.json`)), JSON.stringify(r)];
    });
    add('30. control: with prints on, the same pass changes nothing and says so', () => {
        const { fx, at } = offFixture();
        const vp = on(fx);
        const r = vp.removeWhileOff({ stem: STEM2 });
        const r2 = vp.removeWhileOff();
        return [r.skipped === 'on' && r2.skipped === 'on' && [`diarize-${STEM1}.json`, `diarize-${STEM2}.json`, `diarize-${STEM2}.json.early`].every((n) => fileHasEmbedding(at(n))), JSON.stringify({ r, r2 })];
    });
    add('31. the whole pass (launch) skips a stem it is told to (a running pipeline or recovery), and removes the rest', () => {
        const { fx, at } = offFixture();
        const r = open(fx).removeWhileOff({ skip: (stem) => stem === STEM2 });
        return [!fileHasEmbedding(at(`diarize-${STEM1}.json`)) && fileHasEmbedding(at(`diarize-${STEM2}.json`)) && fileHasEmbedding(at(`diarize-${STEM2}.json.early`)), JSON.stringify(r)];
    });
    add('32. a turn-off cut short in the removal (the second rename fails): the setting reads off and the store is gone; the launch pass then finishes it, and a second pass changes nothing', () => {
        const { fx, vp, files } = embeddingFixture();
        let renames = 0;
        let threw = null;
        stubbing('renameSync', (real) => (a, b) => {
            if (/diarize-/.test(path.basename(b)) && ++renames === 2) throw Object.assign(new Error('stub: rename failed'), { code: 'EIO' });
            return real(a, b);
        }, () => { try { vp.disable(); } catch (err) { threw = err.code; } });
        const holding = files.filter(fileHasEmbedding).length;
        const offNow = !open(fx).isEnabled() && !fs.existsSync(vp.profilesPath);
        const noTemp = !fs.readdirSync(fx.outdir).some((n) => /\.tmp|\.strip/.test(n));
        const first = open(fx).removeWhileOff();
        const second = open(fx).removeWhileOff();
        const ok = holding === 1 && offNow && noTemp && files.every((f) => !fileHasEmbedding(f))
            && first.embeddings && first.embeddings.changed === 1 && second.embeddings && second.embeddings.changed === 0;
        return [ok, JSON.stringify({ threw, holding, offNow, noTemp, first, second })];
    });
    add('33. a turn-off cut short before the store is deleted (its unlink fails): the setting already reads off, and the launch pass deletes the store and the embeddings', () => {
        const { fx, vp, files } = embeddingFixture();
        let threw = null;
        stubbing('unlinkSync', (real) => (p) => {
            if (p === vp.profilesPath) throw Object.assign(new Error('stub: unlink failed'), { code: 'EIO' });
            return real(p);
        }, () => { try { vp.disable(); } catch (err) { threw = err.code; } });
        const offNow = !open(fx).isEnabled();
        const r = open(fx).removeWhileOff();
        const ok = threw === 'EIO' && offNow && !fs.existsSync(vp.profilesPath) && files.every((f) => !fileHasEmbedding(f));
        return [ok, JSON.stringify({ threw, offNow, storeLeft: fs.existsSync(vp.profilesPath), r })];
    });
    add('34. turned back on, a correction on a call whose embeddings were removed refuses its voices (no_embedding) without an error; control: a call that kept them enrols', () => {
        const { fx, vp } = embeddingFixture();
        vp.disable();
        vp.enable(mod.STATEMENT_VERSION);
        const r1 = vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }, { voiceIndex: 2, personId: P_BOB }], them: null });
        const reasons = vp.readScoreLines().filter((l) => l.stem === STEM1).map((l) => l.reason);
        fx.write(`diarize-${STEM3}.json`, diarizeDoc([fullVoice(1, ANN)]));
        fx.write(`identity-${STEM3}.json`, { self: { name: 'Check Host' }, guests: [{ name: 'Ann Example' }] });
        firstCall(fx, vp, P_ANN);
        const r3 = vp.enrolFromMapping(STEM3, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        return [r1.enrolled === 0 && r1.refused === 2 && reasons.length === 2 && reasons.every((x) => x === 'no_embedding') && r3.enrolled === 1, JSON.stringify({ r1, reasons, r3 })];
    });

    // As main.js runs the pass (runRemovalWhileOff): it never throws, and the
    // day log gets counts or one fixed line. The planted error carries a name
    // and a path, as a real fs error's message carries the file's path.
    const NAME = 'Ann Example';
    const leaky = (fx) => Object.assign(new Error(`EIO: i/o error, unlink '${path.join(fx.support, 'voice-prints', 'profiles.json')}' for ${NAME}`), { code: 'EIO' });
    const FIXED = '[clipwise-recorder] voice prints off (launch): removal failed';
    add('35. the launch pass catches what the store throws (a failed delete, a store that cannot be opened, a log that throws), returns, and logs only the fixed line; control: the planted error names the person and the path', () => {
        const { fx, vp } = embeddingFixture();
        vp.disable();
        fs.writeFileSync(vp.profilesPath, 'left by a cut-short turn-off', { mode: 0o600 });
        const err = leaky(fx);
        const lines = [];
        const log = (l) => lines.push(l);
        const outcomes = [];
        // 1. a real throw from inside the pass: the store's delete fails.
        stubbing('unlinkSync', (real) => (p) => { if (p === vp.profilesPath) throw err; return real(p); }, () => {
            try { outcomes.push(mod.runRemovalWhileOff(() => open(fx), { reason: 'launch', log })); } catch (e) { outcomes.push({ threw: e.message }); }
        });
        // 2. the store cannot be opened at all.
        try { outcomes.push(mod.runRemovalWhileOff(() => { throw err; }, { reason: 'launch', log })); } catch (e) { outcomes.push({ threw: e.message }); }
        // 3. the log itself throws, after the store threw.
        try { outcomes.push(mod.runRemovalWhileOff(() => { throw err; }, { reason: 'launch', log: () => { throw err; } })); } catch (e) { outcomes.push({ threw: e.message }); }
        const ok = outcomes.length === 3 && outcomes.every((o) => o && o.failed === true)
            && lines.length === 2 && lines.every((l) => l === FIXED)
            && err.message.includes(NAME) && err.message.includes(fx.support);
        return [ok, JSON.stringify({ outcomes, lines })];
    });
    add('36. the pass\'s counts line holds counts and fixed words only (no path, no stem, no name), and a pass with nothing to do logs nothing', () => {
        const { fx } = offFixture();
        fx.write(`host-print-${STEM1}.json`, { embedding: SELF });
        const lines = [];
        const r = mod.runRemovalWhileOff(() => open(fx), { reason: 'launch', log: (l) => lines.push(l) });
        const second = [];
        mod.runRemovalWhileOff(() => open(fx), { reason: 'launch', log: (l) => second.push(l) });
        const want = '[clipwise-recorder] voice prints off (launch): store none, score log none, tally none, host prints 1, embeddings removed from 3 of 3 diarize file(s), 0 skipped, 0 failed';
        return [lines.length === 1 && lines[0] === want && !lines[0].includes('/') && !lines[0].includes(STEM1) && second.length === 0 && r.embeddings.changed === 3, JSON.stringify({ lines, second })];
    });
    add('37. a reason the pass does not know is logged as "other"; control: the three it knows are logged as given', () => {
        const got = [];
        for (const reason of ['launch', 'pipeline exit', 'recovery exit', `made up ${NAME}`]) {
            mod.runRemovalWhileOff(() => { throw new Error('x'); }, { reason, log: (l) => got.push(l) });
        }
        const want = ['launch', 'pipeline exit', 'recovery exit', 'other'].map((r) => `[clipwise-recorder] voice prints off (${r}): removal failed`);
        return [JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got)];
    });
    add('38. the skip rule: every stem while recovery runs; else the running pipeline\'s stem; not the stem of the pipeline whose exit this is; nothing for a failed one or none', () => {
        const proc = {};
        const other = {};
        const s = (opts) => [STEM1, STEM2].map(mod.removalSkip(opts));
        const got = {
            recovering: s({ pipeline: null, recovering: true }),
            running: s({ pipeline: { stem: STEM2, state: 'running', proc }, recovering: false }),
            ownExit: s({ pipeline: { stem: STEM2, state: 'running', proc }, recovering: false, endedProc: proc }),
            otherExit: s({ pipeline: { stem: STEM2, state: 'running', proc }, recovering: false, endedProc: other }),
            failed: s({ pipeline: { stem: STEM2, state: 'failed', proc: null }, recovering: false }),
            none: s({ pipeline: null, recovering: false }),
        };
        const want = { recovering: [true, true], running: [false, true], ownExit: [false, false], otherExit: [false, true], failed: [false, false], none: [false, false] };
        return [JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got)];
    });
    // main.js, as text: where the pass runs.
    const whenReady = SRC.slice(SRC.indexOf('app.whenReady().then(async () => {'), SRC.indexOf("app.on('second-instance'"));
    const fnBody = (name) => { const at = SRC.indexOf(`function ${name}(`); return at < 0 ? '' : SRC.slice(at, SRC.indexOf('\n}\n', at)); };
    add('39. main.js (text): at launch the pass runs as a plain call (not awaited, nothing after it on the line) after the tray exists and before recovery starts, and its function is only the never-throwing runRemovalWhileOff', () => {
        const at = whenReady.indexOf("\n    voicePrintsRemoveWhileOff('launch');\n");
        const body = fnBody('voicePrintsRemoveWhileOff');
        const ok = at > 0 && at > whenReady.indexOf('tray = new Tray(') && at < whenReady.indexOf("startRecovery('app launch');")
            && /^function voicePrintsRemoveWhileOff\(reason, stem = null, endedProc = null\) \{\s*return voicePrintsModule\.runRemovalWhileOff\(voicePrints, \{[^;]*\}\);\s*$/.test(body)
            && !/await voicePrintsRemoveWhileOff/.test(SRC);
        return [ok, `at ${at}; body ${JSON.stringify(body.slice(0, 120))}`];
    });
    add('40. main.js (text): every pipeline exit runs the pass for its stem, passing its own process, before the early return', () => {
        const exit = SRC.slice(SRC.indexOf("proc.once('exit', (code, signal) => {"), SRC.indexOf('// --- recovery (SAA-136)'));
        const call = exit.indexOf("voicePrintsRemoveWhileOff('pipeline exit', stem, proc);");
        const ret = exit.indexOf('if (!pipeline || pipeline.proc !== proc) return;');
        return [call > 0 && ret > call && exit.indexOf('if (code === 0)') > call, `call ${call}, return ${ret}`];
    });
    add('41. main.js (text): a recovery exit runs the whole pass once recoveryProc is cleared', () => {
        const rec = SRC.slice(SRC.indexOf('function startRecovery('), SRC.indexOf('function retryPipeline('));
        return [/proc\.once\('exit'[\s\S]*if \(recoveryProc === proc\) recoveryProc = null;\s*(\/\/[^\n]*\n\s*)*voicePrintsRemoveWhileOff\('recovery exit'\);/.test(rec), ''];
    });
    add('42. main.js (text): turning off passes the skip rule from the running pipeline and recovery, and every call to the pass uses a reason it knows', () => {
        const disable = SRC.slice(SRC.indexOf("ipcMain.on('voice-prints:disable'"), SRC.indexOf("ipcMain.on('voice-prints:disable'") + 1500);
        const reasons = [...SRC.matchAll(/voicePrintsRemoveWhileOff\('([^']*)'/g)].map((m) => m[1]);
        const ok = /voicePrints\(\)\.disable\(\{ skip: voicePrintsModule\.removalSkip\(\{ pipeline, recovering: !!recoveryProc \}\) \}\)/.test(disable)
            && reasons.length === 3 && reasons.every((r) => ['launch', 'pipeline exit', 'recovery exit'].includes(r));
        return [ok, reasons.join(', ')];
    });

    // The mic box (SAA-260 11-07): a call whose answer says someone else spoke
    // into the member's mic gives nothing to the member's own print.
    const sharedAnswer = (fx, stem, micShared) => fx.write(`identity-${stem}.json`, { self: { name: 'Check Host' }, guests: [{ name: 'Ann Example' }], ...(micShared ? { mic_shared: true } : {}) });
    add('43. on, a host print from a call whose answer says the mic was shared is deleted and not taken into `self`', () => {
        const fx = fixture();
        const vp = on(fx);
        const f = path.join(fx.outdir, `host-print-${STEM1}.json`);
        sharedAnswer(fx, STEM1, true);
        fx.write(`host-print-${STEM1}.json`, { model: 'm', modelRevision: 'r', seconds: 20, embedding: SELF });
        const r = vp.ingestHostPrint(STEM1);
        return [r === 'skipped_mic_shared' && !fs.existsSync(f) && vp.load().self === null, r];
    });
    add('44. control: the same call answered without it is taken into `self`', () => {
        const fx = fixture();
        const vp = on(fx);
        sharedAnswer(fx, STEM1, false);
        fx.write(`host-print-${STEM1}.json`, { model: 'm', modelRevision: 'r', seconds: 20, embedding: SELF });
        const r = vp.ingestHostPrint(STEM1);
        return [r === 'ingested' && vp.load().self && vp.load().self.count === 1, r];
    });
    add('45. removing one call\'s own-print contribution (a correction that ticks the box) leaves the other calls\'; the print is their mean again', () => {
        const fx = fixture();
        const vp = on(fx);
        const other = plus(SELF, vector(9, 0.2));
        fx.write(`host-print-${STEM1}.json`, { embedding: vector(44) });
        vp.ingestHostPrint(STEM1);
        fx.write(`host-print-${STEM2}.json`, { embedding: other });
        vp.ingestHostPrint(STEM2);
        const before = vp.load().self.count;
        const removed = vp.removeSelfContribution(STEM1);
        const self = vp.load().self;
        return [before === 2 && removed === 1 && self.count === 1 && self.sources[0].stem === STEM2 && mod.cosine(self.embedding, other) > 0.9999,
            JSON.stringify({ before, removed, count: self.count, stems: self.sources.map((s) => s.stem) })];
    });
    add('46. removing the only contribution leaves no own print; a second removal and an unknown call remove nothing', () => {
        const fx = fixture();
        const vp = on(fx);
        fx.write(`host-print-${STEM1}.json`, { embedding: SELF });
        vp.ingestHostPrint(STEM1);
        const got = [vp.removeSelfContribution(STEM1), vp.removeSelfContribution(STEM1), vp.removeSelfContribution(STEM3)];
        return [JSON.stringify(got) === '[1,0,0]' && vp.load().self === null, JSON.stringify(got)];
    });
    add('47. with no store (prints off, or nothing kept yet), the removal reads and writes nothing', () => {
        const fx = fixture();
        const vp = open(fx);
        const r = vp.removeSelfContribution(STEM1);
        return [r === 0 && !fs.existsSync(vp.dir), String(r)];
    });

    // --- SAA-275 part 1: several prints deleted at once -----------------------
    const PAGE = fs.readFileSync(path.join(__dirname, 'voice-prints-page.js'), 'utf8');
    const HTML = fs.readFileSync(path.join(__dirname, 'voice-prints.html'), 'utf8');
    const handlerAt = SRC.indexOf("ipcMain.on('voice-prints:delete'");
    const HANDLER = handlerAt >= 0 ? SRC.slice(handlerAt, SRC.indexOf("ipcMain.on('voice-prints:disable'", handlerAt)) : '';
    // A page function, taken from the page's own text, as check-meetings.js does.
    const pageFunction = (name) => {
        const m = new RegExp(`\\n( *)function ${name}\\([\\s\\S]*?\\n\\1\\}\\n`).exec(PAGE);
        if (!m) throw new Error(`${name} not found in voice-prints-page.js`);
        return new Function(`${m[0]}\nreturn ${name};`)();
    };
    const P = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
    // Five people with prints, and the member's own.
    const fivePrints = () => {
        const fx = fixture();
        const vp = on(fx);
        const ids = [1, 2, 3, 4, 5].map(P);
        firstCall(fx, vp, ...ids);
        capture(fx, STEM1, { voices: ids.map((_, i) => v(i + 1, vector(500 + i))), guests: ids.map((_, i) => `Person ${i + 1}`),
            voiceNames: ids.map((_, i) => ({ voiceIndex: i + 1, name: `Person ${i + 1}` })) });
        vp.enrolFromMapping(STEM1, { voices: ids.map((personId, i) => ({ voiceIndex: i + 1, personId })), them: null });
        fx.write(`host-print-${STEM2}.json`, { embedding: SELF });
        vp.ingestHostPrint(STEM2);
        return { fx, vp, ids };
    };
    add('48. deleteProfiles deletes the 3 picked of 5 in one call, from the encrypted store on disk; the other 2 and your own print stay', () => {
        if (typeof open({ support: os.tmpdir(), outdir: os.tmpdir() }).deleteProfiles !== 'function') return [false, 'no deleteProfiles'];
        const { vp, ids } = fivePrints();
        const n = vp.deleteProfiles([ids[0], ids[2], ids[4]]);
        const onDisk = JSON.parse(decrypt(fs.readFileSync(vp.profilesPath)));
        const left = Object.keys(onDisk.people).sort();
        return [n === 3 && JSON.stringify(left) === JSON.stringify([ids[1], ids[3]].sort()) && !!onDisk.self, JSON.stringify({ n, left, self: !!onDisk.self })];
    });
    add('49. control: ids with no print, and repeats, delete nothing more; the store is unchanged', () => {
        if (typeof open({ support: os.tmpdir(), outdir: os.tmpdir() }).deleteProfiles !== 'function') return [false, 'no deleteProfiles'];
        const { vp, ids } = fivePrints();
        const before = fs.readFileSync(vp.profilesPath, 'utf8');
        const n = vp.deleteProfiles([P(9), P(8)]);
        const same = fs.readFileSync(vp.profilesPath, 'utf8') === before;
        const twice = vp.deleteProfiles([ids[0], ids[0], P(9)]);
        return [n === 0 && same && twice === 1 && Object.keys(vp.load().people).length === 4, JSON.stringify({ n, same, twice })];
    });
    add('50. your own print ("You") cannot be deleted through deleteProfiles, whatever id is sent', () => {
        if (typeof open({ support: os.tmpdir(), outdir: os.tmpdir() }).deleteProfiles !== 'function') return [false, 'no deleteProfiles'];
        const { vp } = fivePrints();
        const n = vp.deleteProfiles(['self', '__proto__', 'constructor', 'You', '']);
        const store = vp.load();
        return [n === 0 && !!store.self && store.self.count === 1 && Object.keys(store.people).length === 5, JSON.stringify({ n, self: !!store.self, people: Object.keys(store.people).length })];
    });
    // True when every delete sender sends { personIds } and the handler reads
    // only personIds. Run on the files as they are (51) and on altered copies (52).
    const sendsOnlyPersonIds = (page, handler) => {
        const senders = page.match(/ipcRenderer\.send\('voice-prints:delete'[^\n]*/g) || [];
        return senders.length === 1 && senders[0].includes('{ personIds: Array.from(personIds) }')
            && /del\.addEventListener\('click', \(\) => deletePrints\(\[personId\]\)\);/.test(page)
            && /d\.addEventListener\('click', \(\) => deletePrints\(picked\)\);/.test(page)
            && !/\{ personId \}/.test(page) && !/payload\.personId\b/.test(handler) && /payload\.personIds/.test(handler);
    };
    add('51. no sender uses personId: the row\'s Delete and "Delete N…" both send { personIds }, and main.js reads only personIds', () =>
        [sendsOnlyPersonIds(PAGE, HANDLER), JSON.stringify(PAGE.match(/ipcRenderer\.send\('voice-prints:delete'[^\n]*/g) || [])]);
    add('52. control: the same scan returns false on a page copy whose row Delete sends { personId }, and on a handler copy reading payload.personId', () => {
        const page = PAGE.replace('deletePrints([personId])', "ipcRenderer.send('voice-prints:delete', { personId })");
        const handler = HANDLER.replace('const sent = payload && Array.isArray(payload.personIds)',
            "const one = payload && typeof payload.personId === 'string' ? [payload.personId] : [];\n        const sent = payload && Array.isArray(payload.personIds)");
        const pageAltered = page !== PAGE;
        const handlerAltered = handler !== HANDLER;
        const pageCaught = pageAltered && sendsOnlyPersonIds(page, HANDLER) === false;
        const handlerCaught = handlerAltered && sendsOnlyPersonIds(PAGE, handler) === false;
        return [pageCaught && handlerCaught, JSON.stringify({ pageAltered, pageCaught, handlerAltered, handlerCaught })];
    });
    add('53. main.js (text): one confirmation for one or several, Cancel the default; one keeps its detail line; several say "Delete these N voice prints?" with the names (first 10, then "and N more") and their own detail line; deleted only after Delete', () => {
        const ok = (HANDLER.match(/defaultId: 0, cancelId: 0,/g) || []).length === 2
            && HANDLER.includes('message: `Delete these ${picked.length} voice prints?`,')
            && HANDLER.includes("const detail = 'Clipwise stops comparing new calls against it. A new print is kept if you name this person on two more calls.';")
            && HANDLER.includes("const detailMany = 'Clipwise stops comparing new calls against them. A new print is kept for anyone you name on two more calls.';")
            && /message: picked\[0\]\.name \? `Delete \$\{picked\[0\]\.name\}’s voice print\?` : 'Delete this voice print\?',\s*detail,\s*\}/.test(HANDLER)
            && HANDLER.includes("detail: `${confirmationList(picked.map((p) => `• ${p.name || 'Someone (no name kept)'}`)).join('\\n')}\\n\\n${detailMany}`,")
            && HANDLER.indexOf('if (response !== 1) return;') > HANDLER.indexOf('dialog.showMessageBox(')
            && HANDLER.indexOf('deleteProfiles(') > HANDLER.indexOf('if (response !== 1) return;');
        return [ok, `${HANDLER.length} chars`];
    });
    add('54. the page: a checkbox on each person\'s row (not on "You"), and a bar that shows "N selected", "Delete N…" and Clear only while some are checked', () => {
        let sb = null;
        try { sb = pageFunction('selbarItems'); } catch (err) { return [false, err.message]; }
        const ok = JSON.stringify(sb(0)) === '[]' && JSON.stringify(sb(3)) === '["count","delete","clear"]'
            && PAGE.includes('d.textContent = `Delete ${picked.size}…`;')
            && /if \(personId\) \{\s*const box = document\.createElement\('input'\);\s*box\.type = 'checkbox';/.test(PAGE)
            && HTML.includes('<div id="selbar" hidden></div>') && HTML.includes('#selbar[hidden] { display: none; }');
        return [ok, JSON.stringify([sb(0), sb(3)])];
    });

    // --- SAA-275 part 2: a print from the second qualifying call ---------------
    const hasTally = () => !!mod && typeof open({ support: os.tmpdir(), outdir: os.tmpdir() }).tallyPath === 'string';
    const tallyOf = (vp) => (fs.existsSync(vp.tallyPath) ? JSON.parse(fs.readFileSync(vp.tallyPath, 'utf8')) : null);
    const annMap = { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null };
    const annOn = (fx, stem, vec = ANN) => capture(fx, stem, { voices: [v(1, vec)], guests: ['Ann Example'], voiceNames: [{ voiceIndex: 1, name: 'Ann Example' }] });

    // Case A's steps, on any copy of the module: a print a build before the
    // tally made from one call (store written as that build wrote it, no
    // tally.json), then that call mapped again with the same names.
    const preTallyRemap = (m) => {
        const fx = fixture();
        const vp = m.createVoicePrints({ supportDir: fx.support, outdir: fx.outdir, encrypt, decrypt });
        vp.enable(m.STATEMENT_VERSION);
        annOn(fx, STEM1);
        const vec = m.normalise(ANN);
        fs.writeFileSync(vp.profilesPath, encrypt(JSON.stringify({ version: 1, self: null,
            people: { [P_ANN]: { name: 'Ann Example', embedding: vec, count: 1, sources: [{ stem: STEM1, voice: 1, vec }] } } })), { mode: 0o600 });
        const hadTallyFile = fs.existsSync(vp.tallyPath);
        vp.enrolFromMapping(STEM1, annMap);
        const p = vp.load().people[P_ANN];
        return { hadTallyFile, exists: !!p, count: p ? p.count : 0, tally: tallyOf(vp) };
    };
    add('55. A: a print made before the tally from one call (no tally.json), its call mapped again with the same names: the print is kept, count 1', () => {
        if (!hasTally()) return [false, 'no tally'];
        const r = preTallyRemap(mod);
        return [!r.hadTallyFile && r.exists && r.count === 1 && JSON.stringify(r.tally.people[P_ANN]) === JSON.stringify([STEM1]), JSON.stringify(r)];
    });
    add('56. control for A: the same steps on a copy of voice-prints.js without the hadPrint guard lose the print', () => {
        if (!hasTally()) return [false, 'no tally'];
        const src = fs.readFileSync(path.join(__dirname, 'voice-prints.js'), 'utf8');
        const cut = src.replace('!hadPrint.has(e.personId) && ', '');
        if (cut === src) return [false, 'guard not found in voice-prints.js'];
        const m = { exports: {} };
        new Function('require', 'module', 'exports', '__dirname', cut)(require, m, m.exports, __dirname);
        const r = preTallyRemap(m.exports);
        return [!r.exists, JSON.stringify(r)];
    });
    add('57. B: a print made under the new rule at call 2, then call 2 corrected so it no longer names them: no print, tally of 1', () => {
        if (!hasTally()) return [false, 'no tally'];
        const fx = fixture();
        const vp = on(fx);
        annOn(fx, STEM1, annCall(1));
        annOn(fx, STEM2, annCall(2));
        vp.enrolFromMapping(STEM1, annMap);
        const after1 = !!vp.load().people[P_ANN];
        vp.enrolFromMapping(STEM2, annMap);
        const p2 = vp.load().people[P_ANN];
        vp.enrolFromMapping(STEM2, { voices: [], them: null });
        const p3 = vp.load().people[P_ANN];
        const t = tallyOf(vp);
        return [!after1 && !!p2 && p2.count === 1 && p2.sources[0].stem === STEM2 && !p3 && JSON.stringify(t.people[P_ANN]) === JSON.stringify([STEM1]),
            JSON.stringify({ after1, p2: p2 && p2.count, p3: !!p3, tally: t })];
    });
    add('58. one qualifying call: no print, and tally.json (600) holds only { version, people: { id: [stem] } }: no name, no numbers', () => {
        if (!hasTally()) return [false, 'no tally'];
        const fx = fixture();
        const vp = on(fx);
        annOn(fx, STEM1);
        const r = vp.enrolFromMapping(STEM1, annMap);
        const raw = fs.readFileSync(vp.tallyPath, 'utf8');
        const mode = fs.statSync(vp.tallyPath).mode & 0o777;
        const exact = JSON.stringify(JSON.parse(raw)) === JSON.stringify({ version: 1, people: { [P_ANN]: [STEM1] } });
        return [r.enrolled === 0 && r.deferred === 1 && !vp.load().people[P_ANN] && exact && mode === 0o600 && !raw.includes('Ann') && !/\d\.\d/.test(raw),
            JSON.stringify({ r, raw, mode: mode.toString(8) })];
    });
    add('59. the same call mapped twice counts once: still no print, tally of 1', () => {
        if (!hasTally()) return [false, 'no tally'];
        const fx = fixture();
        const vp = on(fx);
        annOn(fx, STEM1);
        vp.enrolFromMapping(STEM1, annMap);
        vp.enrolFromMapping(STEM1, annMap);
        const t = tallyOf(vp);
        return [!vp.load().people[P_ANN] && JSON.stringify(t.people[P_ANN]) === JSON.stringify([STEM1]), JSON.stringify(t)];
    });
    add('60. a print that exists grows from one new call (count 1 -> 2)', () => {
        if (!hasTally()) return [false, 'no tally'];
        const fx = fixture();
        const vp = on(fx);
        annOn(fx, STEM1, annCall(1));
        annOn(fx, STEM2, annCall(2));
        annOn(fx, STEM3, annCall(3));
        vp.enrolFromMapping(STEM1, annMap);
        vp.enrolFromMapping(STEM2, annMap);
        const before = vp.load().people[P_ANN].count;
        vp.enrolFromMapping(STEM3, annMap);
        const after = vp.load().people[P_ANN].count;
        return [before === 1 && after === 2, `${before} -> ${after}`];
    });
    add('61. turning off deletes tally.json; and the launch pass while off deletes one left by a turn-off cut short', () => {
        if (!hasTally()) return [false, 'no tally'];
        const fx = fixture();
        const vp = on(fx);
        annOn(fx, STEM1);
        vp.enrolFromMapping(STEM1, annMap);
        const had = fs.existsSync(vp.tallyPath);
        const gone = vp.disable();
        const afterOff = fs.existsSync(vp.tallyPath);
        // Cut short: the setting says off, but the tally is still there. The
        // turn-off above stripped STEM1's embeddings, so its files are written again.
        vp.enable(mod.STATEMENT_VERSION);
        annOn(fx, STEM1);
        vp.enrolFromMapping(STEM1, annMap);
        fs.writeFileSync(vp.settingPath, JSON.stringify({ enabled: false, turnedOffAt: '2026-11-10T00:00:00.000Z' }) + '\n');
        const left = fs.existsSync(vp.tallyPath);
        const lines = [];
        mod.runRemovalWhileOff(() => open(fx), { reason: 'launch', log: (l) => lines.push(l) });
        const afterPass = fs.existsSync(vp.tallyPath);
        return [had && gone.tally === true && !afterOff && left && !afterPass && lines.length === 1 && lines[0].includes('tally deleted'),
            JSON.stringify({ had, goneTally: gone.tally, afterOff, left, afterPass, lines })];
    });
    add('62. deleting a recording takes its call out of the tally; control: the other call stays', () => {
        if (!hasTally()) return [false, 'no tally'];
        const fx = fixture();
        const vp = on(fx);
        annOn(fx, STEM1, annCall(1));
        annOn(fx, STEM2, annCall(2));
        vp.enrolFromMapping(STEM1, annMap);
        vp.enrolFromMapping(STEM2, annMap);
        const r = vp.removeRecording(STEM1);
        const t = tallyOf(vp);
        return [r.tallied === 1 && JSON.stringify(t.people[P_ANN]) === JSON.stringify([STEM2]), JSON.stringify({ r, t })];
    });
    add('63. deleting a print clears that person\'s tally: their next call alone makes no new print; control: another person\'s tally stays', () => {
        if (!hasTally()) return [false, 'no tally'];
        const fx = fixture();
        const vp = on(fx);
        const both = (stem, a, b) => capture(fx, stem, { voices: [v(1, a), v(2, b)], guests: ['Ann Example', 'Bob Example'] });
        const map2 = { voices: [{ voiceIndex: 1, personId: P_ANN }, { voiceIndex: 2, personId: P_BOB }], them: null };
        both(STEM1, annCall(1), BOB);
        both(STEM2, annCall(2), BOB);
        vp.enrolFromMapping(STEM1, map2);
        vp.enrolFromMapping(STEM2, map2);
        const n = vp.deleteProfiles([P_ANN]);
        const t = tallyOf(vp);
        annOn(fx, STEM3, annCall(3));
        vp.enrolFromMapping(STEM3, annMap);
        const again = !!vp.load().people[P_ANN];
        return [n === 1 && !(P_ANN in t.people) && JSON.stringify(t.people[P_BOB]) === JSON.stringify([STEM1, STEM2]) && !again,
            JSON.stringify({ n, t, again })];
    });
    add('64. the wording (text): empty list, single and several delete detail, and member-setup.md\'s Recognize voices lines, which follow statement version 2 and say setup offers it', () => {
        const DOC = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'member-setup.md'), 'utf8');
        const ok = PAGE.includes("e.textContent = 'None yet. A print is kept once you name someone on two calls.';")
            && HANDLER.includes("const detail = 'Clipwise stops comparing new calls against it. A new print is kept if you name this person on two more calls.';")
            && HANDLER.includes("const detailMany = 'Clipwise stops comparing new calls against them. A new print is kept for anyone you name on two more calls.';")
            && DOC.includes("A print is kept once you've named someone on two calls.")
            && DOC.includes("It keeps a voice print for you and each person you name, on this Mac only, and never uploads them. Some locations require the other person's consent; that's up to you. You can delete any one print, or turn it off to delete them all; your recordings aren't affected.")
            && DOC.includes('1. Open **Recognize voices…** from the menu bar (setup and the "Who was on this call?" window also offer it).')
            && DOC.includes('**Recognize voices (optional).** Next, setup offers **Recognize voices**, the same screen as in section 9. Nothing is turned on unless you click **Turn on**. Click **Not now** to skip it; you can turn it on later from the menu bar.')
            && !DOC.includes("once you've named them on two calls, on this Mac only")
            && !DOC.includes("that's your responsibility")
            && !DOC.includes('It keeps a voice print for you and for each person you name, on this Mac only')
            && !DOC.includes('A print is kept as soon as you name someone on one call')
            && !PAGE.includes('A print is kept once you name someone on a call.')
            && !SRC.includes('A new print is kept the next time you name this person on a call.');
        return [ok, ''];
    });

    // --- The statement in one file (SAA-260 proposal 7, decided 2026-11-11) ---
    // notice/voice-prints-statement-v<N>.txt, read by main.js and sent to every
    // page that shows it; the advice line (SAA-275 part 3) stays outside it.
    const ADVICE = 'Only keep voice prints for people you talk to often. A print just saves you naming them after each call.';
    // Version 1's words exactly as members agreed to them (#statement at 66e367e).
    const STATEMENT_V1_BLOCKS = [
        { tag: 'p', text: "Clipwise learns the voices of people you talk to, so it can tell you who was on a call. It starts naming people once it's reliable." },
        { tag: 'ul', items: [
            'Keeps a voice print for you and each person you name, on this Mac only. Never uploaded.',
            "Some places require the other person's consent. That's up to you.",
            "Turn it off anytime to delete all voice prints. Your recordings aren't affected.",
        ] },
    ];
    // <p id="advice"> comes before <div id="statement">, both present.
    const adviceFirst = (html) => {
        const a = html.indexOf('<p id="advice">');
        const s = html.indexOf('<div id="statement">');
        return a >= 0 && s >= 0 && a < s;
    };
    // Version 2 (decided 2026-11-11): version 1 with its second and third
    // bullets changed, everything else word for word.
    const STATEMENT_V2_BLOCKS = [
        STATEMENT_V1_BLOCKS[0],
        { tag: 'ul', items: [
            STATEMENT_V1_BLOCKS[1].items[0],
            "Some locations require the other person's consent. That's up to you.",
            "Delete any one print, or turn it off anytime to delete them all. Your recordings aren't affected.",
        ] },
    ];
    const statementWords = (blocks) => blocks.flatMap((b) => (b.tag === 'ul' ? b.items : [b.text]));
    add('65. readStatement(1) gives version 1 word for word as members agreed to it (#statement at 66e367e): one paragraph, then three bullets', () => {
        if (typeof mod.readStatement !== 'function') return [false, 'no readStatement'];
        const s = mod.readStatement(1);
        return [s.version === 1 && JSON.stringify(s.blocks) === JSON.stringify(STATEMENT_V1_BLOCKS), JSON.stringify(s.blocks)];
    });
    add('66. control: readStatement reads a copy with the advice added as a bullet as different blocks, and throws for a missing version and a blank file; statementAgreeable refuses null, another version and no blocks', () => {
        if (typeof mod.readStatement !== 'function' || typeof mod.statementAgreeable !== 'function') return [false, 'no readStatement'];
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'check-voice-prints-statement-'));
        const real = fs.readFileSync(path.join(mod.STATEMENT_DIR, mod.statementFile(1)), 'utf8');
        fs.writeFileSync(path.join(d, mod.statementFile(1)), real.replace('\n- ', `\n- ${ADVICE}\n- `));
        fs.writeFileSync(path.join(d, mod.statementFile(2)), '\n  \n');
        const changed = JSON.stringify(mod.readStatement(1, d).blocks) !== JSON.stringify(STATEMENT_V1_BLOCKS);
        const throws = (fn) => { try { fn(); return false; } catch { return true; } };
        const ok = changed && throws(() => mod.readStatement(2, d)) && throws(() => mod.readStatement(99, d))
            && !mod.statementAgreeable(null)
            && !mod.statementAgreeable({ version: mod.STATEMENT_VERSION + 1, blocks: STATEMENT_V1_BLOCKS })
            && !mod.statementAgreeable({ version: mod.STATEMENT_VERSION, blocks: [] })
            && mod.statementAgreeable(mod.readStatement());
        return [ok, JSON.stringify({ changed })];
    });

    // --- SAA-275, the 11-10 finding: the turn-off button and its dialog --------
    add('67. the page: the bottom button is "Delete N…" while N prints are checked, doing what the selection bar\'s "Delete N…" does, and "Turn off and delete prints" with none', () => {
        let ob = null;
        try { ob = pageFunction('offButton'); } catch (err) { return [false, err.message]; }
        const got = [0, 1, 3].map((n) => ob(n));
        const ok = JSON.stringify(got) === JSON.stringify([
            { label: 'Turn off and delete prints', action: 'disable' },
            { label: 'Delete 1…', action: 'delete' },
            { label: 'Delete 3…', action: 'delete' },
        ])
            && PAGE.includes("$('off').addEventListener('click', () => { if (offButton(picked.size).action === 'delete') deletePrints(picked); else ipcRenderer.send('voice-prints:disable'); });")
            && (PAGE.match(/ipcRenderer\.send\('voice-prints:disable'/g) || []).length === 1;
        return [ok, JSON.stringify(got)];
    });
    add('68. the page (text): the bottom button\'s label is redrawn in renderSelbar, which both render and each checkbox change run', () => {
        const at = PAGE.indexOf('\nfunction renderSelbar() {');
        const body = at >= 0 ? PAGE.slice(at, PAGE.indexOf('\n}\n', at)) : '';
        const ok = body.includes("$('off').textContent = offButton(picked.size).label;")
            && PAGE.includes("box.addEventListener('change', () => { if (box.checked) picked.add(personId); else picked.delete(personId); renderSelbar(); });")
            && (PAGE.match(/\n  renderSelbar\(\);\n\}/g) || []).length === 1
            && PAGE.includes('if (!on) { picked.clear(); renderSelbar(); return; }');
        return [ok, `${body.length} chars`];
    });
    add('69. turnOffDialog: "all N voice prints, including yours" from a real store of 5 people and yours; without yours no "including yours"; 1, 0 and an unreadable store each say so; Cancel the default', () => {
        if (typeof mod.turnOffDialog !== 'function') return [false, 'no turnOffDialog'];
        const { vp } = fivePrints();
        const d = (l) => mod.turnOffDialog(l).detail;
        const shape = mod.turnOffDialog(vp.listProfiles());
        const people = (n) => Array.from({ length: n }, (_, i) => ({ personId: P(i + 1), name: `Person ${i + 1}`, count: 2 }));
        const got = {
            six: d(vp.listProfiles()),
            twoNoSelf: d({ self: null, people: people(2) }),
            selfOnly: d({ self: { count: 3 }, people: [] }),
            oneNoSelf: d({ self: null, people: people(1) }),
            none: d({ self: null, people: [] }),
            unread: d(null),
        };
        const ok = got.six === 'This deletes all 6 voice prints, including yours. Your recordings aren’t affected.'
            && got.twoNoSelf === 'This deletes all 2 voice prints. Your recordings aren’t affected.'
            && got.selfOnly === 'This deletes your voice print. Your recordings aren’t affected.'
            && got.oneNoSelf === 'This deletes 1 voice print. Your recordings aren’t affected.'
            && got.none === 'No voice prints are kept yet. Your recordings aren’t affected.'
            && got.unread === 'This deletes all voice prints. Your recordings aren’t affected.'
            && shape.type === 'warning' && shape.message === 'Turn off voice recognition?'
            && JSON.stringify(shape.buttons) === '["Cancel","Turn off and delete prints"]' && shape.defaultId === 0 && shape.cancelId === 0;
        return [ok, JSON.stringify(got)];
    });
    add('70. main.js (text): the turn-off handler builds its dialog with turnOffDialog from listProfiles read at the click, and turns off only after the second button', () => {
        const at = SRC.indexOf("ipcMain.on('voice-prints:disable'");
        const body = at >= 0 ? SRC.slice(at, SRC.indexOf('\n    });\n', at)) : '';
        const ok = body.includes('try { listing = voicePrints().listProfiles(); } catch {}')
            && body.includes('await dialog.showMessageBox(parent(), voicePrintsModule.turnOffDialog(listing));')
            && body.indexOf('if (response !== 1) return;') > body.indexOf('turnOffDialog(listing)')
            && body.indexOf('voicePrints().disable(') > body.indexOf('if (response !== 1) return;')
            && !SRC.includes('All voice prints are deleted.');
        return [ok, `${body.length} chars`];
    });

    add('71. the page (text): voice-prints.html and voice-prints-page.js hold none of the statement\'s or the advice\'s words and no version of their own; #advice and #statement are empty, #advice first; the page draws with textContent only and sends the version it was given', () => {
        const words = [...statementWords(STATEMENT_V1_BLOCKS), ...statementWords(STATEMENT_V2_BLOCKS), ADVICE];
        const ok = words.every((w) => !HTML.includes(w) && !PAGE.includes(w))
            && HTML.includes('<p id="advice"></p>') && HTML.includes('<div id="statement"></div>')
            && adviceFirst(HTML)
            // Control: the same order test is false on a copy with the two swapped.
            && !adviceFirst(HTML.replace('<p id="advice"></p>\n  <div id="statement"></div>', '<div id="statement"></div>\n  <p id="advice"></p>'))
            && !/STATEMENT_VERSION/.test(PAGE) && !/innerHTML|insertAdjacentHTML|outerHTML/.test(PAGE)
            && PAGE.includes("ipcRenderer.send('voice-prints:enable', { statementVersion: statement.version });")
            && /function drawStatement\(statement, advice\) \{/.test(PAGE)
            && PAGE.includes("drawStatement(data && data.statement, data && data.advice);");
        return [ok, JSON.stringify(words.filter((w) => HTML.includes(w) || PAGE.includes(w)))];
    });
    add('72. main.js (text): the window\'s data carries the statement read by readStatement and voice-prints.js\'s ADVICE; the enable handler refuses before anything else when the statement is not agreeable', () => {
        const at = SRC.indexOf("ipcMain.on('voice-prints:enable'");
        const body = at >= 0 ? SRC.slice(at, SRC.indexOf('\n    });\n', at)) : '';
        const ok = /function voicePrintsStatementForPage\(\) \{\s*try \{\s*return voicePrintsModule\.readStatement\(\);/.test(SRC)
            && SRC.includes('const text = { statement: voicePrintsStatementForPage(), advice: voicePrintsModule.ADVICE };')
            && body.indexOf('if (!voicePrintsModule.statementAgreeable(voicePrintsStatementForPage())) {') >= 0
            && body.indexOf('statementAgreeable') < body.indexOf('voicePrints().enable(version)');
        return [ok, `${body.length} chars`];
    });
    add('73. ADVICE is the advice line from 66e367e and is not in the statement file; build-app.sh bundles the notice folder, where the statement file is', () => {
        const file = fs.readFileSync(path.join(mod.STATEMENT_DIR, mod.statementFile(mod.STATEMENT_VERSION)), 'utf8');
        const ok = mod.ADVICE === ADVICE && !file.includes(ADVICE)
            && path.basename(mod.STATEMENT_DIR) === 'notice'
            && BUILD.includes('cp -R "$APP_SRC/notice" "$C/Resources/app/notice"');
        return [ok, ''];
    });

    add('74. the statement in force is version 2: readStatement() gives v2 word for word (v1 with its second and third bullets changed), and enable refuses version 1', () => {
        if (typeof mod.readStatement !== 'function') return [false, 'no readStatement'];
        const s = mod.readStatement();
        const fx = fixture();
        let refusedV1 = false;
        try { open(fx).enable(1); } catch { refusedV1 = true; }
        const ok = mod.STATEMENT_VERSION === 2 && s.version === 2
            && JSON.stringify(s.blocks) === JSON.stringify(STATEMENT_V2_BLOCKS)
            && refusedV1 && !fs.existsSync(path.join(fx.support, 'voice-prints', 'setting.json'));
        return [ok, JSON.stringify({ version: mod.STATEMENT_VERSION, blocks: s.blocks, refusedV1 })];
    });
    add('75. a Mac that agreed to version 1 is asked again: its setting.json (on, statement 1) reads as off, the window gets "off" with the v2 statement, and the launch pass deletes the prints, score log and tally it kept', () => {
        // No early return on code without readStatement (42de118), so the
        // control shows what that code does with the file: on, nothing removed.
        const { vp } = fivePrints();
        const before = { prints: vp.listProfiles().people.length, self: !!vp.listProfiles().self, tally: fs.existsSync(vp.tallyPath), scores: fs.existsSync(vp.scoresPath) };
        // What 42de118 wrote when its "Turn on" was clicked.
        fs.writeFileSync(path.join(vp.dir, 'setting.json'), JSON.stringify({ enabled: true, statementVersion: 1, consentedAt: '2026-11-01T10:00:00.000Z' }) + '\n', { mode: 0o600 });
        const offNow = vp.isEnabled() === false;
        const pageStatement = typeof mod.readStatement === 'function' ? mod.readStatement() : null;
        const r = mod.runRemovalWhileOff(() => vp, { reason: 'launch', skip: () => false, log: () => {} });
        const gone = !fs.existsSync(vp.profilesPath) && !fs.existsSync(vp.tallyPath) && !fs.existsSync(vp.scoresPath);
        const ok = before.prints === 5 && before.self && before.tally && before.scores
            && offNow && !!pageStatement && pageStatement.version === 2 && mod.statementAgreeable(pageStatement)
            && r.profiles === true && gone;
        return [ok, JSON.stringify({ before, offNow, removed: r.skipped ? r : { profiles: r.profiles, tally: r.tally, scores: r.scores }, gone, statement: pageStatement && pageStatement.version })];
    });

    for (const [name, fn] of cases) {
        const needsModule = !/^(2[2-5]|39|4[0-2]|5[1-4]|64|6[7-8]|7[0-2])\./.test(name);
        if (needsModule && !mod) { check(name, false, why); continue; }
        let result;
        try { result = fn(); } catch (err) { result = [false, `threw ${err.message}`]; }
        check(name, result[0], result[1]);
    }
    console.log(`\n${cases.length - failures}/${cases.length} passed`);
    process.exit(failures === 0 ? 0 : 1);
}

main();
