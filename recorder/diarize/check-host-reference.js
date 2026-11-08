#!/usr/bin/env node
// Can diarize's host reference be trusted when someone else in the room
// speaks into the member's mic (SAA-224 case 3, part A)? Synthetic audio
// only: every voice is macOS `say`, nothing is read from a real recording or
// a real voice print.
//
//   node check-host-reference.js            (diarize from .build/release)
//   DIARIZE_BIN=/path/to/diarize node check-host-reference.js
//
// Three fixtures share one far-end voice on the call audio (tap) and one host
// voice on the mic, with quiet gaps on the call audio between turns:
//   in-room-in-gaps   a second voice on the mic, speaking while the call
//                     audio is quiet, so it falls into the windows the host
//                     reference is built from (main.swift:623-660)
//   in-room-overlap   the second voice speaks only while the far end talks,
//                     so the reference stays clean
//   control           the host alone on the mic (positive control)
//
// Each fixture is run through diarize with prints off (no
// CLIPWISE_SAVE_HOST_PRINT), in its own temp folder. A mic line counts as
// credited to the host when hostVoiceRanges covers at least half of it, the
// majority rule assignVoice uses for `them` lines.
//
// Required, correct or absent:
//   safety     no in-room line is credited to the host, on any fixture
//   detection  on in-room-in-gaps the sidecar reports the reference as not
//              usable (hostReference.usable === false) and credits no mic
//              line at all (decision 1: leave every mic line unnamed, count
//              the call)
//   control    on control at least 80% of host lines are credited, and the
//              reference is not reported unusable
//   prints off no host-print-<stem>.json is written
// Exit 0 only when every requirement holds.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const HERE = __dirname;
const DIARIZE_BIN = process.env.DIARIZE_BIN || path.join(HERE, '.build', 'release', 'diarize');
const MODELS = path.join(HERE, 'models');
const RATE = 16000;
const STEM = '2026-11-06T12-00-00Z';

// say voice names; CHECK_VOICE_IN_ROOM etc. swap one for a run.
const VOICES = {
    host: process.env.CHECK_VOICE_HOST || 'Samantha',
    inRoom: process.env.CHECK_VOICE_IN_ROOM || 'Karen',
    farEnd: process.env.CHECK_VOICE_FAR_END || 'Daniel',
};

// Far-end turns are three sentences, so a short in-room line fits inside one.
const FAR_END = [
    ['Thanks for making time today.', 'I wanted to walk through the schedule for next month.', 'There are a few dates that moved.'],
    ['The first change is the planning session.', 'It is now on the second Tuesday instead of the first.', 'The room is the same as before.'],
    ['Second, the budget review slipped a week.', 'Finance asked for more time to close the quarter.', 'That pushes the summary out as well.'],
    ['Third, we are adding a site visit.', 'It will take most of a day, including travel.', 'I will send the address separately.'],
    ['On staffing, two people join in the spring.', 'Both of them start on the same Monday.', 'We should plan their first week together.'],
    ['For the vendor contract, legal has comments.', 'Most of them are small wording changes.', 'One of them is about the renewal term.'],
    ['The office move is still on track.', 'Boxes arrive the week before the move.', 'Everyone packs their own desk.'],
    ['Last thing, the holiday party date is set.', 'It is the third Friday in December.', 'Invitations go out next week.'],
];
const HOST = [
    ['That sounds good to me.', 'Go ahead whenever you are ready.'],
    ['The second Tuesday works for my side.', 'I will move the other meeting.'],
    ['A week later is fine.', 'Can you send me the new date in writing?'],
    ['I can join the site visit.', 'Please share the travel plan early.'],
    ['I will put together an outline for that first week.', 'We can review it together.'],
    ['I would like to see the renewal comment first.', 'The rest can wait for the final draft.'],
    ['Good, my desk is mostly packed already.', 'I only need a couple of boxes.'],
    ['Great, I will put it in my calendar.', 'Thanks for walking me through all of this.'],
];
// Lines from the second person in the room. In-gaps uses them after the
// host's turn; overlap uses the short form inside a far-end turn.
const IN_ROOM = [
    'Ask them about the parking.',
    'I thought that was already decided.',
    'Tell them we are away that week.',
    'Is lunch included on that day?',
    'Mention that your laptop is old.',
    'You told me that last month.',
    'We still have boxes in the garage.',
    'Do not forget the gift exchange.',
];

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n     ${detail}` : ''}`);
    if (!ok) failures++;
}

// --- WAV in and out (16 kHz mono 16-bit PCM) ---

