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
// wiring is there, not that it runs. The module is required inside main(), so
// on code without it every case is reported as a FAIL.

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
    add('25. build-app.sh (text): copies capture-payload.js, voice-prints.js, voice-match.js and voice-prints.html into the bundle', () => {
        const files = ['capture-payload.js', 'voice-prints.js', 'voice-match.js', 'voice-prints.html'];
        const missing = files.filter((f) => !BUILD.includes(`cp "$APP_SRC/${f}" "$C/Resources/app/${f}"`));
        return [missing.length === 0, missing.join(', ')];
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
