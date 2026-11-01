#!/usr/bin/env node
// The "Who was on this call?" window as the app shows it (SAA-260 step 4): the
// real main.js opens the real identity.html, and this drives the page over the
// DevTools protocol (clicks and typing in its DOM), then reads the files main.js
// wrote and the POST /captures body the server received. Nothing here calls the
// window's functions directly.
//
// Dev mode only, through a wrapper app named clipwise-window-check, so the run
// never uses the installed app's identity: not its app name
// (clipwise-recorder), not its keychain item, not its support folder (project
// CLAUDE.md). The built app is not run by this check: the release step's
// file-by-file comparison of the bundled identity.html, identity-answer.js,
// people-name.js and main.js with the source stands in for that, and the first
// real call after release is the live test.
//
// What it sets up, all under one temporary folder:
//   - the wrapper (package.json "name": "clipwise-window-check", and an entry
//     that requires this folder's main.js by absolute path), with Electron's
//     userData in the temporary folder
//   - a fake capture token, encrypted by the wrapper's own safeStorage (the
//     keychain item "clipwise-window-check Safe Storage", deleted at the end)
//   - a stub server on 127.0.0.1 for GET /captures/me, GET /captures/people,
//     POST /captures/calendar-preview, POST /captures and the token endpoint
//   - per fixture, a CLIPWISE_SUPPORT_DIR holding one capture, and no
//     setup.json or consent.json, so the start gate turns any recording away
//
// One launch per fixture. CLIPWISE_CHECK_PROMPT_STEM is main.js's check-only
// switch, read in one place. It takes "<stem>", "<stem>:correct" or
// "<stem>:voices" and opens, for that capture, the stop window
// (promptForIdentity), Change attendees… or Name voices / Fix names: the same
// window each time. It opens only; it does nothing else. The correct and voices
// fixtures drive those two ways in; check-meetings' text checks on the reopen
// functions stay as a second line of evidence. The switch* fixtures show that
// unset it opens nothing and logs nothing, and that a value it can't use opens
// nothing and logs one line.
// The check refuses to start when the recorder's capture binaries are built in
// this checkout (call detection could start a capture), or when the installed
// app's name is the one it would run under.
//
// The page's DOM contract, which this drives:
//   #call-line                 the call line
//   #scope button[data-value]  Work / Personal, .active on the chosen one
//   #people-input              the field's text box (input events search;
//                              Enter adds the typed name)
//   #results button[data-person-id]   search results
//   #chips .chip               one per person: data-tag ("invited", "new",
//                              "not checked" or ""), data-person-id,
//                              data-email (an address-only invitee);
//                              .remove; an address chip's input names it
//   #new-line                  "<Name> is someone new. …"
//   #recent button[data-person-id]    the Recent row
//   #large-chip, #show-large, #large-suggestions button
//   #voices-part, .voice-row[data-voice] (select, .talk), #voices-more,
//   #leave-all
//   #voices-finding            "Finding voices…" until the voices are ready,
//                              or the reason there will be none (main.js
//                              identity:voices-stopped, stopMessageFor)
//   #recorded-by, #skip, #save
//
//   node check-identity-window.js
//
// Needs the installed Clipwise quit only if its single-instance lock turns the
// wrapper away; the premise run (2026-11-01) showed the wrapper takes its own.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const ia = require('./identity-answer.js');

const HERE = __dirname;
const RECORDER_DIR = path.resolve(HERE, '..');
const ELECTRON = path.join(HERE, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const MAIN_JS = path.join(HERE, 'main.js');
const APP_NAME = 'clipwise-window-check';
const KEYCHAIN_ITEM = `${APP_NAME} Safe Storage`;
const INSTALLED_NAME = 'clipwise-recorder';
const SWITCH = 'CLIPWISE_CHECK_PROMPT_STEM';
const MODE = 'dev';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${MODE}] ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
    if (!ok) failures++;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, step = 200) {
    const t0 = Date.now();
    for (;;) {
        let v;
        try { v = await pred(); } catch { v = false; }
        if (v) return v;
        if (Date.now() - t0 > ms) return false;
        await pause(step);
    }
}

// --- people the stub knows, most recently seen first ------------------------
const P = {
    ann: '11111111-1111-4111-8111-111111111111',
    bob: '22222222-2222-4222-8222-222222222222',
    cy: '33333333-3333-4333-8333-333333333333',
    dana: '44444444-4444-4444-8444-444444444444',
    gus: '55555555-5555-4555-8555-555555555555',
    hana: '66666666-6666-4666-8666-666666666666',
    host: '99999999-9999-4999-8999-999999999999', // the backfill person carrying the host's name
};
const HOST = 'Jon Example';
const STEM = '2026-11-01T15-09-12Z';
const PEOPLE = [
    { id: P.host, name: HOST },
    { id: P.gus, name: 'Gus Holt' },
    { id: P.hana, name: 'Hana Ito' },
    { id: P.cy, name: 'Cy Person' },
    { id: P.ann, name: 'Ann Example' },
    { id: P.bob, name: 'Bob Sample' },
    { id: P.dana, name: 'Dana Lee' },
];

