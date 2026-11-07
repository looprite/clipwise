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
// file-by-file comparison of the bundled files with the source stands in for
// that, and the first real call after release is the live test. The files the
// windows this check drives are made of: main.js; identity.html,
// identity-page.js, identity-preload.js, identity-rules.js, identity-answer.js
// and people-name.js; meetings.html, meetings-page.js and meetings-preload.js;
// setup.html, setup-page.js and setup-preload.js; voice-prints.html,
// voice-prints-page.js and voice-prints-preload.js (SAA-243 window hardening).
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
// Each launch also starts the app's recovery pass (main.js startRecovery('app
// launch'), which runs server/src/pipeline/capture-recover.ts from this checkout
// through tsx) on the fixture's support folder. It finishes a capture whose
// pipeline record has a step left unfinished by a process that is gone. The
// fixture's record carries `pid`, the pid of this check's own process, alive for
// the whole run, as a real running record carries its pipeline's: that is what
// keeps the pass idle. A line before the fixtures shows it (unfinishedCaptures
// skips the record with that pid, and lists the same record without one). The
// pass loads no database code and no API key (capture-cli.ts:7-8).
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
// The hardening fixture (SAA-243) opens all four windows' pages in one launch:
// identity by that switch, setup by itself, and Recent meetings and Recognize
// voices by main.js's other check-only switch, CLIPWISE_CHECK_OPEN_WINDOWS. In
// each page it shows the page's own script ran, that require, process and
// module are undefined, that an inserted inline script does not run, that its
// own preload is in force, and what Electron applied (hardeningChecks).
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
//                              .remove; an address chip's input names it,
//                              and its .add-name reads "· add name"
//   #new-line                  "<Name> is someone new. …"
//   #recent button[data-person-id]    the Recent row
//   #large-chip, #show-large, #large-suggestions button
//   #voices-part, .voice-row[data-voice] (select, .talk, .play, .no-clip),
//   #voices-more ("+N more voices — show"), #leave-all
//   #prints-nudge, #prints-nudge-open   "Recognize voices…", while prints
//                              are off
//   #voices-finding            FINDING until the voices are ready, or the
//                              reason there will be none (main.js
//                              identity:voices-stopped, stopMessageFor)
//   #recorded-by, #skip, #save
//
//   node check-identity-window.js
//   CHECK_FIXTURE=group6 node check-identity-window.js      one fixture only
//   CHECK_FIXTURE_NO_PID=1 ...                             its record without pid
//                                                          (shows what recovery does)
//
// A fixture with a FAIL prints, before the temporary folder goes: its pipeline
// record, recovery.log, recovery-<stem>.json, its upload-queue entry, the day
// log's upload lines (or that there is no day log) and the app's stderr upload
// lines. A fixture that throws is a FAIL with the error, and the run goes on to
// the next.
//
// Needs the installed Clipwise quit only if its single-instance lock turns the
// wrapper away; the premise run (2026-11-01) showed the wrapper takes its own.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { IDENTITY_WINDOW } = require('./identity-rules.js');
const { pendingVoiceNamingStems } = require('./identity-answer.js');
const { STATEMENT_VERSION } = require('./voice-prints.js');

