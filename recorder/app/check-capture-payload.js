#!/usr/bin/env node
// Nothing from the voice prints on this Mac reaches POST /captures (SAA-260
// step 3): the body capture-payload.js builds from a capture's files carries
// none of the store's numbers, none of a waiting host print's, none of the
// diarize file's embeddings, and none of the store's or score log's keys.
//
//   node check-capture-payload.js
//
// A fixture support folder holds one capture's files (transcript, manifest,
// pipeline record, identity answer, voice names, diarize file with made-up
// 256-number embeddings), plus, with voice prints on: the store (encrypted
// with a stand-in for safeStorage), its score log, and a host print still
// waiting to be taken in. The body is built from that folder and scanned for
// every number in them (each printed as JSON prints it, those with at least 6
// digits) and for their keys. The controls plant one of each into a copy of
// the body and find it. The modules are required inside main(), so on code
// without them every case is reported as a FAIL.

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
const vector = (seed) => { const r = rng(seed); return Array.from({ length: 256 }, () => r()); };

const KEY = Buffer.from('stand-in key for the check only');
const xor = (buf) => Buffer.from(buf.map((b, i) => b ^ KEY[i % KEY.length]));
const encrypt = (s) => Buffer.from(xor(Buffer.from(s, 'utf8')).toString('base64'), 'ascii');
const decrypt = (b) => xor(Buffer.from(b.toString('ascii'), 'base64')).toString('utf8');

const STEM = '2026-10-31T10-00-00Z';
const EARLIER = '2026-10-30T10-00-00Z';
const LATER = '2026-10-31T12-00-00Z';
const P_ANN = '11111111-1111-4111-8111-111111111111';
const P_BOB = '22222222-2222-4222-8222-222222222222';

// Every key in a JSON value, recursively.
function keysOf(x, out = new Set()) {
    if (Array.isArray(x)) x.forEach((y) => keysOf(y, out));
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) { out.add(k); keysOf(y, out); }
    return out;
}
const longNumbers = (arr) => arr.map(String).filter((s) => s.replace(/[^0-9]/g, '').length >= 6);

function build() {
    const support = fs.mkdtempSync(path.join(os.tmpdir(), 'check-capture-payload-'));
    const outdir = path.join(support, 'recordings');
    fs.mkdirSync(outdir);
    const write = (name, doc) => fs.writeFileSync(path.join(outdir, name), JSON.stringify(doc));
    const segs = [
        { track: 'me', start_ms: 0, end_ms: 1500, text: 'opening' },
        { track: 'them', start_ms: 2000, end_ms: 4000, text: 'first' },
        { track: 'them', start_ms: 5000, end_ms: 7000, text: 'second' },
    ];
    write(`transcript-${STEM}.json`, { engine: 'parakeet', model: 'check-model', segments: segs, content: { words: 3 } });
    write(`manifest-${STEM}.json`, { recording_id: 'ABCDEF01-2345-4678-89AB-CDEF01234567', started_at: '2026-10-31T10:00:00.000Z', tracks: [], permissions: { tap: 'granted', mic: 'granted' }, trigger_app: null });
    write(`pipeline-${STEM}.json`, { steps: { classify: { detail: { classification: { verdict: 'both_present', concern: false, reason: 'check', excludedLabels: [], tracks: {}, thresholds: {} } } } } });
    write(`identity-${STEM}.json`, { identity_version: 2, answered_at: '2026-10-31T10:30:00.000Z', self: { name: 'Check Host', source: 'recorder_identity_prompt' }, guests: [{ name: 'Ann Example' }, { name: 'Bob Example' }], scope: 'work' });
    write(`voice-names-${STEM}.json`, { voice_names_version: 1, answered_at: '2026-10-31T10:40:00.000Z', voices: [{ voiceIndex: 1, name: 'Ann Example' }, { voiceIndex: 2, name: 'Bob Example' }] });
    const voices = [
        { voiceIndex: 1, sourceLabel: 'S1', totalSeconds: 2, embedding: vector(1), clipRanges: [] },
        { voiceIndex: 2, sourceLabel: 'S2', totalSeconds: 2, embedding: vector(2), clipRanges: [] },
    ];
    write(`diarize-${STEM}.json`, { model: 'fluidaudio-community-1', modelRevision: 'r', voices, segments: [{ start: 2, end: 4, voiceIndex: 1 }, { start: 5, end: 7, voiceIndex: 2 }] });

    const prints = require('./voice-prints.js');
    const { matchCapture } = require('./voice-match.js');
    const { buildCapturePayload } = require('./capture-payload.js');
    const vp = prints.createVoicePrints({ supportDir: support, outdir, encrypt, decrypt });
    vp.enable(prints.STATEMENT_VERSION);
    // The member's own print from an earlier call, taken in; one from a later
    // call still waiting in the recordings folder.
    write(`host-print-${EARLIER}.json`, { embedding: vector(3), seconds: 20 });
    vp.ingestHostPrint(EARLIER);
    const waiting = { embedding: vector(4), seconds: 20 };
    write(`host-print-${LATER}.json`, waiting);
    matchCapture(vp, outdir, STEM);
    vp.enrolFromMapping(STEM, { voices: [{ voiceIndex: 1, personId: P_ANN }, { voiceIndex: 2, personId: P_BOB }], them: null });

    const store = vp.load();
    const storeNumbers = longNumbers([
        ...Object.values(store.people).flatMap((p) => [...p.embedding, ...p.sources.flatMap((s) => s.vec)]),
        ...store.self.embedding, ...store.self.sources.flatMap((s) => s.vec),
    ]);
    const body = buildCapturePayload(outdir, STEM);
    return {
        prints, vp, store, body, text: JSON.stringify(body),
        storeNumbers,
        hostNumbers: longNumbers(waiting.embedding),
        diarizeNumbers: longNumbers(voices.flatMap((x) => x.embedding)),
        scoreKeys: [...keysOf(vp.readScoreLines())],
        storeKeys: [...keysOf(store)],
    };
}

