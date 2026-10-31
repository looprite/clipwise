#!/usr/bin/env node
// The matcher, watch only (SAA-260 step 3): each voice scored against the
// prints on this Mac and logged, naming no one.
//
//   node check-voice-match.js
//
// Runs voice-match.js and voice-prints.js against temporary folders, with a
// stand-in for safeStorage, on made-up 256-number vectors: a person's two calls
// are one base vector plus small noise; different people are unrelated. The
// modules are required inside main(), so on code without them every case is
// reported as a FAIL.

const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `\n     ${detail}`}`);
    if (!ok) failures++;
}

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
const CY = vector(44);
const SELF = vector(33);
const call = (base, n) => plus(base, vector(100 + n, 0.15));

const KEY = Buffer.from('stand-in key for the check only');
const xor = (buf) => Buffer.from(buf.map((b, i) => b ^ KEY[i % KEY.length]));
const encrypt = (s) => Buffer.from(xor(Buffer.from(s, 'utf8')).toString('base64'), 'ascii');
const decrypt = (b) => xor(Buffer.from(b.toString('ascii'), 'base64')).toString('utf8');

const STEM1 = '2026-10-31T10-00-00Z';
const STEM2 = '2026-10-31T11-00-00Z';
const P_ANN = '11111111-1111-4111-8111-111111111111';
const P_BOB = '22222222-2222-4222-8222-222222222222';
const v = (voiceIndex, embedding, totalSeconds = 30) => ({ voiceIndex, totalSeconds, embedding, clipRanges: [] });

function fixture() {
    const support = fs.mkdtempSync(path.join(os.tmpdir(), 'check-voice-match-'));
    const outdir = path.join(support, 'recordings');
    fs.mkdirSync(outdir);
    const write = (name, doc) => fs.writeFileSync(path.join(outdir, name), JSON.stringify(doc));
    return { support, outdir, write };
}

function main() {
    let prints = null;
    let match = null;
    let why = '';
    try {
        prints = require('./voice-prints.js');
        match = require('./voice-match.js');
    } catch (err) {
        why = `module not present (${err.code || err.name})`;
    }
    const cases = [];
    const add = (name, fn) => cases.push([name, fn]);

    // Ann and Bob enrolled from one call (STEM1), the member's own print in.
    const enrolled = (fx) => {
        const vp = prints.createVoicePrints({ supportDir: fx.support, outdir: fx.outdir, encrypt, decrypt });
        vp.enable(prints.STATEMENT_VERSION);
        fx.write(`host-print-${STEM1}.json`, { embedding: SELF });
        vp.ingestHostPrint(STEM1);
        fx.write(`diarize-${STEM1}.json`, { modelRevision: 'r', voices: [v(1, call(ANN, 1)), v(2, call(BOB, 1))], segments: [] });
        fx.write(`identity-${STEM1}.json`, { guests: [{ name: 'Ann Example' }, { name: 'Bob Example' }] });
        fx.write(`voice-names-${STEM1}.json`, { voices: [{ voiceIndex: 1, name: 'Ann Example' }, { voiceIndex: 2, name: 'Bob Example' }] });
        vp.enrolFromMapping(STEM1, { voices: [{ voiceIndex: 1, personId: P_ANN }, { voiceIndex: 2, personId: P_BOB }], them: null });
        return vp;
    };
    const matchLines = (vp, stem) => vp.readScoreLines().filter((l) => l.kind === 'match' && l.stem === stem);

    add('1. a later call\'s voice from Ann: best is Ann with a high score, runner-up is Bob with a low one', () => {
        const fx = fixture();
        const vp = enrolled(fx);
        fx.write(`diarize-${STEM2}.json`, { modelRevision: 'r', voices: [v(1, call(ANN, 2))], segments: [] });
        const r = match.matchCapture(vp, fx.outdir, STEM2);
        const [l] = matchLines(vp, STEM2);
        return [r.voices === 1 && l && l.best.id === P_ANN && l.best.score > 0.9 && l.runnerUp.id === P_BOB && l.runnerUp.score < 0.3 && l.profiles === 2, JSON.stringify(l)];
    });
    add('2. control (someone new): Cy, who has no print, scores low against everyone', () => {
        const fx = fixture();
        const vp = enrolled(fx);
        fx.write(`diarize-${STEM2}.json`, { modelRevision: 'r', voices: [v(1, call(CY, 2))], segments: [] });
        match.matchCapture(vp, fx.outdir, STEM2);
        const [l] = matchLines(vp, STEM2);
        return [l && l.best.score < 0.3 && l.runnerUp.score < 0.3, JSON.stringify(l)];
    });
    add('3. control (no prints yet): best and runner-up are null', () => {
        const fx = fixture();
        const vp = prints.createVoicePrints({ supportDir: fx.support, outdir: fx.outdir, encrypt, decrypt });
        vp.enable(prints.STATEMENT_VERSION);
        fx.write(`diarize-${STEM2}.json`, { modelRevision: 'r', voices: [v(1, call(ANN, 2))], segments: [] });
        match.matchCapture(vp, fx.outdir, STEM2);
        const [l] = matchLines(vp, STEM2);
        return [l && l.best === null && l.runnerUp === null && l.profiles === 0 && l.self === null, JSON.stringify(l)];
    });
    add('4. every voice gets its score against the member\'s own print: high for the member\'s echo, low for Ann', () => {
        const fx = fixture();
        const vp = enrolled(fx);
        fx.write(`diarize-${STEM2}.json`, { modelRevision: 'r', voices: [v(1, call(ANN, 2)), v(2, plus(SELF, vector(9, 0.1)))], segments: [] });
        match.matchCapture(vp, fx.outdir, STEM2);
        const ls = matchLines(vp, STEM2);
        const byVoice = Object.fromEntries(ls.map((l) => [l.voice, l.self]));
        return [ls.length === 2 && byVoice[1] < 0.3 && byVoice[2] > 0.9, JSON.stringify(byVoice)];
    });
    add('5. a capture processed again is scored without its own contributions (Ann\'s one print came from it, so it is not there)', () => {
        const fx = fixture();
        const vp = enrolled(fx);
        match.matchCapture(vp, fx.outdir, STEM1);
        const ls = matchLines(vp, STEM1);
        return [ls.length === 2 && ls.every((l) => l.profiles === 0 && l.best === null && l.self === null), JSON.stringify(ls)];
    });
    add('6. the log line holds ids, scores, the stem and the voice index only: no name, no embedding', () => {
        const fx = fixture();
        const vp = enrolled(fx);
        fx.write(`diarize-${STEM2}.json`, { modelRevision: 'r', voices: [v(1, call(ANN, 2))], segments: [] });
        match.matchCapture(vp, fx.outdir, STEM2);
        const text = fs.readFileSync(vp.scoresPath, 'utf8');
        const [l] = matchLines(vp, STEM2);
        const keys = Object.keys(l).sort().join(',');
        const embeddingNumber = String(call(ANN, 2)[0]);
        return [!text.includes('Ann Example') && !text.includes('Bob Example') && !text.includes(embeddingNumber)
            && keys === 'at,best,kind,modelRevision,profiles,runnerUp,seconds,self,stem,voice', keys];
    });
    add('7. control: the same scan finds a name planted in a copy of the log', () => {
        const fx = fixture();
        const vp = enrolled(fx);
        const planted = fs.readFileSync(vp.scoresPath, 'utf8') + JSON.stringify({ planted: 'Ann Example' }) + '\n';
        return [planted.includes('Ann Example'), ''];
    });
    add('8. while off, nothing is read or written', () => {
        const fx = fixture();
        const vp = prints.createVoicePrints({ supportDir: fx.support, outdir: fx.outdir, encrypt, decrypt });
        fx.write(`diarize-${STEM2}.json`, { modelRevision: 'r', voices: [v(1, call(ANN, 2))], segments: [] });
        const r = match.matchCapture(vp, fx.outdir, STEM2);
        return [r.skipped === 'off' && !fs.existsSync(vp.dir), JSON.stringify(r)];
    });
    add('9. control: turned on, the same call writes one line', () => {
        const fx = fixture();
        const vp = prints.createVoicePrints({ supportDir: fx.support, outdir: fx.outdir, encrypt, decrypt });
        vp.enable(prints.STATEMENT_VERSION);
        fx.write(`diarize-${STEM2}.json`, { modelRevision: 'r', voices: [v(1, call(ANN, 2))], segments: [] });
        const r = match.matchCapture(vp, fx.outdir, STEM2);
        return [r.voices === 1 && matchLines(vp, STEM2).length === 1, JSON.stringify(r)];
    });
    add('10. a 1:1 call (one voice) is matched too', () => {
        const fx = fixture();
        const vp = enrolled(fx);
        fx.write(`diarize-${STEM2}.json`, { modelRevision: 'r', voices: [v(1, call(BOB, 3))], segments: [] });
        match.matchCapture(vp, fx.outdir, STEM2);
        const [l] = matchLines(vp, STEM2);
        return [l && l.best.id === P_BOB, JSON.stringify(l)];
    });

    for (const [name, fn] of cases) {
        if (!prints || !match) { check(name, false, why); continue; }
        let result;
        try { result = fn(); } catch (err) { result = [false, `threw ${err.message}`]; }
        check(name, result[0], result[1]);
    }
    console.log(`\n${cases.length - failures}/${cases.length} passed`);
    process.exit(failures === 0 ? 0 : 1);
}

main();