// --- fixtures: the six measured in A.2, plus offline, correct, voices, the two
// ways diarize ends with nothing to name, and the switch's own cases -----------
// voices: 'none' (no voices file), 'ready' (there at open), 'late' (dropped
// after the window is up), 'never' (still finding at Save).
const FIXTURES = [
    {
        name: 'group6',
        preview: { matched: true, title: 'Weekly sync', named: ['Ann Example', 'Bob Sample', 'Dana Lee'], unnamed: ['eve@example.test'] },
        voices: 'late', talk: [1080, 660], plantEmbedding: true,
        drive: [
            { pick: 'Cy', id: P.cy },
            { nameAddress: 'eve@example.test', text: 'Eve Moreno' },
            { type: 'Fin Taylor' },
            { voice: 1, choose: 'Ann Example' },
        ],
        expectGuests: [{ name: 'Ann Example' }, { name: 'Bob Sample' }, { name: 'Dana Lee' }, { name: 'Eve Moreno' }, { name: 'Cy Person', personId: P.cy }, { name: 'Fin Taylor' }],
        expectPairs: [{ email: 'eve@example.test', name: 'Eve Moreno' }],
        expectNewLine: 'Eve Moreno is someone new. Check the spelling before saving.',
        expectVoiceNames: [{ voiceIndex: 1, name: 'Ann Example' }, { voiceIndex: 2, name: null }],
    },
    {
        name: 'group6long',
        preview: { matched: true, title: 'Quarterly planning', named: ['Alexandra Montgomery', 'Bartholomew Ashworth', 'Dominique Fairweather'], unnamed: [] },
        voices: 'ready', talk: [1080, 660],
        drive: [{ type: 'Christopher Vanderberg' }, { type: 'Evangeline Castellano' }, { type: 'Fitzgerald Okonkwo-Hale' }],
        expectGuests: [{ name: 'Alexandra Montgomery' }, { name: 'Bartholomew Ashworth' }, { name: 'Dominique Fairweather' }, { name: 'Christopher Vanderberg' }, { name: 'Evangeline Castellano' }, { name: 'Fitzgerald Okonkwo-Hale' }],
        expectVoiceNames: [{ voiceIndex: 1, name: null }, { voiceIndex: 2, name: null }],
    },
    {
        name: 'twoPerson',
        preview: { matched: true, title: 'Ann / Jon', named: ['Ann Example'], unnamed: [] },
        voices: 'none',
        drive: [],
        expectGuests: [{ name: 'Ann Example' }],
        expectNoVoicesPart: true,
    },
    {
        name: 'largeCall',
        preview: { matched: true, title: 'All hands', named: ['N1 Person', 'N2 Person', 'N3 Person', 'N4 Person', 'N5 Person'], unnamed: ['x1@example.test', 'x2@example.test', 'x3@example.test', 'x4@example.test'] },
        voices: 'ready', talk: [1200, 300, 200, 100],
        drive: [{ showLarge: 9 }],
        expectLargeLabel: '9 invited · not confirmed',
        expectGuests: [],
        expectNoPairsFile: true,
        expectVoicesMore: true,
    },
    {
        name: 'group2noRecent',
        preview: { matched: true, title: 'Sync', named: ['Ann Example', 'Bob Sample'], unnamed: [] },
        people: [],
        voices: 'ready', talk: [600, 500],
        drive: [],
        expectGuests: [{ name: 'Ann Example' }, { name: 'Bob Sample' }],
        expectNoRecent: true,
    },
    {
        name: 'groupFinding',
        preview: { matched: true, title: 'Sync', named: ['Ann Example', 'Bob Sample'], unnamed: [] },
        voices: 'never',
        drive: [],
        expectGuests: [{ name: 'Ann Example' }, { name: 'Bob Sample' }],
        expectFinding: true,
    },
    {
        name: 'offline',
        preview: null,
        offline: true,
        cachedSelf: 'Jon Cached',
        voices: 'none',
        drive: [{ type: 'Fin Taylor' }],
        expectGuests: [{ name: 'Fin Taylor' }],
        expectTag: { 'Fin Taylor': 'not checked' },
        expectFooter: 'Recorded by Jon Cached (you)',
    },
    // Change attendees… on a saved answer: one guest with a personId, one
    // without, and the host's own name. One chip removed, one person added.
    {
        name: 'correct',
        open: 'correct',
        preview: null,
        saved: {
            identity_version: 2, recording_id: 'CHECK-WINDOW-8', stem: STEM, answered_at: '2026-11-01T15:40:00.000Z',
            self: { name: HOST, source: 'account_display_name' },
            guests: [{ name: 'Ann Example', personId: P.ann }, { name: 'Bob Sample' }, { name: HOST }],
            scope: 'work',
        },
        voices: 'none',
        expectOpenChips: [{ text: 'Ann Example', personId: P.ann }, { text: 'Bob Sample', personId: '' }],
        drive: [{ remove: 'Bob Sample' }, { pick: 'Cy', id: P.cy }],
        expectGuests: [{ name: 'Ann Example', personId: P.ann }, { name: 'Cy Person', personId: P.cy }],
        expectCorrects: '2026-11-01T15:40:00.000Z',
    },
    // Name voices / Fix names on a saved answer whose voices are ready. No chip
    // changes, so the saved answer stays as it was; one voice is named.
    {
        name: 'voices',
        open: 'voices',
        preview: null,
        saved: {
            identity_version: 2, recording_id: 'CHECK-WINDOW-9', stem: STEM, answered_at: '2026-11-01T15:41:00.000Z',
            self: { name: HOST, source: 'account_display_name' },
            guests: [{ name: 'Ann Example', personId: P.ann }, { name: 'Bob Sample', personId: P.bob }],
            scope: 'work',
        },
        voices: 'ready', talk: [900, 400],
        drive: [{ voice: 1, choose: 'Ann Example' }],
        expectIdentityUnchanged: true,
        expectGuests: [{ name: 'Ann Example', personId: P.ann }, { name: 'Bob Sample', personId: P.bob }],
        expectVoiceNames: [{ voiceIndex: 1, name: 'Ann Example' }, { voiceIndex: 2, name: null }],
    },
    // Diarize finishes after the window is up and finds fewer than two voices,
    // or cannot run: the voices part says so instead of waiting to the cap.
    {
        name: 'oneVoice',
        preview: { matched: true, title: 'Sync', named: ['Ann Example', 'Bob Sample'], unnamed: [] },
        voices: 'outcome',
        diarizeOutcome: { state: 'ok', detail: { voices_found: 1 } },
        expectVoicesMessage: 'Only one other voice on this call — nothing to name.',
        drive: [],
        expectGuests: [{ name: 'Ann Example' }, { name: 'Bob Sample' }],
    },
    {
        name: 'diarizeFailed',
        preview: { matched: true, title: 'Sync', named: ['Ann Example', 'Bob Sample'], unnamed: [] },
        voices: 'outcome',
        diarizeOutcome: { state: 'skipped', detail: { reason: 'tool_error' } },
        expectVoicesMessage: "Couldn't separate the voices on this call.",
        drive: [],
        expectGuests: [{ name: 'Ann Example' }, { name: 'Bob Sample' }],
    },
    // The switch itself: unset, it opens nothing and logs nothing; a value it
    // can't use opens nothing and logs one line.
    { name: 'switchUnset', switchValue: null, expectNoWindow: true, expectSwitchLines: [] },
    { name: 'switchBadSuffix', switchValue: `${STEM}:bogus`, expectNoWindow: true,
        expectSwitchLines: ['[clipwise-recorder] check switch: nothing opened — not "<stem>", "<stem>:correct" or "<stem>:voices"'] },
    { name: 'switchNoCapture', switchValue: '2026-01-01T00-00-00Z', expectNoWindow: true,
        expectSwitchLines: ['[clipwise-recorder] check switch: nothing opened — no capture 2026-01-01T00-00-00Z in this support folder'] },
    { name: 'switchCorrectNoAnswer', switchValue: `${STEM}:correct`, expectNoWindow: true,
        expectSwitchLines: [`[clipwise-recorder] check switch: nothing opened — no saved answer for ${STEM} to correct`] },
    { name: 'switchVoicesNoData', switchValue: `${STEM}:voices`, expectNoWindow: true,
        expectSwitchLines: [`[clipwise-recorder] check switch: nothing opened — no voices for ${STEM} to name`] },
];