const HERE = __dirname;
const RECORDER_DIR = path.resolve(HERE, '..');
const ELECTRON = path.join(HERE, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const MAIN_JS = path.join(HERE, 'main.js');
const APP_NAME = 'clipwise-window-check';
const KEYCHAIN_ITEM = `${APP_NAME} Safe Storage`;
const INSTALLED_NAME = 'clipwise-recorder';
const SWITCH = 'CLIPWISE_CHECK_PROMPT_STEM';
// main.js's other check-only switch (openWindowsForCheck): Recent meetings and
// Recognize voices, for the hardening fixture only.
const OPEN_SWITCH = 'CLIPWISE_CHECK_OPEN_WINDOWS';
const MODE = 'dev';
const ONLY = process.env.CHECK_FIXTURE || null;
const NO_PID = process.env.CHECK_FIXTURE_NO_PID === '1';
const SERVER_DIR = path.resolve(RECORDER_DIR, '..', 'server');
const TSX = path.join(SERVER_DIR, 'node_modules', '.bin', 'tsx');

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
// The voices part while diarize runs (SAA-260 11-07 item 2).
const FINDING = 'Finding voices… You can save now; Clipwise will ask you to name them from the menu bar.';
// scopes: the scopes of the calls each was seen on, for the stub's answer to
// Recent's ?scope= (server capture-people.ts: with an empty q and a scope, only
// people seen on a call of that scope). The page never sees this field.
const PEOPLE = [
    { id: P.host, name: HOST, scopes: ['work'] },
    { id: P.gus, name: 'Gus Holt', scopes: ['work'] },
    { id: P.hana, name: 'Hana Ito', scopes: ['personal'] },
    { id: P.cy, name: 'Cy Person', scopes: ['work'] },
    { id: P.ann, name: 'Ann Example', scopes: ['work', 'personal'] },
    { id: P.bob, name: 'Bob Sample', scopes: ['work'] },
    { id: P.dana, name: 'Dana Lee', scopes: ['personal'] },
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
        expectNudge: 'shown',
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
        expectVoicesMore: '+2 more voices — show',
        // Rows the member didn't touch are saved unnamed (decided 2026-11-01),
        // the two behind "+2 more voices — show" included.
        expectVoiceNames: [{ voiceIndex: 1, name: null }, { voiceIndex: 2, name: null }, { voiceIndex: 3, name: null }, { voiceIndex: 4, name: null }],
    },
    // Three voices, the second with no clip (SAA-260 11-07 items 3, 4 and 8):
    // one row behind "+1 more voice — show", which expands the list; the
    // clipless row says so; prints are off, so the voices part offers
    // Recognize voices…, which opens the opt-in window.
    {
        name: 'threeVoices',
        preview: { matched: true, title: 'Sync', named: ['Ann Example', 'Bob Sample'], unnamed: [] },
        voices: 'ready', talk: [600, 500, 400], noClip: [2],
        drive: [],
        expectGuests: [{ name: 'Ann Example' }, { name: 'Bob Sample' }],
        expectVoicesMore: '+1 more voice — show',
        expandVoices: 3,
        expectNoClip: { without: 2, with: 1 },
        expectNudge: 'click',
        expectVoiceNames: [{ voiceIndex: 1, name: null }, { voiceIndex: 2, name: null }, { voiceIndex: 3, name: null }],
    },
    {
        name: 'group2noRecent',
        preview: { matched: true, title: 'Sync', named: ['Ann Example', 'Bob Sample'], unnamed: [] },
        people: [],
        voices: 'ready', talk: [600, 500],
        drive: [],
        expectGuests: [{ name: 'Ann Example' }, { name: 'Bob Sample' }],
        expectNoRecent: true,
        expectVoiceNames: [{ voiceIndex: 1, name: null }, { voiceIndex: 2, name: null }],
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
        // Recent follows the scope (SAA-260 11-07 item 1): opened on the saved
        // "work", then Personal, then Work again. Ann and Bob are chips and the
        // host is never offered, so work is Gus and Cy, personal Hana and Dana.
        expectRecentScope: { work: [P.gus, P.cy], personal: [P.hana, P.dana] },
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
    // The same with voice prints on: the voices part has no Recognize voices…
    // (control: the line shows only while prints are off).
    {
        name: 'printsOn',
        open: 'voices',
        printsOn: true,
        preview: null,
        saved: {
            identity_version: 2, recording_id: 'CHECK-WINDOW-PO', stem: STEM, answered_at: '2026-11-01T15:43:00.000Z',
            self: { name: HOST, source: 'account_display_name' },
            guests: [{ name: 'Ann Example', personId: P.ann }, { name: 'Bob Sample', personId: P.bob }],
            scope: 'work',
        },
        voices: 'ready', talk: [900, 400],
        drive: [],
        expectNudge: 'absent',
        expectIdentityUnchanged: true,
        expectGuests: [{ name: 'Ann Example', personId: P.ann }, { name: 'Bob Sample', personId: P.bob }],
        expectVoiceNames: [{ voiceIndex: 1, name: null }, { voiceIndex: 2, name: null }],
    },
    // A stop with no calendar match and no scope the app implies: nothing is
    // picked, so Recent is asked with no scope and offers everyone, as before
    // (SAA-260 11-07: "Recent with no scope picked shows as today").
    {
        name: 'noScope',
        preview: null,
        triggerApp: null,
        voices: 'none',
        drive: [],
        expectNoScopePicked: true,
        expectGuests: [],
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
    // Escape in the text box clears it and never skips; with focus on nothing
    // editable, Escape is Skip (the control). Skip writes nothing.
    {
        name: 'escape',
        preview: { matched: true, title: 'Sync', named: ['Ann Example', 'Bob Sample'], unnamed: [] },
        voices: 'none',
        escapeCheck: true,
    },
    // Change attendees… whose saved answer is gone by the time the page asks for
    // it (identity:init). The answer is there when the switch opens the window
    // (the switch checks it, and reopenIdentityForCorrection reads it); the check
    // deletes it the moment main.js logs that it is opening, before the page has
    // loaded. If that race were lost, the page would show the saved chips and the
    // "couldn't load" line below would FAIL, not pass.
    {
        name: 'correctLoadFailed',
        open: 'correct',
        preview: null,
        saved: {
            identity_version: 2, recording_id: 'CHECK-WINDOW-LF', stem: STEM, answered_at: '2026-11-01T15:42:00.000Z',
            self: { name: HOST, source: 'account_display_name' },
            guests: [{ name: 'Ann Example', personId: P.ann }],
            scope: 'work',
        },
        voices: 'none',
        deleteSavedOnOpen: true,
        expectLoadFailed: "Couldn't load this call's attendees. Close and try again.",
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
    // SAA-243 window hardening: all four windows' pages, opened in one launch as
    // the app opens them. The identity window by the switch, setup by itself
    // (this support folder has no setup.json), Recent meetings and Recognize
    // voices by OPEN_SWITCH. See hardeningChecks.
    { name: 'hardening', hardening: true },
];

// --- the stub server ------------------------------------------------------------
function startStub() {
    const state = { offline: false, people: PEOPLE, preview: null, me: { displayName: HOST }, posts: [], requests: [], peopleAsks: [] };
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
                const scope = url.searchParams.get('scope');
                state.peopleAsks.push({ q: url.searchParams.get('q'), scope });
                const hits = state.people.filter((p) => p.name.normalize('NFC').toLowerCase().includes(q))
                    .filter((p) => q || !scope || (p.scopes || []).includes(scope)).slice(0, 10);
                return send(res, 200, { people: hits.map((p) => ({ id: p.id, name: p.name })) });
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
async function connectPage(port, ms, pagePattern = /identity\.html/) {
    const target = await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await res.json();
        return list.find((t) => t.type === 'page' && pagePattern.test(t.url)) || false;
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

// --- SAA-243 window hardening, in each of the four pages ---------------------------
// For each page as the app opens it:
//   - a known-good action: something only the page's own script makes true, so
//     a page that failed to load, or whose script was blocked, passes nothing
//     below by accident
//   - require, process and module are undefined in the page
//   - an inline script the check inserts does not run (the page's CSP,
//     script-src 'self'), and the known-good action still runs after it
//   - its own preload is in force: window.clipwise exists, and sending on a
//     channel of another window throws the preload's refusal (Electron does
//     not report the preload in getLastWebPreferences, so this is shown from
//     the page)
//   - main.js's log line says what Electron applied: contextIsolation and
//     sandbox on, nodeIntegration off, none of its worker, subframe or webview
//     variants on
// The expressions run in the page's main world over the DevTools protocol, as
// the rest of this check does. voice-prints' action draws the "off" state the
// page already shows, with no data from anywhere. Each foreign channel would
// do nothing if the preload let it through: setup:ready and identity:skip
// without their window's token are ignored, and the two ready messages only
// redraw a window that is open.
const HARDENED_PAGES = [
    { page: 'identity.html', foreign: 'setup:ready',
        good: `typeof measuredHeight === 'function' && measuredHeight() > 0 && document.querySelector('#call-line').textContent.trim().length > 0` },
    { page: 'setup.html', foreign: 'meetings:ready',
        good: `typeof draw === 'function' && !!document.querySelector('.screen.shown')` },
    { page: 'meetings.html', foreign: 'voice-prints:ready',
        good: `typeof filterRows === 'function' && filterRows([{ scope: 'work' }, { scope: null }], 'work').length === 1 && document.querySelectorAll('#view button').length === 2` },
    { page: 'voice-prints.html', foreign: 'identity:skip',
        good: `typeof render === 'function' && (render({ enabled: false }), document.querySelector('#on').hidden === false)` },
];
const foreignSend = (channel) => `(() => {
  const c = window.clipwise;
  if (!c || typeof c.send !== 'function' || typeof c.on !== 'function') return { exists: false };
  try { c.send(${JSON.stringify(channel)}, { token: null }); return { exists: true, threw: false }; }
  catch (err) { return { exists: true, threw: true, message: String(err && err.message) }; }
})()`;
const INSERT_INLINE = `(() => { window.__inlineRan = false; const s = document.createElement('script'); s.textContent = 'window.__inlineRan = true;'; document.head.appendChild(s); return window.__inlineRan; })()`;

async function hardeningChecks(port, getLog, t) {
    for (const p of HARDENED_PAGES) {
        const file = p.page.replace('.', '\\.');
        const page = await connectPage(port, 20000, new RegExp(`/${file}(\\?|$)`));
        check(t(`${p.page}: the window opens`), !!page);
        if (!page) continue;
        try {
            const good = !!(await waitFor(() => page.evaluate(p.good), 8000));
            check(t(`${p.page}: its own script ran (known-good action)`), good);
            const kinds = await page.evaluate('[typeof require, typeof process, typeof module]');
            check(t(`${p.page}: require, process and module are undefined (${JSON.stringify(kinds)})`),
                good && JSON.stringify(kinds) === '["undefined","undefined","undefined"]');
            const ran = await page.evaluate(INSERT_INLINE);
            const goodAfter = !!(await page.evaluate(p.good).catch(() => false));
            check(t(`${p.page}: an inserted inline script does not run (ran: ${ran}), and the known-good action still runs after it`),
                good && goodAfter && ran === false);
            const bridge = await page.evaluate(foreignSend(p.foreign));
            check(t(`${p.page}: its preload is in force: window.clipwise exists, and sending on ${p.foreign} throws (${JSON.stringify(bridge)})`),
                good && bridge.exists === true && bridge.threw === true && /not a channel of this window/.test(bridge.message || ''));
        } finally {
            page.close();
        }
        const re = new RegExp(`\\[clipwise-recorder\\] window ${file}: applied ([^\\n]*)`);
        const m = await waitFor(() => re.exec(getLog()), 5000);
        const kv = m ? Object.fromEntries(m[1].trim().split(' ').map((s) => s.split('='))) : {};
        const applied = kv.contextIsolation === 'true' && kv.sandbox === 'true' && kv.nodeIntegration === 'false'
            && ['nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'webviewTag'].every((k) => k in kv && kv[k] !== 'true');
        check(t(`${p.page}: Electron applied: ${m ? m[1].trim() : '(no line)'}`), applied);
    }
}

// --- fixture folders ----------------------------------------------------------------
function silentWav(file) {
    const samples = 1600;
    const b = Buffer.alloc(44 + samples * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
    b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
    fs.writeFileSync(file, b);
}
function writeCapture(outdir, n, { triggerApp = { key: 'zoom', name: 'zoom.us' } } = {}) {
    const w = (name, doc) => fs.writeFileSync(path.join(outdir, name), JSON.stringify(doc, null, 2) + '\n');
    w(`manifest-${STEM}.json`, {
        recording_id: `CHECK-WINDOW-${n}`,
        started_at: '2026-11-01T15:09:12.000Z',
        trigger_app: triggerApp,
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
        // A live process, as a running record carries its pipeline's: the app's
        // recovery pass leaves the capture alone (see the header).
        ...(NO_PID ? {} : { pid: process.pid }),
        steps: {
            transcribe: { state: 'ok' },
            classify: { state: 'ok', detail: { classification: { verdict: 'ok', concern: null, reason: null, excludedLabels: [], tracks: null, thresholds: null } } },
            diarize: { state: 'running' },
        },
    });
}
// plant: an embedding field on every voice in both files, and at the top of the
// naming data, as a real diarize file holds embeddings (the window check's
// control that none reaches the page). noClip: voice indexes with no clip, as
// diarize leaves a voice it found no clean stretch for.
function writeVoices(outdir, talk, { plant = false, noClip = [] } = {}) {
    const emb = plant ? { embedding: [0.125, -0.5, 0.75] } : {};
    const voices = talk.map((secs, i) => {
        if (noClip.includes(i + 1)) return { voiceIndex: i + 1, clipPaths: [], lines: [{ text: `line from voice ${i + 1}`, start: 10 * i + 1.5, end: 10 * i + 4.25 }], ...emb };
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

// What the app's recovery pass would pick up: capture-recover.ts's own
// unfinishedCaptures, imported by a probe run through the server's tsx. The probe
// only imports it; capture-recover.ts and capture-cli.ts run nothing on import
// (each runs only when it is process.argv[1]). It reads the two folders and
// returns, and the folders are this run's own.
function recoveryWouldFinish(root) {
    const mk = (name, withPid) => {
        const dir = path.join(root, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `manifest-${STEM}.json`), JSON.stringify({ recording_id: 'CHECK-RECOVERY' }));
        fs.writeFileSync(path.join(dir, `pipeline-${STEM}.json`), JSON.stringify({
            pipeline: 'capture', updated_at: new Date().toISOString(), ...(withPid ? { pid: process.pid } : {}),
            steps: { transcribe: { state: 'ok' }, classify: { state: 'ok' }, diarize: { state: 'running' } },
        }));
        return dir;
    };
    const dirs = [mk('recovery-with-pid', true), mk('recovery-without-pid', false)];
    const probe = path.join(root, 'recovery-probe.mts');
    fs.writeFileSync(probe, `import { unfinishedCaptures } from ${JSON.stringify(path.join(SERVER_DIR, 'src', 'pipeline', 'capture-recover.ts'))};\n`
        + `process.stdout.write(JSON.stringify(JSON.parse(process.env.CHECK_DIRS).map((d) => unfinishedCaptures(d))));\n`);
    const r = spawnSync(TSX, [probe], { cwd: SERVER_DIR, encoding: 'utf8', timeout: 60000, env: { ...process.env, CHECK_DIRS: JSON.stringify(dirs) } });
    try { return { ok: true, lists: JSON.parse(r.stdout) }; } catch { return { ok: false, detail: `${r.status} ${(r.stderr || '').split('\n').slice(0, 3).join(' | ')}` }; }
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
    writeCapture(outdir, n, fx.triggerApp !== undefined ? { triggerApp: fx.triggerApp } : {});
    const pipelinePath = path.join(outdir, `pipeline-${STEM}.json`);
    let pipelineWritten = fs.readFileSync(pipelinePath, 'utf8');
    const failuresBefore = failures;
    if (fx.voices === 'ready') writeVoices(outdir, fx.talk, { noClip: fx.noClip || [] });
    // Voice prints on: the setting the opt-in screen writes (voice-prints.js
    // enable), and nothing else; no store.
    if (fx.printsOn) {
        const vpDir = path.join(support, 'voice-prints');
        fs.mkdirSync(vpDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(vpDir, 'setting.json'), JSON.stringify({ enabled: true, statementVersion: STATEMENT_VERSION, consentedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    }
    const identityFile = path.join(outdir, `identity-${STEM}.json`);
    if (fx.saved) fs.writeFileSync(identityFile, JSON.stringify(fx.saved, null, 2) + '\n');

    const stub = ctx.stub.state;
    stub.offline = !!fx.offline;
    stub.people = fx.people || PEOPLE;
    stub.preview = fx.preview;
    stub.posts = [];
    stub.peopleAsks = [];

    const port = await freePort();
    let log = '';
    const child = spawn(ELECTRON, [ctx.wrapper, `--remote-debugging-port=${port}`], {
        env: (() => {
            const env = { ...process.env, CLIPWISE_SUPPORT_DIR: support, CHECK_USERDATA: path.join(root, 'userdata') };
            delete env[SWITCH];
            delete env[OPEN_SWITCH];
            if (fx.hardening) env[OPEN_SWITCH] = 'meetings,voice-prints';
            const value = fx.switchValue !== undefined ? fx.switchValue : fx.open ? `${STEM}:${fx.open}` : STEM;
            if (value !== null) env[SWITCH] = value;
            return env;
        })(),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let deletedOnOpen = false;
    const onLog = (d) => {
        log += d;
        if (fx.deleteSavedOnOpen && !deletedOnOpen && /check switch: opening the identity window \(correct\)/.test(log)) {
            deletedOnOpen = true;
            fs.rmSync(identityFile, { force: true });
        }
    };
    child.stdout.on('data', onLog);
    child.stderr.on('data', onLog);
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
        if (fx.hardening) {
            page.close();
            await hardeningChecks(port, () => log, t);
            return;
        }
        await page.evaluate(PAGE_HELPERS);
        const ev = (js) => page.evaluate(js);
        const windowOpen = async () => {
            const res = await fetch(`http://127.0.0.1:${port}/json/list`);
            return (await res.json()).some((x) => /identity\.html/.test(x.url));
        };

        if (fx.expectLoadFailed) {
            check(t('the saved answer was there when the window opened, and was deleted before the page asked for it'), deletedOnOpen);
            const shown = await waitFor(() => ev(`__check.q('#load-failed') ? __check.q('#load-failed').textContent.trim() : false`), 8000);
            check(t(`the field is replaced by "${fx.expectLoadFailed}"`), shown === fx.expectLoadFailed && !(await ev(`!!__check.q('#people-input')`)), JSON.stringify(shown));
            check(t('Save is disabled'), await ev(`__check.q('#save').disabled`));
            await ev(`__check.q('#save').click(); document.activeElement && document.activeElement.blur(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
            await pause(1500);
            check(t('clicking Save or pressing Enter writes nothing and sends nothing; the window stays open'),
                !fs.existsSync(identityFile) && !stub.posts.some((p) => p.identity) && (await windowOpen()),
                `identity file: ${fs.existsSync(identityFile)}; posts: ${JSON.stringify(stub.posts)}`);
            page.close();
            return;
        }

        if (fx.escapeCheck) {
            await waitFor(() => ev(`!!__check.q('#recorded-by') && __check.q('#recorded-by').textContent.trim().length > 0`), 5000);
            await ev(`__check.type('Gus')`);
            await waitFor(() => ev(`__check.qa('#results button').length > 0`), 5000);
            await ev(`__check.q('#people-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
            await pause(1000);
            const after = await ev(`({ text: __check.q('#people-input').value, results: __check.qa('#results button').length })`);
            check(t('Escape in the text box clears it and its results'), after.text === '' && after.results === 0, JSON.stringify(after));
            check(t('Escape in the text box does not skip: the window is still open and nothing is written'),
                (await windowOpen()) && !fs.existsSync(identityFile), `identity file: ${fs.existsSync(identityFile)}`);
            // The control: focus on nothing editable, Escape is Skip.
            await ev(`document.activeElement && document.activeElement.blur(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
            const closed = await waitFor(async () => !(await windowOpen()), 8000);
            check(t('control: with focus on the window body, Escape skips: the window closes'), !!closed);
            check(t('and Skip writes no answer'), !fs.existsSync(identityFile));
            page.close();
            return;
        }

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
            // Recent's ask has been answered before the row is read, so an
            // empty row is the page's doing, not a reply still on its way.
            const recentAsks = () => stub.peopleAsks.filter((a) => !(a.q || '').trim());
            const asked = await waitFor(() => recentAsks().length > 0, 8000);
            await pause(400);
            const recentIds = () => ev(`__check.qa('#recent button[data-person-id]').map((b) => b.dataset.personId)`);
            const recent = await ev(`__check.qa('#recent button[data-person-id]').map((b) => ({ id: b.dataset.personId, text: b.textContent.trim() }))`);
            if (fx.expectNoRecent) {
                check(t('no Recent row when nobody is known'), recent.length === 0, JSON.stringify(recent));
            } else if (fx.preview) {
                // SAA-260 11-07 item 1: the calendar filled the field.
                check(t(`with the calendar's invitees in the field, the Recent row is empty (Recent was asked: ${!!asked}; the stub knows ${stub.people.length} people)`),
                    !!asked && stub.people.length > 0 && recent.length === 0, JSON.stringify(recent));
            } else {
                check(t('the Recent row offers known people, at most four, never the host'),
                    recent.length > 0 && recent.length <= 4 && !recent.some((r) => r.id === P.host || /Jon Example/.test(r.text)), JSON.stringify(recent));
            }
            if (fx.expectNoScopePicked) {
                const active = await ev(`__check.qa('#scope button.active').map((b) => b.dataset.value)`);
                check(t('control: no scope is picked'), active.length === 0, JSON.stringify(active));
                check(t('with no scope picked, Recent is asked with no scope, as before'),
                    recentAsks().length > 0 && recentAsks().every((a) => a.scope === null), JSON.stringify(stub.peopleAsks));
            }
            if (fx.expectRecentScope) {
                const want = fx.expectRecentScope;
                const lastScope = () => { const a = recentAsks(); return a.length ? a[a.length - 1].scope : undefined; };
                check(t(`opened on the saved scope, Recent is asked for "work" and offers ${JSON.stringify(want.work)}`),
                    lastScope() === 'work' && JSON.stringify(await recentIds()) === JSON.stringify(want.work),
                    `${JSON.stringify(stub.peopleAsks)} ${JSON.stringify(await recentIds())}`);
                for (const scope of ['personal', 'work']) {
                    const before = recentAsks().length;
                    await ev(`__check.q('#scope button[data-value="${scope}"]').click()`);
                    const got = await waitFor(async () => recentAsks().length > before && lastScope() === scope
                        && JSON.stringify(await recentIds()) === JSON.stringify(want[scope]), 5000);
                    check(t(`switching to ${scope} asks Recent again for "${scope}" and the row offers ${JSON.stringify(want[scope])}`), !!got,
                        `${JSON.stringify(stub.peopleAsks)} ${JSON.stringify(await recentIds())}`);
                }
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
                // SAA-260 11-07 item 5: an address-only chip says it can be named;
                // a chip with a name never does.
                const marks = await ev(`__check.qa('#chips .chip').map((c) => ({ email: c.dataset.email || '', named: !!c.dataset.named, add: !!c.querySelector('.add-name') && c.querySelector('.add-name').textContent }))`);
                const addr = marks.find((m) => m.email === step.nameAddress);
                check(t(`the address chip ${step.nameAddress} shows "· add name"`), !!addr && addr.add === '· add name', JSON.stringify(marks));
                check(t('control: no chip with a name shows "· add name"'), marks.some((m) => m.named) && marks.filter((m) => m.named).every((m) => !m.add), JSON.stringify(marks));
                await ev(`__check.q('${sel}').click()`);
                const ok = await waitFor(() => ev(`!!__check.q('${sel} input')`), 3000);
                check(t(`the address chip ${step.nameAddress} opens a name box`), !!ok);
                if (ok) {
                    await ev(`(() => { const i = __check.q('${sel} input'); i.value = ${JSON.stringify(step.text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
                    await pause(900);
                    await ev(`__check.enter(__check.q('${sel} input'))`);
                    await pause(300);
                    const after = await ev(`(() => { const c = __check.q('${sel}'); return c ? { named: !!c.dataset.named, add: !!c.querySelector('.add-name') } : null; })()`);
                    check(t(`control: once named, ${step.nameAddress}'s chip does not show "· add name"`), !!after && after.named && !after.add, JSON.stringify(after));
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
            check(t(`before the voices are ready, the voices part reads "${FINDING}"`), before === FINDING, JSON.stringify(before));
            if (fx.plantEmbedding) {
                // A second listener on the page, beside the page's own, keeps
                // what main.js sent exactly as it arrived.
                await ev(`(() => { window.__voicesSent = null; window.clipwise.on('identity:voices', (_e, d) => { window.__voicesSent = JSON.stringify(d); }); return true; })()`);
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
                check(t(`past two voices, the rest are behind "${fx.expectVoicesMore}"`), more === fx.expectVoicesMore && rows === 2, `${JSON.stringify(more)} rows=${rows}`);
            }
            if (fx.expandVoices) {
                await ev(`__check.q('#voices-more') && __check.q('#voices-more').click()`);
                const all = await waitFor(() => ev(`__check.qa('.voice-row[data-voice]').length === ${fx.expandVoices} && !__check.q('#voices-more')`), 3000);
                check(t(`control: clicking it shows all ${fx.expandVoices} voices`), !!all, String(await ev(`__check.qa('.voice-row[data-voice]').length`)));
            }
            if (fx.expectNoClip) {
                const row = (i) => ev(`(() => { const r = __check.q('.voice-row[data-voice="${i}"]'); if (!r) return null; const p = r.querySelector('.play'); return { play: !!p, disabled: !!p && p.disabled, note: r.querySelector('.no-clip') ? r.querySelector('.no-clip').textContent.trim() : null }; })()`);
                const without = await row(fx.expectNoClip.without);
                const withClip = await row(fx.expectNoClip.with);
                check(t(`Voice ${fx.expectNoClip.without}, with no clip, says "No clear clip for this voice" and has no Play button`),
                    !!without && without.note === 'No clear clip for this voice' && !without.play, JSON.stringify(without));
                check(t(`control: Voice ${fx.expectNoClip.with}, with a clip, has an enabled Play button and no such line`),
                    !!withClip && withClip.play && !withClip.disabled && withClip.note === null, JSON.stringify(withClip));
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
            check(t(`before diarize finishes, the voices part reads "${FINDING}"`), before === FINDING, JSON.stringify(before));
            const sidecarPath = path.join(outdir, `pipeline-${STEM}.json`);
            const sidecar = readJson(sidecarPath);
            sidecar.steps.diarize = fx.diarizeOutcome;
            pipelineWritten = JSON.stringify(sidecar, null, 2) + '\n';
            fs.writeFileSync(sidecarPath, pipelineWritten);
            const shown = await waitFor(async () => {
                const text = await ev(`__check.q('#voices-finding') ? __check.q('#voices-finding').textContent.trim() : null`);
                return text === fx.expectVoicesMessage ? text : false;
            }, 10000);
            check(t(`then it reads "${fx.expectVoicesMessage}", not "${FINDING}" until the cap`), !!shown,
                JSON.stringify(await ev(`__check.q('#voices-finding') ? __check.q('#voices-finding').textContent.trim() : null`)));
            const rows = await ev(`__check.qa('.voice-row[data-voice]').length`);
            check(t('and shows no voice rows'), rows === 0, String(rows));
        }
        if (fx.expectFinding) {
            const finding = await ev(`__check.q('#voices-finding') ? __check.q('#voices-finding').textContent.trim() : null`);
            check(t(`the voices part reads "${FINDING}" and Save is not held back`), finding === FINDING && (await ev(`!__check.q('#save').disabled`)), JSON.stringify(finding));
        }
        // SAA-260 11-07 item 3: while prints are off, the voices part offers
        // Recognize voices…, which opens the opt-in window through the
        // window's own channel; with prints on there is no such line.
        if (fx.expectNudge) {
            const nudge = await ev(`(() => { const n = __check.q('#prints-nudge'); const b = __check.q('#prints-nudge-open'); return { exists: !!n, shown: !!n && !n.hidden && n.offsetParent !== null, link: b ? b.textContent.trim() : null }; })()`);
            if (fx.expectNudge === 'absent') {
                const part = await ev(`!!__check.q('#voices-part') && __check.q('#voices-part').offsetParent !== null`);
                check(t('with prints on, the voices part shows no Recognize voices… line'), part && !nudge.shown, JSON.stringify({ part, nudge }));
            } else {
                check(t('with prints off, the voices part shows "Recognize voices…"'), nudge.shown && nudge.link === 'Recognize voices…', JSON.stringify(nudge));
            }
            if (fx.expectNudge === 'click') {
                const listed = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).some((x) => x.type === 'page' && /voice-prints\.html/.test(x.url));
                const before = await listed();
                await ev(`__check.q('#prints-nudge-open') && __check.q('#prints-nudge-open').click()`);
                const opened = await waitFor(listed, 8000);
                check(t(`clicking it opens the opt-in window, voice-prints.html (open before the click: ${before})`), !before && !!opened);
                check(t('and main.js logs that it opened it from the voices part'), /identity [^:]+: opening Recognize voices from the voices part/.test(log));
                const sent = await ev(`(() => { try { window.clipwise.send('identity:open-voice-prints', { token: 'not-this-window' }); return 'sent'; } catch (err) { return String(err && err.message); } })()`);
                await pause(800);
                check(t(`a send on that channel with another window's token opens nothing more and logs nothing (${sent})`),
                    sent === 'sent' && (log.match(/opening Recognize voices from the voices part/g) || []).length === 1);
            }
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
            fit.scrollHeight <= fit.clientHeight && fit.measured !== null && fit.measured <= IDENTITY_WINDOW.maxHeight, JSON.stringify(fit));

        // Nothing but this check wrote the pipeline record: the recovery pass
        // left it alone.
        const pipelineNow = fs.readFileSync(pipelinePath, 'utf8');
        check(t('the app\'s recovery pass left the pipeline record as the check wrote it'), pipelineNow === pipelineWritten, pipelineNow.slice(0, 400));

        // The pipeline finishes before Save, as a real one does once diarize is
        // done: the upload queue sends a capture only when its pipeline has
        // settled (main.js drainUploadQueue, pipelineSettled). transcribe,
        // classify and the pid are kept. groupFinding is the control: its diarize
        // stays running, and its answer is held back.
        if (!fx.expectFinding) {
            const doc = JSON.parse(pipelineNow);
            doc.steps.diarize = { state: 'ok' };
            pipelineWritten = JSON.stringify(doc, null, 2) + '\n';
            fs.writeFileSync(pipelinePath, pipelineWritten);
        }

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
            check(t('voices that arrive after Save are pending for the tray\'s reopen'), pendingVoiceNamingStems(outdir).includes(STEM), JSON.stringify(pendingVoiceNamingStems(outdir)));
        }
        if (!fx.offline) {
            const cache = readJson(path.join(support, 'identity-self.json'));
            check(t('identity-self.json caches the account\'s display name'), !!cache && cache.name === HOST, JSON.stringify(cache));
        }
        if (fx.expectFinding) {
            // The control: diarize still running under a live pid, so the answer
            // is queued and held, not sent.
            const post = await waitFor(() => stub.posts.find((p) => p.identity) || false, 10000);
            check(t('control: with diarize still running, no POST /captures comes within 10 s'), !post, JSON.stringify(post && post.identity));
            const entry = readJson(path.join(support, 'upload-queue', `${STEM}.json`));
            const waitMs = entry ? Date.parse(entry.nextAttemptAt) - Date.parse(entry.queuedAt) : NaN;
            check(t('control: its queue entry is queued, attempts 0, next attempt about 60 s after it was queued'),
                !!entry && entry.state === 'queued' && entry.attempts === 0 && waitMs >= 55000 && waitMs <= 65000, JSON.stringify(entry));
            check(t('control: the app logs that the upload is waiting for its pipeline'),
                log.includes(`[clipwise-recorder] upload ${STEM}: waiting for its pipeline`),
                log.split('\n').filter((l) => /upload/.test(l)).join(' | '));
            page.close();
            return;
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
    } catch (err) {
        check(t('the fixture runs to its end'), false, `threw: ${err && err.message ? err.message.split('\n')[0] : String(err)}`);
    } finally {
        if (exited === null) child.kill('SIGTERM');
        await waitFor(() => exited !== null, 8000);
        if (exited === null) child.kill('SIGKILL');
        // A fixture with a FAIL keeps what explains it: the pipeline record and
        // the recovery pass's log, printed before the temporary folder goes.
        if (failures > failuresBefore) {
            const kept = (label, text) => console.log(`      --- ${fx.name}: kept ${label}\n${text.replace(/^/gm, '      | ')}`);
            const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return '(none)'; } };
            for (const name of [`pipeline-${STEM}.json`, 'recovery.log', `recovery-${STEM}.json`]) kept(name, read(path.join(outdir, name)));
            kept(`upload-queue/${STEM}.json`, read(path.join(support, 'upload-queue', `${STEM}.json`)));
            let dayLogs = [];
            try { dayLogs = fs.readdirSync(outdir).filter((f) => /^recorder-\d{4}-\d{2}-\d{2}\.log$/.test(f)); } catch {}
            for (const f of dayLogs) kept(`${f} (upload lines)`, read(path.join(outdir, f)).split('\n').filter((l) => /upload/.test(l)).join('\n') || '(no upload lines)');
            if (dayLogs.length === 0) kept('day log', '(no recorder-*.log in the recordings folder)');
            kept('app stderr (upload lines)', log.split('\n').filter((l) => /upload/.test(l)).join('\n') || '(no upload lines)');
        }
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
        const rec = recoveryWouldFinish(root);
        check('the app\'s recovery pass leaves a running record carrying a live pid alone (capture-recover.ts unfinishedCaptures)',
            rec.ok && JSON.stringify(rec.lists[0]) === '[]', rec.ok ? JSON.stringify(rec.lists) : rec.detail);
        check('control: it would finish the same record without a pid',
            rec.ok && JSON.stringify(rec.lists[1]) === JSON.stringify([{ stem: STEM, why: 'diarize running' }]), rec.ok ? JSON.stringify(rec.lists) : rec.detail);
        let n = 0;
        const fixtures = ONLY ? FIXTURES.filter((fx) => fx.name === ONLY) : FIXTURES;
        check(`${ONLY ? `CHECK_FIXTURE=${ONLY} names a fixture` : 'every fixture runs'}${NO_PID ? ' (records written without pid)' : ''}`, fixtures.length > 0, ONLY || '');
        for (const fx of fixtures) {
            try {
                await runFixture(fx, ++n, { root, wrapper, tokenFile, stub });
            } catch (err) {
                check(`${fx.name}: the fixture is set up and launched`, false, `threw: ${err && err.message ? err.message.split('\n')[0] : String(err)}`);
            }
        }
    } finally {
        stub.server.close();
        if (keychainHas(KEYCHAIN_ITEM)) spawnSync('security', ['delete-generic-password', '-s', KEYCHAIN_ITEM]);
        check(`teardown: the keychain item "${KEYCHAIN_ITEM}" is gone`, !keychainHas(KEYCHAIN_ITEM));
        fs.rmSync(root, { recursive: true, force: true });
        console.log(failures === 0 ? '\ncheck-identity-window: all passed' : `\ncheck-identity-window: ${failures} FAILED`);
        process.exit(failures === 0 ? 0 : 1);
    }
})();