function main() {
    let f = null;
    let why = '';
    try {
        f = build();
    } catch (err) {
        why = err.code === 'MODULE_NOT_FOUND' ? `module not present (${err.message.split('\n')[0]})` : `fixture failed: ${err.message}`;
    }
    const cases = [
        ['1. the fixture has what the scan looks for: a store with Ann, Bob and the member\'s own print, score lines, a waiting host print', () =>
            [Object.keys(f.store.people).length === 2 && f.store.self && f.storeNumbers.length >= 1000 && f.hostNumbers.length >= 200
                && f.diarizeNumbers.length >= 400 && f.scoreKeys.includes('best') && f.scoreKeys.includes('runnerUp'),
            `${f.storeNumbers.length} store, ${f.hostNumbers.length} host, ${f.diarizeNumbers.length} diarize numbers; score keys ${f.scoreKeys.join(',')}`]],
        ['2. the body is the capture it should be: three segments, voices as index and seconds only, the answer and the voice names', () => {
            const voices = f.body.voices || [];
            return [f.body.segments.length === 3 && f.body.segments[1].voiceIndex === 1 && f.body.segments[2].voiceIndex === 2
                && voices.length === 2 && voices.every((x) => Object.keys(x).sort().join(',') === 'totalSeconds,voiceIndex')
                && f.body.identity.guests.length === 2 && f.body.voiceNames.voices.length === 2, JSON.stringify(voices)];
        }],
        ['3. the body holds none of the store\'s numbers (every one checked)', () => {
            const found = f.storeNumbers.filter((n) => f.text.includes(n));
            return [found.length === 0, `${found.length} found, e.g. ${found.slice(0, 3).join(' ')}`];
        }],
        ['4. the body holds none of the waiting host print\'s numbers', () => {
            const found = f.hostNumbers.filter((n) => f.text.includes(n));
            return [found.length === 0, `${found.length} found`];
        }],
        ['5. the body holds none of the diarize file\'s embedding numbers', () => {
            const found = f.diarizeNumbers.filter((n) => f.text.includes(n));
            return [found.length === 0, `${found.length} found`];
        }],
        ['6. the body, with `identity` left out (its self and, from step 4, guests[].personId are the answer\'s own), has none of the store\'s or the score log\'s keys (embedding, vec, sources, best, runnerUp, profiles, self, personId)', () => {
            const withoutIdentity = { ...f.body };
            delete withoutIdentity.identity;
            const bodyKeys = keysOf(withoutIdentity);
            const theirs = ['embedding', 'vec', 'sources', 'best', 'runnerUp', 'profiles', 'self', 'personId'];
            const hit = theirs.filter((k) => bodyKeys.has(k));
            return [hit.length === 0, hit.join(',')];
        }],
        ['7. control: one store number planted in a copy of the body is found', () => {
            const planted = JSON.stringify({ ...f.body, planted: [Number(f.storeNumbers[0])] });
            return [planted.includes(f.storeNumbers[0]), f.storeNumbers[0]];
        }],
        ['8. control: one host-print and one diarize number planted in a copy are found', () => {
            const planted = JSON.stringify({ ...f.body, planted: [Number(f.hostNumbers[0]), Number(f.diarizeNumbers[0])] });
            return [planted.includes(f.hostNumbers[0]) && planted.includes(f.diarizeNumbers[0]), ''];
        }],
        ['9. control: an `embedding` key planted in a copy of the body (outside identity) is found', () => {
            const planted = { ...f.body, voices: [{ ...f.body.voices[0], embedding: [0.5] }] };
            delete planted.identity;
            return [keysOf(planted).has('embedding'), ''];
        }],
    ];
    for (const [name, fn] of cases) {
        if (!f) { check(name, false, why); continue; }
        let result;
        try { result = fn(); } catch (err) { result = [false, `threw ${err.message}`]; }
        check(name, result[0], result[1]);
    }
    console.log(`\n${cases.length - failures}/${cases.length} passed`);
    process.exit(failures === 0 ? 0 : 1);
}

main();