// --- the stub server ------------------------------------------------------------
function startStub() {
    const state = { offline: false, people: PEOPLE, preview: null, me: { displayName: HOST }, posts: [], requests: [] };
    const send = (res, status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const url = new URL(req.url, 'http://stub');
            state.requests.push(`${req.method} ${url.pathname}`);
            if (url.pathname === '/api/auth/oauth2/token') return send(res, 503, { error: 'stub' });
            if (state.offline && url.pathname !== '/captures') return send(res, 503, { error: 'offline' });
            if (req.method === 'GET' && url.pathname === '/captures/me') return send(res, 200, state.me);
            if (req.method === 'GET' && url.pathname === '/captures/people') {
                const q = (url.searchParams.get('q') || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
                const hits = state.people.filter((p) => p.name.normalize('NFC').toLowerCase().includes(q)).slice(0, 10);
                return send(res, 200, { people: hits });
            }
            if (req.method === 'POST' && url.pathname === '/captures/calendar-preview') {
                return send(res, 200, state.preview || { matched: false, title: null, named: [], unnamed: [] });
            }
            if (req.method === 'POST' && url.pathname === '/captures') {
                try { state.posts.push(JSON.parse(body)); } catch { state.posts.push({ unparsed: true }); }
                return send(res, 201, { recordingId: 'rec-check', people: { voices: {}, them: null } });
            }
            return send(res, 404, { error: 'not_found' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

// --- the DevTools protocol, minimal -----------------------------------------------
async function connectPage(port, ms) {
    const target = await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await res.json();
        return list.find((t) => t.type === 'page' && /identity\.html/.test(t.url)) || false;
    }, ms, 300);
    if (!target) return null;
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const call = (method, params = {}) => new Promise((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params }));
    });
    const evaluate = async (expression) => {
        const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'page threw');
        return r.result && r.result.result ? r.result.result.value : undefined;
    };
    return { evaluate, close: () => { try { ws.close(); } catch {} } };
}

// Page-side helpers, defined once per page.
const PAGE_HELPERS = `(() => {
  window.__check = {
    q: (s) => document.querySelector(s),
    qa: (s) => [...document.querySelectorAll(s)],
    type(text) {
      const input = document.querySelector('#people-input');
      input.focus();
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    enter(el) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    },
    chips() {
      return [...document.querySelectorAll('#chips .chip')].map((c) => ({
        text: c.textContent.trim(), tag: c.dataset.tag || '', personId: c.dataset.personId || '', email: c.dataset.email || '',
      }));
    },
    fit() {
      const d = document.documentElement;
      return { scrollHeight: d.scrollHeight, clientHeight: d.clientHeight, measured: typeof window.measuredHeight === 'function' ? window.measuredHeight() : null, innerHeight: window.innerHeight };
    },
  };
  return true;
})()`;