function readWavPcm16(file) {
    const buf = fs.readFileSync(file);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAVE file`);
    let off = 12;
    let fmt = null;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        const body = off + 8;
        if (id === 'fmt ') {
            fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
        } else if (id === 'data') {
            if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) {
                throw new Error(`${file}: expected 16 kHz mono PCM16, got ${JSON.stringify(fmt)}`);
            }
            const n = Math.floor(size / 2);
            const out = new Int16Array(n);
            for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(body + i * 2);
            return out;
        }
        off = body + size + (size % 2);
    }
    throw new Error(`${file}: no data chunk`);
}

function writeWavPcm16(file, samples) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + samples.length * 2, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(RATE, 24);
    header.writeUInt32LE(RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(samples.length * 2, 40);
    const data = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], i * 2);
    fs.writeFileSync(file, Buffer.concat([header, data]));
}

// --- Synthetic speech ---

const sayCache = new Map();
function speak(dir, voice, text) {
    const key = `${voice}\u0000${text}`;
    if (sayCache.has(key)) return sayCache.get(key);
    const file = path.join(dir, `say-${sayCache.size}.wav`);
    execFileSync('say', ['-v', voice, '-o', file, '--file-format=WAVE', '--data-format=LEI16@16000', text]);
    const pcm = readWavPcm16(file);
    sayCache.set(key, pcm);
    return pcm;
}

// Deterministic low noise floor (about -60 dBFS) so neither track is digital
// silence between turns.
function noise(n, seed) {
    let s = seed >>> 0;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        s = (s * 1664525 + 1013904223) >>> 0;
        out[i] = ((s / 4294967296) - 0.5) * 60;
    }
    return out;
}

// events: [{ track: 'mic'|'tap', who, pcm, at }] -> { mic, tap, lines }
function mix(events, seconds) {
    const n = Math.ceil(seconds * RATE);
    const tracks = { mic: noise(n, 1), tap: noise(n, 2) };
    const lines = [];
    for (const e of events) {
        const start = Math.round(e.at * RATE);
        const t = tracks[e.track];
        for (let i = 0; i < e.pcm.length && start + i < n; i++) t[start + i] += e.pcm[i];
        lines.push({ track: e.track, who: e.who, start: e.at, end: e.at + e.pcm.length / RATE });
    }
    const toInt = (f) => Int16Array.from(f, (x) => Math.max(-32768, Math.min(32767, Math.round(x))));
    return { mic: toInt(tracks.mic), tap: toInt(tracks.tap), lines };
}

function buildFixture(dir, kind) {
    const gap = 0.7;
    const turnGap = 1.5;
    const events = [];
    let t = 1.0;
    for (let round = 0; round < FAR_END.length; round++) {
        const farStart = t;
        for (const sentence of FAR_END[round]) {
            const pcm = speak(dir, VOICES.farEnd, sentence);
            events.push({ track: 'tap', who: 'farEnd', pcm, at: t });
            t += pcm.length / RATE + 0.3;
        }
        const farEnd = t - 0.3;
        if (kind === 'in-room-overlap') {
            const pcm = speak(dir, VOICES.inRoom, IN_ROOM[round]);
            const at = farStart + 1.0;
            if (at + pcm.length / RATE > farEnd - 0.3) throw new Error(`fixture: in-room line ${round} runs past the far-end turn`);
            events.push({ track: 'mic', who: 'inRoom', pcm, at });
        }
        t = farEnd + turnGap;
        for (const sentence of HOST[round]) {
            const pcm = speak(dir, VOICES.host, sentence);
            events.push({ track: 'mic', who: 'host', pcm, at: t });
            t += pcm.length / RATE + gap;
        }
        if (kind === 'in-room-in-gaps') {
            const pcm = speak(dir, VOICES.inRoom, IN_ROOM[round]);
            events.push({ track: 'mic', who: 'inRoom', pcm, at: t });
            t += pcm.length / RATE + gap;
        }
        t += turnGap - gap;
    }
    return mix(events, t + 1.0);
}

// --- Scoring ---

function overlap(a0, a1, ranges) {
    let s = 0;
    for (const r of ranges) s += Math.max(0, Math.min(a1, r.end) - Math.max(a0, r.start));
    return s;
}

function runFixture(root, kind) {
    const dir = path.join(root, kind);
    fs.mkdirSync(dir);
    const fx = buildFixture(root, kind);
    const tapWav = path.join(dir, `tap-${STEM}.16k.wav`);
    const micWav = path.join(dir, `mic-${STEM}.16k.wav`);
    const out = path.join(dir, `diarize-${STEM}.json`);
    writeWavPcm16(tapWav, fx.tap);
    writeWavPcm16(micWav, fx.mic);
    // Prints off: no CLIPWISE_SAVE_HOST_PRINT. A minimal environment, its own
    // HOME and TMPDIR inside the fixture folder.
    const env = { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir + path.sep };
    const run = spawnSync(DIARIZE_BIN, [tapWav, micWav, MODELS, out], { env, encoding: 'utf8' });
    fs.writeFileSync(path.join(dir, 'diarize.stderr.log'), run.stderr || '');
    const sidecar = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
    const log = (run.stderr || '').split('\n').filter((l) => /host reference|mic cluster|host-classified|no host reference/.test(l));
    const ranges = sidecar && Array.isArray(sidecar.hostVoiceRanges) ? sidecar.hostVoiceRanges : [];
    const micLines = fx.lines.filter((l) => l.track === 'mic').map((l) => {
        const covered = overlap(l.start, l.end, ranges) / (l.end - l.start);
        return { ...l, covered, credited: covered >= 0.5 };
    });
    const count = (who, pred) => micLines.filter((l) => l.who === who && pred(l)).length;
    return {
        kind, dir, status: run.status, error: run.error || (sidecar && sidecar.error) || null, sidecar, log, micLines,
        hostLines: count('host', () => true), hostCredited: count('host', (l) => l.credited),
        inRoomLines: count('inRoom', () => true), inRoomCredited: count('inRoom', (l) => l.credited),
        hostPrintWritten: fs.existsSync(path.join(dir, `host-print-${STEM}.json`)),
    };
}

function report(r) {
    console.log(`\n== ${r.kind}  (${r.dir})`);
    console.log(`   diarize exit ${r.status}${r.error ? `, error: ${r.error}` : ''}`);
    for (const l of r.log) console.log(`   | ${l.replace(/^diarize: /, '')}`);
    console.log(`   host lines credited: ${r.hostCredited}/${r.hostLines}` +
        (r.inRoomLines ? `   in-room lines credited to host: ${r.inRoomCredited}/${r.inRoomLines}` : ''));
    for (const l of r.micLines) {
        console.log(`     ${l.who.padEnd(6)} ${l.start.toFixed(1).padStart(6)}-${l.end.toFixed(1).padEnd(6)} covered ${(l.covered * 100).toFixed(0).padStart(3)}%${l.credited ? '  -> host' : ''}`);
    }
    const ref = r.sidecar ? r.sidecar.hostReference : undefined;
    console.log(`   sidecar hostReference: ${ref === undefined ? '(absent)' : JSON.stringify(ref)}`);
}

function main() {
    if (!fs.existsSync(DIARIZE_BIN)) {
        console.log(`FAIL diarize binary not found at ${DIARIZE_BIN} (swift build -c release in recorder/diarize)`);
        process.exit(1);
    }
    if (!fs.existsSync(path.join(MODELS, 'speaker-diarization'))) {
        console.log(`FAIL models not found at ${MODELS}/speaker-diarization (fetch-models.sh)`);
        process.exit(1);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-check-host-reference-'));
    console.log(`fixtures in ${root}`);
    console.log(`voices: host=${VOICES.host}, in-room=${VOICES.inRoom}, far end=${VOICES.farEnd}`);
    const results = {};
    for (const kind of ['control', 'in-room-in-gaps', 'in-room-overlap']) {
        results[kind] = runFixture(root, kind);
        report(results[kind]);
    }
    console.log('');
    for (const r of Object.values(results)) {
        check(`${r.kind}: diarize ran and wrote a sidecar with no error`, r.status === 0 && r.sidecar && !r.error, `exit ${r.status}, error ${r.error}`);
    }
    const c = results.control;
    check('control (positive): at least 80% of host lines credited to the host',
        c.hostCredited >= Math.ceil(0.8 * c.hostLines), `${c.hostCredited}/${c.hostLines}`);
    check('control: the reference is not reported unusable',
        !(c.sidecar && c.sidecar.hostReference && c.sidecar.hostReference.usable === false),
        c.sidecar && c.sidecar.hostReference ? JSON.stringify(c.sidecar.hostReference) : '');
    for (const kind of ['in-room-in-gaps', 'in-room-overlap']) {
        const r = results[kind];
        check(`${kind} (safety): no in-room line credited to the host`, r.inRoomCredited === 0, `${r.inRoomCredited}/${r.inRoomLines} in-room lines credited`);
    }
    const g = results['in-room-in-gaps'];
    const gRef = g.sidecar ? g.sidecar.hostReference : undefined;
    check('in-room-in-gaps (detection): the sidecar reports the reference as not usable',
        !!gRef && gRef.usable === false, gRef === undefined ? 'no hostReference in the sidecar' : JSON.stringify(gRef));
    check('in-room-in-gaps (decision 1): with an unusable reference, no mic line is credited',
        g.hostCredited + g.inRoomCredited === 0, `${g.hostCredited + g.inRoomCredited} mic lines credited`);
    for (const r of Object.values(results)) {
        check(`${r.kind} (prints off): no host print written`, !r.hostPrintWritten);
    }
    console.log(`\n${failures === 0 ? 'all requirements hold' : `${failures} requirement(s) failed`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main();
