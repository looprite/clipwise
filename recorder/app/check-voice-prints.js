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
// against temporary folders, with files the shape diarize writes. The module
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
        capture(fx, STEM1, { voices: [v(1, ANN)], guests: ['Ann Example'], voiceNames: [{ voiceIndex: 1, name: 'Ann Example' }] });
        const r = vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        const list = vp.listProfiles().people;
        return [r.enrolled === 1 && list.length === 1 && list[0].personId === P_ANN && list[0].count === 1 && list[0].name === 'Ann Example', JSON.stringify({ r, list })];
    });
    add('3. a second call averages the normalised contributions (count 2), and the profile stays a unit vector close to both', () => {
        const fx = fixture();
        const vp = on(fx);
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
            && lines.length > 0 && lines.every((l) => l.stem === STEM2), JSON.stringify({ r, lines: lines.map((l) => l.stem) })];
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
        const r3 = vp.enrolFromMapping(STEM3, { voices: [{ voiceIndex: 1, personId: P_ANN }], them: null });
        return [r1.enrolled === 0 && r1.refused === 2 && reasons.length === 2 && reasons.every((x) => x === 'no_embedding') && r3.enrolled === 1, JSON.stringify({ r1, reasons, r3 })];
    });

    for (const [name, fn] of cases) {
        const needsModule = !/^2[2-5]\./.test(name);
        if (needsModule && !mod) { check(name, false, why); continue; }
        let result;
        try { result = fn(); } catch (err) { result = [false, `threw ${err.message}`]; }
        check(name, result[0], result[1]);
    }
    console.log(`\n${cases.length - failures}/${cases.length} passed`);
    process.exit(failures === 0 ? 0 : 1);
}

main();