// --- fixture folders ----------------------------------------------------------------
function silentWav(file) {
    const samples = 1600;
    const b = Buffer.alloc(44 + samples * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
    b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
    fs.writeFileSync(file, b);
}
function writeCapture(outdir, n) {
    const w = (name, doc) => fs.writeFileSync(path.join(outdir, name), JSON.stringify(doc, null, 2) + '\n');
    w(`manifest-${STEM}.json`, {
        recording_id: `CHECK-WINDOW-${n}`,
        started_at: '2026-11-01T15:09:12.000Z',
        trigger_app: { key: 'zoom', name: 'zoom.us' },
        tracks: [
            { track: 'mic', file: `mic-${STEM}.wav`, encoding: 'pcm_s16le', container: 'wav', sample_rate: 16000, sample_rate_source: 'check', duration_s: 1800 },
            { track: 'system', file: `system-${STEM}.wav`, encoding: 'pcm_s16le', container: 'wav', sample_rate: 16000, sample_rate_source: 'check', duration_s: 1800 },
        ],
    });
    w(`transcript-${STEM}.json`, {
        engine: 'whisper.cpp', model: 'check',
        segments: [{ track: 'me', start_ms: 0, end_ms: 1000, text: 'hello' }, { track: 'them', start_ms: 1000, end_ms: 2000, text: 'hi' }],
        content: null, aec: null, autostop: null,
    });
    w(`pipeline-${STEM}.json`, {
        pipeline: 'capture', updated_at: new Date().toISOString(),
        steps: {
            transcribe: { state: 'ok' },
            classify: { state: 'ok', detail: { classification: { verdict: 'ok', concern: null, reason: null, excludedLabels: [], tracks: null, thresholds: null } } },
            diarize: { state: 'running' },
        },
    });
}
// plant: an embedding field on every voice in both files, and at the top of the
// naming data, as a real diarize file holds embeddings (the window check's
// control that none reaches the page).
function writeVoices(outdir, talk, { plant = false } = {}) {
    const emb = plant ? { embedding: [0.125, -0.5, 0.75] } : {};
    const voices = talk.map((secs, i) => {
        const clip = path.join(outdir, `clip-${STEM}-v${i + 1}.wav`);
        silentWav(clip);
        return { voiceIndex: i + 1, clipPaths: [clip], lines: [{ text: `line from voice ${i + 1}`, start: 10 * i + 1.5, end: 10 * i + 4.25 }], ...emb };
    });
    fs.writeFileSync(path.join(outdir, `diarize-${STEM}.json`), JSON.stringify({ voices: talk.map((s, i) => ({ voiceIndex: i + 1, totalSeconds: s, ...emb })), segments: [] }));
    fs.writeFileSync(path.join(outdir, `voices-${STEM}.json`), JSON.stringify({ voices, ...emb }));
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

function writeWrapper(root) {
    const dir = path.join(root, 'wrapper');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: APP_NAME, version: '0.0.0', private: true, main: 'entry.js' }) + '\n');
    fs.writeFileSync(path.join(dir, 'entry.js'), `
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
if (app.getName() !== ${JSON.stringify(APP_NAME)}) { console.error('wrapper: app name is ' + app.getName() + ': refusing'); process.exit(2); }
app.setPath('userData', process.env.CHECK_USERDATA);
if (process.env.CHECK_MODE === 'encrypt') {
  app.whenReady().then(() => {
    fs.writeFileSync(process.env.CHECK_TOKEN_FILE, safeStorage.encryptString(process.env.CHECK_TOKEN_JSON), { mode: 0o600 });
    app.quit();
  });
} else {
  require(${JSON.stringify(MAIN_JS)});
}
`);
    return dir;
}

function keychainHas(item) {
    return spawnSync('security', ['find-generic-password', '-s', item], { encoding: 'utf8' }).status === 0;
}

// --- one fixture ----------------------------------------------------------------------
async function runFixture(fx, n, ctx) {
    const root = path.join(ctx.root, fx.name);
    const support = path.join(root, 'support');
    const outdir = path.join(support, 'recordings');
    fs.mkdirSync(outdir, { recursive: true });
    fs.writeFileSync(path.join(support, 'capture-server.json'), JSON.stringify({ url: ctx.stub.url }) + '\n');
    fs.copyFileSync(ctx.tokenFile, path.join(support, 'capture-token.bin'));
    if (fx.cachedSelf) fs.writeFileSync(path.join(support, 'identity-self.json'), JSON.stringify({ name: fx.cachedSelf, set_at: new Date().toISOString() }) + '\n');
    writeCapture(outdir, n);
    if (fx.voices === 'ready') writeVoices(outdir, fx.talk);
    const identityFile = path.join(outdir, `identity-${STEM}.json`);
    if (fx.saved) fs.writeFileSync(identityFile, JSON.stringify(fx.saved, null, 2) + '\n');

    const stub = ctx.stub.state;
    stub.offline = !!fx.offline;
    stub.people = fx.people || PEOPLE;
    stub.preview = fx.preview;
    stub.posts = [];

    const port = await freePort();
    let log = '';
    const child = spawn(ELECTRON, [ctx.wrapper, `--remote-debugging-port=${port}`], {
        env: (() => {
            const env = { ...process.env, CLIPWISE_SUPPORT_DIR: support, CHECK_USERDATA: path.join(root, 'userdata') };
            delete env[SWITCH];
            const value = fx.switchValue !== undefined ? fx.switchValue : fx.open ? `${STEM}:${fx.open}` : STEM;
            if (value !== null) env[SWITCH] = value;
            return env;
        })(),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    let exited = null;
    child.on('exit', (c, s) => { exited = `${c} ${s}`; });
    const t = (s) => `${fx.name}: ${s}`;

    try {
        if (fx.expectNoWindow) {
            // The app is up once its launch log reaches the update line; then a
            // window the switch opened would be on its way. Give it the same
            // time a real one takes, and look.
            await waitFor(() => /update: not checked/.test(log), 20000);
            const page = await connectPage(port, 8000);
            check(t('nothing is opened'), !page, 'an identity window opened');
            if (page) page.close();
            const lines = log.split('\n').filter((l) => /\[clipwise-recorder\] check switch:/.test(l));
            check(t(`the switch logs ${fx.expectSwitchLines.length === 0 ? 'nothing' : 'exactly one line, saying why'}`),
                JSON.stringify(lines) === JSON.stringify(fx.expectSwitchLines), JSON.stringify(lines));
            return;
        }
        const page = await connectPage(port, 20000);
        check(t('the switch opens the identity window'), !!page, `exited=${exited}; log tail: ${log.split('\n').slice(-5).join(' | ')}`);
        if (!page) return;
        check(t('the wrapper was not turned away by a single-instance lock'), !/another Clipwise is already running/.test(log));
        await page.evaluate(PAGE_HELPERS);
        const ev = (js) => page.evaluate(js);

        // The calendar preview lands within its wait; the page settles.
        if (fx.preview) await waitFor(() => ev(`__check.qa('#chips .chip').length > 0 || !!__check.q('#large-chip')`), 8000);
        await waitFor(() => ev(`!!__check.q('#recorded-by') && __check.q('#recorded-by').textContent.trim().length > 0`), 5000);

        const footer = await ev(`__check.q('#recorded-by') ? __check.q('#recorded-by').textContent.trim() : null`);
        const wantFooter = fx.expectFooter || `Recorded by ${HOST} (you)`;
        check(t(`the footer reads "${wantFooter}"`), footer === wantFooter, JSON.stringify(footer));
        check(t('the footer never says "Voice 1 is you"'), !/Voice 1 is you/.test(footer || ''), JSON.stringify(footer));

        if (fx.preview) {
            const callLine = await ev(`__check.q('#call-line') ? __check.q('#call-line').textContent : ''`);
            check(t('the call line carries the calendar title'), callLine.includes(fx.preview.title), JSON.stringify(callLine));
        }
        if (fx.expectOpenChips) {
            const open = await ev(`__check.chips().map((c) => ({ text: c.text, personId: c.personId }))`);
            const got = open.map((c) => ({ text: fx.expectOpenChips.find((e) => c.text.includes(e.text))?.text || c.text, personId: c.personId }));
            check(t('Change attendees… opens the saved guests as chips, a personId kept, the host never a chip'),
                JSON.stringify(got) === JSON.stringify(fx.expectOpenChips) && !open.some((c) => c.text.includes(HOST)), JSON.stringify(open));
        }
        if (fx.open === 'voices') {
            const title = await ev(`document.title`);
            check(t('Name voices / Fix names opens the same window ("Who was on this call?")'), title === 'Who was on this call?', JSON.stringify(title));
        }
        if (fx.expectLargeLabel) {
            const label = await ev(`__check.q('#large-chip') ? __check.q('#large-chip').textContent : null`);
            check(t(`the large-call chip reads "${fx.expectLargeLabel}"`), !!label && label.includes(fx.expectLargeLabel), JSON.stringify(label));
            const chips = await ev(`__check.chips()`);
            check(t('no invitee chips on a large call'), chips.length === 0, JSON.stringify(chips));
        }
        if (!fx.offline) {
            const recent = await ev(`__check.qa('#recent button[data-person-id]').map((b) => ({ id: b.dataset.personId, text: b.textContent.trim() }))`);
            if (fx.expectNoRecent) {
                check(t('no Recent row when nobody is known'), recent.length === 0, JSON.stringify(recent));
            } else {
                check(t('the Recent row offers known people, at most four, never the host'),
                    recent.length > 0 && recent.length <= 4 && !recent.some((r) => r.id === P.host || /Jon Example/.test(r.text)), JSON.stringify(recent));
            }
            // Typing the host's name: no result for the backfill person, and Enter adds nothing.
            await ev(`__check.type('Jon Ex')`);
            await pause(800);
            const hostResults = await ev(`__check.qa('#results button[data-person-id]').map((b) => b.dataset.personId)`);
            check(t('search never offers the person carrying the host\'s name'), !hostResults.includes(P.host), JSON.stringify(hostResults));
            await ev(`__check.type('Jon Example'); __check.enter(__check.q('#people-input'))`);
            await pause(500);
            const afterHost = await ev(`__check.chips()`);
            check(t('typing the host\'s own name adds no chip'), !afterHost.some((c) => /Jon Example/.test(c.text)), JSON.stringify(afterHost));
            await ev(`__check.type('')`);
        }

        // The member's steps.
        for (const step of fx.drive) {
            if (step.remove) {
                const removed = await ev(`(() => { const c = __check.qa('#chips .chip').find((x) => x.textContent.includes(${JSON.stringify(step.remove)})); if (!c) return false; c.querySelector('.remove').click(); return true; })()`);
                await pause(200);
                const left = await ev(`__check.chips()`);
                check(t(`removing the "${step.remove}" chip takes it off the field`), removed && !left.some((c) => c.text.includes(step.remove)), JSON.stringify(left));
            } else if (step.pick) {
                await ev(`__check.type(${JSON.stringify(step.pick)})`);
                const ok = await waitFor(() => ev(`!!__check.q('#results button[data-person-id="${step.id}"]')`), 5000);
                check(t(`search for "${step.pick}" offers that person`), !!ok);
                if (ok) await ev(`__check.q('#results button[data-person-id="${step.id}"]').click()`);
            } else if (step.type) {
                await ev(`__check.type(${JSON.stringify(step.type)})`);
                await pause(900); // the search answers, or fails, before Enter
                await ev(`__check.enter(__check.q('#people-input'))`);
                await pause(300);
            } else if (step.nameAddress) {
                const sel = `#chips .chip[data-email="${step.nameAddress}"]`;
                await ev(`__check.q('${sel}').click()`);
                const ok = await waitFor(() => ev(`!!__check.q('${sel} input')`), 3000);
                check(t(`the address chip ${step.nameAddress} opens a name box`), !!ok);
                if (ok) {
                    await ev(`(() => { const i = __check.q('${sel} input'); i.value = ${JSON.stringify(step.text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
                    await pause(900);
                    await ev(`__check.enter(__check.q('${sel} input'))`);
                    await pause(300);
                }
            } else if (step.showLarge) {
                await ev(`__check.q('#show-large').click()`);
                await pause(300);
                const offered = await ev(`__check.qa('#large-suggestions button').length`);
                check(t(`"Show the ${step.showLarge}" offers all ${step.showLarge} invitees`), offered === step.showLarge, String(offered));
            } else if (step.voice) {
                // handled once voices are on screen, below
            }
        }

        // Voices.
        if (fx.voices === 'late') {
            const before = await ev(`__check.q('#voices-finding') ? __check.q('#voices-finding').textContent.trim() : null`);
            check(t('before the voices are ready, the voices part reads "Finding voices…"'), before === 'Finding voices…', JSON.stringify(before));
            if (fx.plantEmbedding) {
                // A second listener on the page, beside the page's own, keeps
                // what main.js sent exactly as it arrived.
                await ev(`(() => { window.__voicesSent = null; require('electron').ipcRenderer.on('identity:voices', (_e, d) => { window.__voicesSent = JSON.stringify(d); }); return true; })()`);
            }
            writeVoices(outdir, fx.talk, { plant: !!fx.plantEmbedding });
            if (fx.plantEmbedding) {
                const sent = await waitFor(() => ev(`window.__voicesSent || false`), 12000);
                const onDisk = fs.readFileSync(path.join(outdir, `voices-${STEM}.json`), 'utf8') + fs.readFileSync(path.join(outdir, `diarize-${STEM}.json`), 'utf8');
                check(t('control: the voices and diarize files on disk do hold the planted embedding'), /embedding/.test(onDisk));
                check(t('what main.js sends the page holds no embedding, and each line\'s text, start and end as on disk'),
                    !!sent && !/embedding/.test(sent)
                        && JSON.stringify(JSON.parse(sent).namingData.voices.map((v) => v.lines)) === JSON.stringify(readJson(path.join(outdir, `voices-${STEM}.json`)).voices.map((v) => v.lines)),
                    String(sent));
            }
        }
        if (fx.voices === 'late' || fx.voices === 'ready') {
            const rows = await waitFor(() => ev(`__check.qa('.voice-row[data-voice]').length || false`), 12000);
            check(t('the voice rows fill in once the voices are ready'), rows >= 2, String(rows));
            const talk = await ev(`__check.qa('.voice-row[data-voice] .talk').map((e) => e.textContent.trim())`);
            check(t('each voice row shows its talk time, longest first'), talk.length >= 2 && talk[0] === `${Math.round(Math.max(...fx.talk) / 60)} min`, JSON.stringify(talk));
            if (fx.expectVoicesMore) {
                const more = await ev(`__check.q('#voices-more') ? __check.q('#voices-more').textContent : null`);
                check(t('past two voices, the rest are behind "Show them"'), !!more && /Show them/.test(more) && rows === 2, `${JSON.stringify(more)} rows=${rows}`);
            }
            const options = await ev(`[...(__check.q('.voice-row[data-voice] select') || { options: [] }).options].map((o) => o.textContent.trim())`);
            check(t('a voice\'s choices are the people on chips, then "Leave unnamed" and "Add someone…"'),
                options.length >= 2 && options.includes('Leave unnamed') && options[options.length - 1] === 'Add someone…', JSON.stringify(options));
            for (const step of fx.drive.filter((s) => s.voice)) {
                await ev(`(() => { const s = __check.q('.voice-row[data-voice="${step.voice}"] select'); s.value = ${JSON.stringify(step.choose)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
            }
        }
        if (fx.voices === 'outcome') {
            const before = await ev(`__check.q('#voices-finding') ? __check.q('#voices-finding').textContent.trim() : null`);
            check(t('before diarize finishes, the voices part reads "Finding voices…"'), before === 'Finding voices…', JSON.stringify(before));
            const sidecarPath = path.join(outdir, `pipeline-${STEM}.json`);
            const sidecar = readJson(sidecarPath);
            sidecar.steps.diarize = fx.diarizeOutcome;
            fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n');
            const shown = await waitFor(async () => {
                const text = await ev(`__check.q('#voices-finding') ? __check.q('#voices-finding').textContent.trim() : null`);
                return text === fx.expectVoicesMessage ? text : false;
            }, 10000);
            check(t(`then it reads "${fx.expectVoicesMessage}", not "Finding voices…" until the cap`), !!shown,
                JSON.stringify(await ev(`__check.q('#voices-finding') ? __check.q('#voices-finding').textContent.trim() : null`)));
            const rows = await ev(`__check.qa('.voice-row[data-voice]').length`);
            check(t('and shows no voice rows'), rows === 0, String(rows));
        }
        if (fx.expectFinding) {
            const finding = await ev(`__check.q('#voices-finding') ? __check.q('#voices-finding').textContent.trim() : null`);
            check(t('the voices part reads "Finding voices…" and Save is not held back'), finding === 'Finding voices…' && (await ev(`!__check.q('#save').disabled`)), JSON.stringify(finding));
        }
        if (fx.expectNoVoicesPart) {
            const shown = await ev(`!!__check.q('#voices-part') && __check.q('#voices-part').offsetParent !== null`);
            check(t('a two-person call shows no voices part'), !shown);
        }

        // What the field shows before Save.
        const chips = await ev(`__check.chips()`);
        if (fx.expectNewLine) {
            const line = await ev(`__check.q('#new-line') ? __check.q('#new-line').textContent.trim() : ''`);
            check(t('the "new" line names the first new person'), line === fx.expectNewLine, JSON.stringify(line));
            check(t('a "new" chip is tagged new'), chips.some((c) => c.tag === 'new'), JSON.stringify(chips));
        }
        for (const [name, tag] of Object.entries(fx.expectTag || {})) {
            check(t(`"${name}" is tagged "${tag}"`), chips.some((c) => c.text.includes(name) && c.tag === tag), JSON.stringify(chips));
        }

        // No scrolling (B.13), and the height the real page asks for (A.2's fixtures).
        const fit = await ev(`__check.fit()`);
        check(t(`the window never scrolls (scrollHeight ${fit.scrollHeight} <= clientHeight ${fit.clientHeight}; page asks for ${fit.measured}, window ${fit.innerHeight})`),
            fit.scrollHeight <= fit.clientHeight && fit.measured !== null && fit.measured <= ia.IDENTITY_WINDOW.maxHeight, JSON.stringify(fit));

        // Save.
        await ev(`__check.q('#save').click()`);
        // A fixture with a saved answer: a correction writes a new one (a new
        // answered_at); with no chip changed, the saved one stays as it was.
        let saved;
        if (fx.expectIdentityUnchanged) {
            await waitFor(() => readJson(path.join(outdir, `voice-names-${STEM}.json`)), 8000);
            saved = readJson(identityFile);
            check(t('with no chip changed, Save leaves the saved answer as it was (no correction sent)'),
                JSON.stringify(saved) === JSON.stringify(fx.saved), JSON.stringify(saved));
        } else {
            saved = await waitFor(() => {
                const d = readJson(identityFile);
                return d && (!fx.saved || d.answered_at !== fx.saved.answered_at) ? d : false;
            }, 8000);
            check(t(fx.saved ? 'Save writes a new answer to identity-<stem>.json' : 'Save writes identity-<stem>.json'), !!saved);
        }
        if (fx.expectCorrects) {
            check(t('the new answer is a correction of the saved one (corrects)'), !!saved && saved.corrects === fx.expectCorrects, JSON.stringify(saved && saved.corrects));
        }
        const closed = await waitFor(async () => {
            const res = await fetch(`http://127.0.0.1:${port}/json/list`);
            return !(await res.json()).some((x) => /identity\.html/.test(x.url));
        }, 8000);
        check(t('Save closes the window at once, voices ready or not'), !!closed);
        if (saved) {
            check(t('the answer\'s guests are the chips, a picked person with their personId'), JSON.stringify(saved.guests) === JSON.stringify(fx.expectGuests),
                JSON.stringify(saved.guests));
            const selfName = fx.offline ? fx.cachedSelf : HOST;
            check(t(`self is "${selfName}", from ${fx.offline ? 'the cache' : 'the account'}, source account_display_name`),
                saved.self && saved.self.name === selfName && saved.self.source === 'account_display_name', JSON.stringify(saved.self));
            check(t('the answer holds no @'), !JSON.stringify(saved).includes('@'));
        }
        const pairs = readJson(path.join(outdir, `invitee-names-${STEM}.json`));
        if (fx.expectPairs) check(t('the name-once pairs are the address chips named with new text'), !!pairs && JSON.stringify(pairs.invitees) === JSON.stringify(fx.expectPairs), JSON.stringify(pairs));
        if (fx.expectNoPairsFile) check(t('no name-once file'), pairs === null, JSON.stringify(pairs));
        const voiceNames = readJson(path.join(outdir, `voice-names-${STEM}.json`));
        if (fx.expectVoiceNames) {
            check(t('voice-names holds each voice\'s choice, the rest unnamed'), !!voiceNames && JSON.stringify(voiceNames.voices) === JSON.stringify(fx.expectVoiceNames), JSON.stringify(voiceNames));
        } else {
            check(t('no voice-names file (no voices were ready to name)'), voiceNames === null, JSON.stringify(voiceNames));
        }
        if (fx.expectFinding) {
            writeVoices(outdir, [600, 500]);
            check(t('voices that arrive after Save are pending for the tray\'s reopen'), ia.pendingVoiceNamingStems(outdir).includes(STEM), JSON.stringify(ia.pendingVoiceNamingStems(outdir)));
        }
        if (!fx.offline) {
            const cache = readJson(path.join(support, 'identity-self.json'));
            check(t('identity-self.json caches the account\'s display name'), !!cache && cache.name === HOST, JSON.stringify(cache));
        }
        const post = await waitFor(() => stub.posts.find((p) => p.identity) || false, 10000);
        check(t('POST /captures carries the same identity guests'), !!post && JSON.stringify(post.identity.guests) === JSON.stringify(fx.expectGuests), JSON.stringify(post && post.identity));
        if (fx.expectCorrects) {
            check(t('POST /captures carries the correction (corrects)'), !!post && post.identity.corrects === fx.expectCorrects, JSON.stringify(post && post.identity));
        }
        if (fx.expectVoiceNames) {
            const vpost = await waitFor(() => stub.posts.find((p) => p.voiceNames) || false, 10000);
            check(t('POST /captures carries the same voice names'), !!vpost && JSON.stringify(vpost.voiceNames.voices) === JSON.stringify(fx.expectVoiceNames), JSON.stringify(vpost && vpost.voiceNames));
        }
        page.close();
    } finally {
        if (exited === null) child.kill('SIGTERM');
        await waitFor(() => exited !== null, 8000);
        if (exited === null) child.kill('SIGKILL');
    }
}

// --- main ------------------------------------------------------------------------------
(async () => {
    // Refusals first: nothing is launched past any of these.
    const built = ['micwatch', 'audiodevs', path.join('systemtap', '.build', 'release', 'systemtap'), path.join('miccap', '.build', 'release', 'miccap')]
        .map((p) => path.join(RECORDER_DIR, p)).filter((p) => fs.existsSync(p));
    if (built.length) {
        console.log(`check-identity-window: refusing: capture binaries are built in this checkout (${built.join(', ')}); call detection could start a capture`);
        process.exit(2);
    }
    if (APP_NAME === INSTALLED_NAME) { console.log('check-identity-window: refusing: the wrapper would run under the installed app\'s name'); process.exit(2); }
    if (!fs.existsSync(ELECTRON)) { console.log(`check-identity-window: refusing: no Electron at ${ELECTRON} (npm ci in recorder/app)`); process.exit(2); }

    const mainText = fs.readFileSync(MAIN_JS, 'utf8');
    const switchUses = mainText.split('\n').filter((l) => l.includes(SWITCH) && !/^\s*\/\//.test(l));
    check(`main.js reads ${SWITCH} in one place`, switchUses.length === 1, switchUses.join(' | '));
    check(`control: the same count finds a second use planted in a copy`, `${mainText}\nprocess.env.${SWITCH};`.split('\n').filter((l) => l.includes(SWITCH) && !/^\s*\/\//.test(l)).length === switchUses.length + 1);

    // The item this run creates must not exist yet: one left by an earlier run is
    // not reused, and the teardown's "gone" then means this run removed it.
    const keychainBefore = keychainHas(KEYCHAIN_ITEM);
    check(`the keychain item "${KEYCHAIN_ITEM}" does not exist before the run`, !keychainBefore,
        'left by an earlier run: delete it (security delete-generic-password -s "clipwise-window-check Safe Storage") and run again');
    if (keychainBefore) {
        console.log(`\ncheck-identity-window: ${failures} FAILED`);
        process.exit(1);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-check-identity-window-'));
    const wrapper = writeWrapper(root);
    const stub = await startStub();
    try {
        const tokenFile = path.join(root, 'capture-token.bin');
        const enc = spawnSync(ELECTRON, [wrapper], {
            encoding: 'utf8', timeout: 60000,
            env: {
                ...process.env, CHECK_MODE: 'encrypt', CHECK_USERDATA: path.join(root, 'userdata-encrypt'), CHECK_TOKEN_FILE: tokenFile,
                CHECK_TOKEN_JSON: JSON.stringify({ server: stub.url, access: 'fake-access-window-check', refresh: 'fake-refresh-window-check', expiresAt: Date.now() + 3600e3 }),
            },
        });
        check('the fake token is encrypted by the wrapper\'s own safeStorage', enc.status === 0 && fs.existsSync(tokenFile), `${enc.status} ${(enc.stderr || '').split('\n').slice(-3).join(' | ')}`);
        // Known present, so the teardown's "gone" below is checked against both states.
        check(`the keychain item "${KEYCHAIN_ITEM}" exists once the token is encrypted`, keychainHas(KEYCHAIN_ITEM));
        if (!fs.existsSync(tokenFile)) return;
        let n = 0;
        for (const fx of FIXTURES) await runFixture(fx, ++n, { root, wrapper, tokenFile, stub });
    } finally {
        stub.server.close();
        if (keychainHas(KEYCHAIN_ITEM)) spawnSync('security', ['delete-generic-password', '-s', KEYCHAIN_ITEM]);
        check(`teardown: the keychain item "${KEYCHAIN_ITEM}" is gone`, !keychainHas(KEYCHAIN_ITEM));
        fs.rmSync(root, { recursive: true, force: true });
        console.log(failures === 0 ? '\ncheck-identity-window: all passed' : `\ncheck-identity-window: ${failures} FAILED`);
        process.exit(failures === 0 ? 0 : 1);
    }
})();
