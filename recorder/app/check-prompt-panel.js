#!/usr/bin/env node
// The prompt panel as the app shows it (SAA-291, SAA-299): the real main.js opens the
// real prompt-panel.html through its check-only switch, and this drives the
// page over the DevTools protocol (button clicks in its DOM), then reads the
// app's log lines, the learned-app file main.js writes, and the window as macOS
// lists it from outside the app (CGWindowListCopyWindowInfo, through JXA): its
// owner pid, window level and bounds.
//
// Dev mode only, through a wrapper app named clipwise-prompt-panel-check, so the
// run never uses the installed app's identity: not its app name
// (clipwise-recorder), not its keychain item, not its support folder (project
// CLAUDE.md). Electron's userData and CLIPWISE_SUPPORT_DIR are folders in one
// temporary folder, removed at the end. No capture token and no
// capture-server.json are written, so nothing reads the keychain, and "Sign in…"
// stops at signInToCaptureServer's first line: no browser, no request. The
// keychain item "clipwise-prompt-panel-check Safe Storage" must not exist before
// the run and must not exist after it.
//
// main.js's switches, read in one place each:
//   CLIPWISE_CHECK_PROMPT_PANEL   "detect", "signed-out", "signed-out,detect",
//                                 and for the recording notice (SAA-299)
//                                 "notice", "notice,stop", "detect,notice",
//                                 "detect,notice,expire", "signed-out,notice",
//                                 "notice,signed-out"
//                                 (openPromptPanelForCheck). detect prompts for
//                                 a made-up app that is not using the mic, so
//                                 "Always record" writes the rule and starts no
//                                 capture. notice opens the recording notice
//                                 through recordingNoticeStep, the call
//                                 notifyStateChange makes when both tracks start
//                                 writing; no capture runs. stop, expire and a
//                                 signed-out after notice run 3 s after the
//                                 notice is shown, each with one line: the
//                                 stop's half of recordingNoticeStep,
//                                 expireDetectPrompt (the function the prompt's
//                                 own timer calls) and signOutAfterRefresh.
//   CLIPWISE_CHECK_PROMPT_TTL_MS  the prompt's expiry, read only when the switch
//                                 above is set.
//
// What it can't show, left for a person at the screen: that the panel appears
// over a full-screen app on the space being looked at, that a real click
// (not a DOM click) on a button works first time, and that keyboard focus stays
// in the call. focused=false in the shown line is the window's own report.
//
// The check refuses to start when the recorder's capture binaries are built in
// this checkout (call detection could start a capture), or when the wrapper's
// name is the installed app's.
//
//   node check-prompt-panel.js
//   CHECK_FIXTURE=detectExpiry node check-prompt-panel.js    one fixture only
//
// Exit 0 when every check passes, 1 otherwise.

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const P = require('./prompt-panel.js');
const consent = require('./consent.js');

const HERE = __dirname;
const RECORDER_DIR = path.resolve(HERE, '..');
const ELECTRON = path.join(HERE, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const MAIN_JS = path.join(HERE, 'main.js');
const APP_NAME = 'clipwise-prompt-panel-check';
const KEYCHAIN_ITEM = `${APP_NAME} Safe Storage`;
const INSTALLED_NAMES = ['clipwise-recorder', 'Clipwise'];
const SWITCH = 'CLIPWISE_CHECK_PROMPT_PANEL';
const TTL_SWITCH = 'CLIPWISE_CHECK_PROMPT_TTL_MS';
const KEY = 'com.example.panelcheck';
const APP_LABEL = 'Panel Check';
const ONLY = process.env.CHECK_FIXTURE || null;
// NSFloatingWindowLevel, as CGWindowList reports a window's layer.
const FLOATING_LAYER = 3;

let failures = 0;
function check(name, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, step = 200) {
    const end = Date.now() + ms;
    for (;;) {
        let v;
        try { v = await pred(); } catch { v = false; }
        if (v) return v;
        if (Date.now() >= end) return false;
        await pause(step);
    }
}
function keychainHas(item) {
    return keychainExit(item) === 0;
}
// find-generic-password's exit status only, its output discarded (without -g it
// prints attributes, never the secret). Read only.
function keychainExit(item) {
    return spawnSync('security', ['find-generic-password', '-s', item], { stdio: 'ignore' }).status;
}
// The installed app's keychain items, read only, before and after the run: the
// packaged app's package.json name is clipwise-recorder (build-app.sh), and
// Electron names the item "<app name> Safe Storage"; its bundle name, Clipwise,
// is read too in case that convention is wrong. Expected: clipwise-recorder's
// exists, and both give the same exit status after the run as before.
const INSTALLED_KEYCHAIN_ITEMS = ['clipwise-recorder Safe Storage', 'Clipwise Safe Storage'];
function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

// The on-screen windows owned by a pid, from outside the app.
function windowsOf(pid) {
    const js = 'ObjC.import("CoreGraphics"); JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0))).map(w => ({ pid: w.kCGWindowOwnerPID, layer: w.kCGWindowLayer, b: w.kCGWindowBounds })))';
    const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) return null;
    try { return JSON.parse(r.stdout).filter((w) => w.pid === pid); } catch { return null; }
}
// prompt-panel.js's functions, called so that one missing from an older copy
// (the control run against 5b636ca) fails its own cases rather than the run.
const tryCall = (name, ...args) => { try { return P[name](...args); } catch { return undefined; } };
const sizeOf = (kind) => tryCall('panelSize', kind) || P.PANEL_SIZE;
const panelSized = (w, kind) => { const s = sizeOf(kind); return !!w.b && Math.abs(w.b.Width - s.width) <= 2 && Math.abs(w.b.Height - s.height) <= 2; };
const anyPanelSized = (w) => Object.keys(P.KINDS).some((k) => panelSized(w, k));

// --- the DevTools protocol, minimal ----------------------------------------------
// Every step against the page has a time limit, so a panel that has gone (closed
// or replaced while the check still holds its page) fails the fixture with the
// step's name instead of hanging the run. The fixture's catch reports it as
// "FAIL  <fixture>: the fixture runs to its end — threw: <step> timed out".
const STEP_MS = 10000;
const HTTP_MS = 5000;
function withLimit(promise, step, ms = STEP_MS) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${step} timed out after ${ms / 1000} s`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}
// A step's name: the /*step:…*/ marker at the start of an expression (VIEW,
// click, FITS), or else its first 60 characters.
const stepName = (expression) => { const m = /^\/\*step:([^*]*)\*\//.exec(expression); return m ? m[1] : expression.replace(/\s+/g, ' ').slice(0, 60); };
async function connectPanel(port, ms) {
    const target = await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(HTTP_MS) });
        return (await res.json()).find((t) => t.type === 'page' && /\/prompt-panel\.html(\?|$)/.test(t.url)) || false;
    }, ms, 250);
    if (!target) return null;
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await withLimit(new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }), 'connectPanel: open the page\'s DevTools socket');
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
    };
    // A socket that closes (the page went) fails whatever is still waiting on it.
    ws.onclose = () => { for (const p of pending.values()) p.reject(new Error(`${p.step}: the page's DevTools socket closed`)); pending.clear(); };
    const call = (method, params, step) => new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject, step });
        try { ws.send(JSON.stringify({ id: n, method, params })); } catch (err) { pending.delete(n); reject(new Error(`${step}: ${err.message}`)); }
    });
    const evaluate = async (expression) => {
        const step = `page.evaluate (${stepName(expression)})`;
        const r = await withLimit(call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, step), step);
        if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'page threw');
        return r.result && r.result.result ? r.result.result.value : undefined;
    };
    return { evaluate, url: target.url, close: () => { try { ws.close(); } catch {} } };
}
async function panelOpen(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(HTTP_MS) });
        return (await res.json()).some((t) => t.type === 'page' && /\/prompt-panel\.html/.test(t.url));
    } catch { return false; }
}
const VIEW = `/*step:read the view*/({ title: document.querySelector('#title').textContent, body: document.querySelector('#body').textContent,
  buttons: [...document.querySelectorAll('#buttons button')].map((b) => ({ label: b.textContent, choice: b.dataset.choice, cls: b.className })) })`;
const click = (choice) => `/*step:click ${choice}*/(() => { const b = document.querySelector('#buttons button[data-choice="${choice}"]'); if (!b) return false; b.click(); return true; })()`;
// Whether what the page drew fits the window, both ways. Height: nothing below
// the body's box (it clips, overflow hidden) and the buttons above the window's
// bottom. Width: every button's right edge inside the window, the button row
// not wider than its box, the body not wider than its box. And the title not
// cut off. extra, when given, is appended to the body first and taken off
// after (the control: a body too long for the window must be found not to fit).
const FITS = (extra = '') => `/*step:measure fit${extra ? ' (control text)' : ''}*/(() => {
  const b = document.body, t = document.querySelector('#title'), body = document.querySelector('#body');
  const row = document.querySelector('#buttons');
  const was = body.textContent;
  if (${JSON.stringify(extra)}) body.textContent = was + ' ' + ${JSON.stringify(extra)};
  const r = row.getBoundingClientRect();
  const rights = [...row.querySelectorAll('button')].map((x) => x.getBoundingClientRect().right);
  const out = { scroll: b.scrollHeight, client: b.clientHeight, bottom: Math.round(r.bottom), inner: innerHeight,
    innerWidth, buttonRights: rights, rowScrollWidth: row.scrollWidth, rowClientWidth: row.clientWidth,
    bodyScrollWidth: b.scrollWidth, bodyClientWidth: b.clientWidth, titleCut: t.scrollWidth > t.clientWidth };
  out.tall = out.scroll <= out.client && out.bottom <= out.inner;
  out.wide = rights.length > 0 && rights.every((x) => x <= innerWidth) && out.rowScrollWidth <= out.rowClientWidth
    && out.bodyScrollWidth <= out.bodyClientWidth;
  out.fits = out.tall && out.wide && !out.titleCut;
  body.textContent = was;
  return out;
})()`;

// --- fixtures ------------------------------------------------------------------------
const LAUNCHED = /update: not checked/;
// What a start attempt logs (main.js startRecording: the notice gate, a
// refusal, the permissions wait, the fallback) and what a capture that reached
// recording logs. None may appear when "Always record" is answered for an app
// that is not using the mic.
const NO_CAPTURE = /consent: start blocked|start refused|start blocked until|start: system audio|notify: recording-started-notice|panel: recording-notice/;
const DETECT_BUTTONS = '["Never ask about this app","Not now","Always record"]';
// The notification the recording notice replaced, delivered or not (SAA-299).
const OLD_NOTICE = /notify: (delivered — )?recording-started-notice\b/;
const NOTICE_SHOWN = /^panel: recording-notice shown /;
const DETECT_SHOWN = /^panel: detect-prompt shown /;
const FIXTURES = [
    // Without the switch, nothing opens and the expiry override is not read.
    { name: 'noSwitch', switchValue: null, ttl: '1000' },
    { name: 'switchBad', switchValue: 'bogus' },
    { name: 'detectRecord', switchValue: 'detect', answer: 'record' },
    { name: 'detectNotNow', switchValue: 'detect', answer: 'not_now', ignoredFirst: true, hardening: true },
    { name: 'detectNever', switchValue: 'detect', answer: 'never' },
    { name: 'detectExpiry', switchValue: 'detect', ttl: '2000' },
    // A bad override with the switch set: the full three minutes stand.
    { name: 'ttlBad', switchValue: 'detect', ttl: '5', answer: 'not_now' },
    { name: 'signedOutLater', switchValue: 'signed-out', answer: 'later' },
    { name: 'signedOutSignIn', switchValue: 'signed-out', answer: 'sign_in' },
    { name: 'replace', switchValue: 'signed-out,detect' },
    // The recording notice (SAA-299).
    { name: 'noticeOk', switchValue: 'notice', answer: 'ok', hardening: true },
    { name: 'noticeStop', switchValue: 'notice,stop' },
    { name: 'detectNotice', switchValue: 'detect,notice' },
    { name: 'detectNoticeExpired', switchValue: 'detect,notice,expire' },
    { name: 'signedOutNotice', switchValue: 'signed-out,notice' },
    // Signed out by a refresh while the notice is up: it waits behind it.
    { name: 'noticeSignedOut', switchValue: 'notice,signed-out' },
];

async function runFixture(fx, ctx) {
    const root = path.join(ctx.root, fx.name);
    const support = path.join(root, 'support');
    fs.mkdirSync(support, { recursive: true });
    // main.js DETECT_STORE_PATH.
    const appsFile = path.join(support, 'detected-apps.json');
    const port = await freePort();
    let log = '';
    const env = { ...process.env, CLIPWISE_SUPPORT_DIR: support, CHECK_USERDATA: path.join(root, 'userdata') };
    delete env[SWITCH];
    delete env[TTL_SWITCH];
    delete env.CLIPWISE_CHECK_PROMPT_STEM;
    delete env.CLIPWISE_CHECK_OPEN_WINDOWS;
    if (fx.switchValue) env[SWITCH] = fx.switchValue;
    if (fx.ttl) env[TTL_SWITCH] = fx.ttl;
    const child = spawn(ELECTRON, [ctx.wrapper, `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    let exited = null;
    child.on('exit', (c, s) => { exited = `${c} ${s}`; });
    const t = (s) => `${fx.name}: ${s}`;
    const lines = (re) => log.split('\n').filter((l) => re.test(l));
    const panelLines = () => lines(/^panel: /).map((l) => l.trim());
    const failuresBefore = failures;

    try {
        const launched = await waitFor(() => LAUNCHED.test(log), 30000);
        check(t('the app launched under the wrapper'), !!launched, `exited=${exited}; tail: ${log.split('\n').slice(-5).join(' | ')}`);
        if (!launched) return;
        check(t('the wrapper was not turned away by a single-instance lock'), !/another Clipwise is already running/.test(log));

        if (fx.name === 'noSwitch' || fx.name === 'switchBad') {
            await pause(2500);
            const open = await panelOpen(port);
            check(t('no panel is opened'), !open && panelLines().length === 0, JSON.stringify(panelLines()));
            const sw = lines(/check switch:/).map((l) => l.trim());
            const expect = fx.name === 'noSwitch' ? []
                : ['[clipwise-recorder] check switch: nothing opened — not one of the values check-prompt-panel.js uses'];
            check(t(`the switch logs ${expect.length ? 'exactly one line, saying why' : 'nothing, and the expiry override (set to 1000) is not read'}`),
                JSON.stringify(sw) === JSON.stringify(expect), JSON.stringify(sw));
            return;
        }

        if (fx.ttl === '2000') {
            check(t('with the switch set, the expiry override applies and says so'), lines(/check switch: prompt expiry 2000 ms/).length === 1);
        } else if (fx.ttl === '5') {
            check(t('an override outside 500..180000 is ignored and says so; no expiry line'),
                lines(/check switch: prompt expiry override ignored/).length === 1 && lines(/check switch: prompt expiry \d+ ms/).length === 0);
        } else {
            check(t('no override set: no expiry line'), lines(/check switch: prompt expiry/).length === 0);
        }

        const isNotice = fx.switchValue.split(',').includes('notice');
        const firstKind = isNotice ? 'recording-notice' : fx.switchValue === 'signed-out' ? 'signed-out' : 'detect-prompt';
        const shownRe = new RegExp(`^panel: ${firstKind} shown \\(visible=true, focused=false\\)`);
        const shown = await waitFor(() => panelLines().some((l) => shownRe.test(l)), 15000);
        check(t(`the ${firstKind} panel is shown, and reports visible=true, focused=false`), !!shown, JSON.stringify(panelLines()));
        if (fx.name === 'replace') {
            check(t('the signed-out notice was replaced by the detect prompt before it showed'),
                panelLines()[0] === 'panel: signed-out closed — replaced', JSON.stringify(panelLines()));
        }
        if (fx.name === 'detectNotice' || fx.name === 'detectNoticeExpired') {
            check(t('the detect prompt was replaced by the recording notice'),
                panelLines()[0] === 'panel: detect-prompt closed — replaced', JSON.stringify(panelLines()));
        }
        if (fx.name === 'signedOutNotice') {
            check(t('the signed-out notice was replaced by the recording notice'),
                panelLines()[0] === 'panel: signed-out closed — replaced', JSON.stringify(panelLines()));
        }
        const page = await connectPanel(port, 10000);
        check(t('the panel page is reachable'), !!page);
        if (!page) return;
        check(t('the page URL carries a token and no app name'), /[?&]token=[A-Za-z0-9_-]{16,}/.test(page.url) && !page.url.includes('Panel'), page.url);

        // From outside the app: one panel-sized window of this process, at the
        // floating level, at the top right of a display, inset 16.
        const wins = await waitFor(() => { const w = windowsOf(child.pid); return w && w.some((x) => panelSized(x, firstKind)) ? w : false; }, 5000);
        const pw = wins ? wins.find((x) => panelSized(x, firstKind)) : null;
        check(t(`macOS lists the panel as this process's window at the floating level (layer ${pw ? pw.layer : 'none'})`),
            !!pw && pw.layer === FLOATING_LAYER, JSON.stringify(wins));
        check(t(`it sits ${P.PANEL_INSET} pt below the top of a display's work area and its right edge is ${P.PANEL_INSET} pt from that display's right edge (${pw ? JSON.stringify(pw.b) : 'none'})`),
            !!pw && ctx.displays.some((d) => Math.abs(d.x + d.width - (pw.b.X + pw.b.Width) - P.PANEL_INSET) <= 1 && Math.abs(pw.b.Y - d.y - d.top - P.PANEL_INSET) <= 1),
            JSON.stringify(ctx.displays));

        const view = await page.evaluate(VIEW);
        if (firstKind === 'detect-prompt') {
            check(t('it asks the question, naming the app'), view.title === `${APP_LABEL} is using the microphone` && view.body === 'Record calls from this app?', JSON.stringify(view));
            check(t(`its three answers, in order: ${DETECT_BUTTONS}; Always record is the main button, Never is quiet`),
                JSON.stringify(view.buttons.map((b) => b.label)) === DETECT_BUTTONS
                && view.buttons.find((b) => b.choice === 'record').cls === 'primary' && view.buttons.find((b) => b.choice === 'never').cls === 'quiet',
                JSON.stringify(view.buttons));
        } else if (firstKind === 'recording-notice') {
            check(t('it says "Recording — let everyone know", the body is consent.NOTICE_LINE, and OK is its one button, the main one'),
                view.title === 'Recording — let everyone know' && view.body === consent.NOTICE_LINE
                && JSON.stringify(view.buttons.map((b) => b.label)) === '["OK"]' && view.buttons[0].cls === 'primary', JSON.stringify(view));
        } else {
            check(t('it says signed out, with Later and Sign in…'), view.title === 'Clipwise is signed out'
                && view.body === 'Recordings are kept and will upload after you sign in.'
                && JSON.stringify(view.buttons.map((b) => b.label)) === '["Later","Sign in…"]', JSON.stringify(view));
        }
        const fit = await page.evaluate(FITS());
        check(t(`width: every button's right edge <= innerWidth, the button row and the body no wider than their boxes (rights ${fit ? JSON.stringify(fit.buttonRights) : '?'} vs ${fit ? fit.innerWidth : '?'}; row ${fit ? `${fit.rowScrollWidth}/${fit.rowClientWidth}` : '?'}; body ${fit ? `${fit.bodyScrollWidth}/${fit.bodyClientWidth}` : '?'})`),
            !!fit && fit.wide === true, JSON.stringify(fit));
        check(t(`height: what it draws fits the window, and the title is not cut off (${JSON.stringify(fit && { scroll: fit.scroll, client: fit.client, bottom: fit.bottom, inner: fit.inner, titleCut: fit.titleCut })})`),
            !!fit && fit.tall === true && fit.titleCut === false);
        if (firstKind === 'recording-notice') {
            const over = await page.evaluate(FITS(`${consent.NOTICE_LINE} ${consent.NOTICE_LINE}`));
            check(t(`control: the same height measure finds a body three notice lines long does not fit (${JSON.stringify(over && { scroll: over.scroll, client: over.client, bottom: over.bottom, inner: over.inner })})`), !!over && over.tall === false);
            const after = await page.evaluate(VIEW);
            check(t('the control left the page as it was'), after.body === consent.NOTICE_LINE, JSON.stringify(after));
        }
        check(t('no notification was raised for it'), lines(/notify: (delivered — )?(detect-prompt|signed-out|recording-notice)\b/).length === 0 && lines(OLD_NOTICE).length === 0);
        if (isNotice) {
            const planted = `${log}\nnotify: recording-started-notice\n`;
            check(t(`control: the same test finds "notify: recording-started-notice" planted in a copy of this log (count ${planted.split('\n').filter((l) => OLD_NOTICE.test(l)).length})`),
                planted.split('\n').filter((l) => OLD_NOTICE.test(l)).length === 1);
        }

        if (fx.hardening) {
            const kinds = await page.evaluate('[typeof require, typeof process, typeof module]');
            check(t(`hardening: require, process and module are undefined (${JSON.stringify(kinds)})`), JSON.stringify(kinds) === '["undefined","undefined","undefined"]');
            const ran = await page.evaluate(`(() => { window.__inlineRan = false; const s = document.createElement('script'); s.textContent = 'window.__inlineRan = true;'; document.head.appendChild(s); return window.__inlineRan; })()`);
            check(t(`hardening: an inserted inline script does not run (ran: ${ran})`), ran === false);
            const bridge = await page.evaluate(`(() => { try { window.clipwise.send('identity:skip', { token: null }); return 'sent'; } catch (e) { return String(e.message); } })()`);
            check(t(`hardening: sending on another window's channel throws (${bridge})`), /not a channel of this window/.test(bridge));
            const m = /\[clipwise-recorder\] window prompt-panel\.html: applied ([^\n]*)/.exec(log);
            const kv = m ? Object.fromEntries(m[1].trim().split(' ').map((s) => s.split('='))) : {};
            check(t(`hardening: Electron applied: ${m ? m[1].trim() : '(no line)'}`), kv.contextIsolation === 'true' && kv.sandbox === 'true' && kv.nodeIntegration === 'false'
                && ['nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'webviewTag'].every((k) => k in kv && kv[k] !== 'true'));
        }

        if (fx.ignoredFirst) {
            // A stale token, and an answer that is not one of this panel's.
            await page.evaluate(`window.clipwise.send('prompt-panel:answer', { token: 'not-this-panel', choice: 'record' })`);
            await page.evaluate(`window.clipwise.send('prompt-panel:answer', { token: new URLSearchParams(location.search).get('token'), choice: 'sign_in' })`);
            await pause(800);
            check(t('an answer with the wrong token, and one not among its answers, are both ignored: two lines, the panel stays, nothing written'),
                lines(/panel: an answer was ignored/).length === 2 && (await panelOpen(port)) && !fs.existsSync(appsFile)
                && !panelLines().some((l) => / closed /.test(l)), JSON.stringify(panelLines()));
        }

        const EXPIRED = new RegExp(`detect: prompt for ${KEY.replace(/\./g, '\\.')} expired — treated as "not now", nothing written`);
        if (isNotice) {
            const listed = (kind) => { const w = windowsOf(child.pid); return !!w && w.some((x) => panelSized(x, kind)); };
            const closedOk = 'panel: recording-notice closed — answer ok';
            if (fx.name === 'noticeStop') {
                const stopped = await waitFor(() => panelLines().includes('panel: recording-notice closed — stopped'), 15000);
                const stopAt = log.indexOf('check switch: recording stopped');
                const closedAt = log.indexOf('panel: recording-notice closed — stopped');
                check(t('the stop closes it with no click: one "check switch: recording stopped" line, then "closed — stopped"'),
                    !!stopped && lines(/check switch: recording stopped/).length === 1 && stopAt >= 0 && closedAt > stopAt, JSON.stringify(panelLines()));
                page.close();
            } else {
                if (fx.name === 'noticeSignedOut') {
                    const signedOut = await waitFor(() => lines(/check switch: signed out/).length === 1 && lines(/capture token: signed out \(check switch\)/).length === 1, 15000);
                    check(t('while the notice is up, the check signs out through signOutAfterRefresh: one "check switch: signed out" line, then the sign-out line'),
                        !!signedOut, JSON.stringify(lines(/check switch|capture token/)));
                    await pause(1500);
                    check(t('after the sign-out, before OK: macOS still lists the recording notice, and its page is open'),
                        listed('recording-notice') && (await panelOpen(port)), JSON.stringify(windowsOf(child.pid)));
                    check(t('after the sign-out, before OK: the notice was not closed or replaced, and no signed-out panel was shown'),
                        !panelLines().some((l) => /^panel: recording-notice closed/.test(l) || /^panel: signed-out shown/.test(l)), JSON.stringify(panelLines()));
                }
                if (fx.name === 'detectNoticeExpired') {
                    const ended = await waitFor(() => lines(/check switch: detect prompt ended/).length === 1 && lines(EXPIRED).length === 1, 15000);
                    check(t('while the notice is up, the check ends the prompt: one "check switch: detect prompt ended" line, then the expiry line'),
                        !!ended && log.indexOf('check switch: detect prompt ended') < log.search(EXPIRED), JSON.stringify(lines(/check switch|detect:/)));
                    await pause(800);
                    check(t('after the expiry, before OK: macOS still lists the recording notice, and its page is open'),
                        listed('recording-notice') && (await panelOpen(port)), JSON.stringify(windowsOf(child.pid)));
                    check(t('after the expiry, before OK: no "closed" line for the recording notice (no "closed — expiry"): the expiry did not close it'),
                        !panelLines().some((l) => /^panel: recording-notice closed/.test(l)), JSON.stringify(panelLines()));
                }
                check(t('clicking OK'), await page.evaluate(click('ok')));
                page.close();
                const closed = await waitFor(() => panelLines().includes(closedOk), 6000);
                check(t(`OK closes it: "${closedOk}"`), !!closed, JSON.stringify(panelLines()));
                const afterOk = () => panelLines().slice(panelLines().indexOf(closedOk) + 1);
                if (fx.name === 'detectNotice' || fx.name === 'signedOutNotice' || fx.name === 'noticeSignedOut') {
                    const kind = fx.name === 'detectNotice' ? 'detect-prompt' : 'signed-out';
                    const back = await waitFor(() => afterOk().some((l) => l.startsWith(`panel: ${kind} shown `)), 8000);
                    check(t(`the ${kind} panel comes back once the notice closes${kind === 'detect-prompt' ? ' (its prompt is still live)' : ''}`),
                        !!back && panelLines().indexOf(closedOk) >= 0, JSON.stringify(panelLines()));
                    const w2 = await waitFor(() => { const w = windowsOf(child.pid); return w && w.some((x) => panelSized(x, kind)) ? w : false; }, 5000);
                    const pw2 = w2 ? w2.find((x) => panelSized(x, kind)) : null;
                    check(t(`macOS lists the ${kind} panel again, at the floating level`), !!pw2 && pw2.layer === FLOATING_LAYER, JSON.stringify(w2));
                    const again = await connectPanel(port, 8000);
                    const v2 = again ? await again.evaluate(VIEW) : null;
                    const answer = kind === 'detect-prompt' ? 'not_now' : 'later';
                    const title = kind === 'detect-prompt' ? `${APP_LABEL} is using the microphone` : 'Clipwise is signed out';
                    check(t(`it is the ${kind} panel again, and ${answer} closes it`), !!v2 && v2.title === title && (await again.evaluate(click(answer))), JSON.stringify(v2));
                    if (again) again.close();
                    const done = await waitFor(() => panelLines().includes(`panel: ${kind} closed — answer ${answer}`), 5000);
                    check(t(`closed — answer ${answer}`), !!done, JSON.stringify(panelLines()));
                    if (kind === 'detect-prompt') {
                        check(t('the prompt was still live when it came back: no expiry line'), lines(EXPIRED).length === 0);
                    }
                } else {
                    // noticeOk and detectNoticeExpired: nothing comes back.
                    await pause(3000);
                    const w3 = windowsOf(child.pid);
                    check(t(`nothing comes back 3 s after OK: no panel shown after it, no panel page open, and macOS lists no detect-prompt (or any panel) window (${JSON.stringify(w3)})`),
                        !afterOk().some((l) => / shown /.test(l)) && !(await panelOpen(port)) && !!w3 && !w3.some(anyPanelSized), JSON.stringify(panelLines()));
                }
            }
            check(t(`the recording notice was shown once (${panelLines().filter((l) => NOTICE_SHOWN.test(l)).length}), and "notify: recording-started-notice" is not in the log (${lines(OLD_NOTICE).length})`),
                panelLines().filter((l) => NOTICE_SHOWN.test(l)).length === 1 && lines(OLD_NOTICE).length === 0);
        } else if (fx.name === 'detectExpiry') {
            const t0 = Date.now();
            const closed = await waitFor(() => panelLines().includes('panel: detect-prompt closed — expiry'), 8000);
            check(t(`it closes itself on expiry (after ~${Math.round((Date.now() - t0) / 100) / 10}s more)`), !!closed, JSON.stringify(panelLines()));
            check(t('expiry is "not now": the expiry line, and nothing written'),
                lines(new RegExp(`detect: prompt for ${KEY.replace(/\./g, '\\.')} expired — treated as "not now", nothing written`)).length === 1 && !fs.existsSync(appsFile));
        } else if (fx.name === 'replace') {
            check(t('clicking Not now on the detect prompt'), await page.evaluate(click('not_now')));
            page.close();
            const back = await waitFor(() => panelLines().some((l) => /^panel: signed-out shown/.test(l)), 8000);
            check(t('the signed-out notice comes back once the prompt closes'), !!back
                && panelLines().indexOf('panel: detect-prompt closed — answer not_now') >= 0
                && panelLines().indexOf('panel: detect-prompt closed — answer not_now') < panelLines().findIndex((l) => /^panel: signed-out shown/.test(l)), JSON.stringify(panelLines()));
            const again = await connectPanel(port, 8000);
            const v2 = again ? await again.evaluate(VIEW) : null;
            check(t('it is the signed-out notice, and Later closes it'), !!v2 && v2.title === 'Clipwise is signed out' && (await again.evaluate(click('later'))));
            if (again) again.close();
            const done = await waitFor(() => panelLines().includes('panel: signed-out closed — answer later'), 5000);
            check(t('closed — answer later'), !!done, JSON.stringify(panelLines()));
        } else {
            const ttlBadStart = Date.now();
            if (fx.name === 'ttlBad') await pause(2500);
            check(t(`clicking ${fx.answer}`), await page.evaluate(click(fx.answer)));
            page.close();
            const want = `panel: ${firstKind} closed — answer ${fx.answer}`;
            const closed = await waitFor(() => panelLines().includes(want), 6000);
            check(t(`the panel closes itself on the answer: "${want}"`), !!closed, JSON.stringify(panelLines()));
            if (fx.name === 'ttlBad') {
                check(t('the 5 ms override did not expire the prompt: it was still up 2.5 s in'), !panelLines().includes('panel: detect-prompt closed — expiry') && Date.now() - ttlBadStart >= 2500);
            }
            const apps = (() => { try { return JSON.parse(fs.readFileSync(appsFile, 'utf8')); } catch { return null; } })();
            if (fx.answer === 'record' || fx.answer === 'never') {
                check(t(`the answer reaches the detection code: "${fx.answer}" is written for the app`),
                    !!apps && apps.apps[KEY] && apps.apps[KEY].decision === fx.answer && lines(new RegExp(`detect: ${KEY.replace(/\./g, '\\.')} -> ${fx.answer}`)).length === 1,
                    JSON.stringify(apps));
            }
            if (fx.answer === 'record') {
                check(t('no capture starts: the app is not using the mic, so it says nothing was recorded (the existing notification, unchanged)'),
                    lines(/notify: detect-lapsed-nothing/).length === 1 && lines(NO_CAPTURE).length === 0);
                // The control: the line startRecording logs when it is reached in
                // this fixture (no consent.json, so the notice gate is the first
                // thing it logs: main.js startRecording, quoted with this fixture's
                // key), planted in a copy of this log; the same regex finds it once.
                // And the line a capture logs once both tracks are writing.
                const planted = `${log}\n[clipwise-recorder] consent: start blocked until the recording notice is agreed to (triggered by ${KEY})\n`;
                const planted2 = `${log}\nnotify: recording-started-notice\n`;
                const count = (text) => text.split('\n').filter((l) => NO_CAPTURE.test(l)).length;
                check(t(`control: the same regex finds startRecording's line planted in a copy of this log (count ${count(planted)}), and "notify: recording-started-notice" planted in another (count ${count(planted2)})`),
                    count(planted) === 1 && count(planted2) === 1);
            }
            if (fx.answer === 'never') check(t('the existing "will not ask" notification is unchanged'), lines(/notify: detect-never/).length === 1);
            if (fx.answer === 'not_now') {
                check(t('"not now": its line, and nothing written'),
                    lines(new RegExp(`detect: "not now" for ${KEY.replace(/\./g, '\\.')} — nothing written`)).length === 1 && !fs.existsSync(appsFile));
            }
            if (fx.answer === 'later' || fx.answer === 'sign_in') {
                await pause(3000);
                check(t('no re-show: no second signed-out panel 3 s later'), panelLines().filter((l) => /^panel: signed-out shown/.test(l)).length === 1 && !(await panelOpen(port)));
                check(t('no sign-in request is made (no capture-server.json in this support folder)'), lines(/sign-in:/).length === 0);
            }
        }
        const gone = await waitFor(async () => !(await panelOpen(port)) && (() => { const w = windowsOf(child.pid); return w && !w.some(anyPanelSized); })(), 5000);
        check(t('the panel window is gone (DevTools list and macOS window list)'), !!gone);
        check(t('no log line says "delivered" for a panel'), lines(/delivered/).filter((l) => /panel|detect-prompt|signed-out|recording-notice/.test(l)).length === 0);
    } catch (err) {
        check(t('the fixture runs to its end'), false, `threw: ${err && err.message ? err.message.split('\n')[0] : String(err)}`);
    } finally {
        if (exited === null) child.kill('SIGTERM');
        await waitFor(() => exited !== null, 8000);
        if (exited === null) child.kill('SIGKILL');
        if (failures > failuresBefore) {
            console.log(`      --- ${fx.name}: app log lines (panel, detect, check switch, notify)\n${lines(/panel:|detect:|check switch|notify:/).map((l) => `      | ${l}`).join('\n')}`);
        }
    }
}

// --- text checks on main.js ----------------------------------------------------------
function textChecks() {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l));
    const uses = (name) => code.filter((l) => l.includes(name));
    check(`main.js reads ${SWITCH} in one place`, uses(`process.env.${SWITCH}`).length === 1 && uses(SWITCH).length === 1, uses(SWITCH).join(' | '));
    check(`main.js reads ${TTL_SWITCH} in one place`, uses(TTL_SWITCH).length === 1, uses(TTL_SWITCH).join(' | '));
    check('control: the same count finds a second use planted in a copy', [...code, `process.env.${TTL_SWITCH};`].filter((l) => l.includes(TTL_SWITCH)).length === 2);
    check(`the override is read only after "if (!CHECK_PROMPT_PANEL) return DETECT_PROMPT_TTL_MS;"`,
        /const DETECT_PROMPT_EXPIRY_MS = \(\(\) => \{\s*if \(!CHECK_PROMPT_PANEL\) return DETECT_PROMPT_TTL_MS;\s*const raw = process\.env\.CLIPWISE_CHECK_PROMPT_TTL_MS;/.test(src));
    check('the expiry itself is unchanged: DETECT_PROMPT_TTL_MS = 180000', /const DETECT_PROMPT_TTL_MS = 180000;/.test(src));
    const fn = (name) => { const a = src.indexOf(`\nfunction ${name}(`); return a >= 0 ? src.slice(a, src.indexOf('\n}\n', a + 1)) : ''; };
    // promptForApp opens the panel through showDetectPromptPanel (SAA-299, which
    // also calls it to bring the question back) and its timer ends it through
    // expireDetectPrompt: the three together are the question's path.
    const body = fn('promptForApp');
    const show = fn('showDetectPromptPanel');
    const expire = fn('expireDetectPrompt');
    const NOTIFY = /new Notification\(|\bnotify\(|notifyFallback\(|notifyDeliveredLine\(/;
    check('promptForApp, showDetectPromptPanel and expireDetectPrompt raise no notification: the question is asked in one place only (the panel, and the tray)',
        body.length > 0 && show.length > 0 && expire.length > 0 && ![body, show, expire].some((b) => NOTIFY.test(b))
        && /showDetectPromptPanel\(\);/.test(body) && /showPromptPanel\('detect-prompt'/.test(show) && /DETECT_PROMPT_EXPIRY_MS/.test(body));
    check('control: the same test finds a notification planted in a copy of promptForApp', NOTIFY.test(body.replace('renderTray();', 'renderTray(); new Notification({});')));
    check('the panel is made as type "panel", not focusable, first click accepted, shown inactive, on all spaces including over full-screen',
        /type: 'panel',/.test(src) && /focusable: false,/.test(src) && /acceptFirstMouse: true,/.test(src)
        && /p\.win\.showInactive\(\);/.test(src) && /setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true, skipTransformProcessType: true \}\)/.test(src)
        && /setAlwaysOnTop\(true, 'floating'\)/.test(src));
    // prompt-panel.js, run.
    check('prompt-panel.js: each kind accepts its own answers and no others',
        ['never', 'not_now', 'record'].every((c) => P.isAnswer('detect-prompt', c)) && ['later', 'sign_in'].every((c) => P.isAnswer('signed-out', c))
        && !P.isAnswer('detect-prompt', 'sign_in') && !P.isAnswer('signed-out', 'record') && !P.isAnswer('other', 'record') && !P.isAnswer('detect-prompt', undefined));
    // The recording notice (SAA-299).
    const ns = src.indexOf('\nfunction notifyStateChange(prev, next) {');
    const nsBody = ns >= 0 ? src.slice(ns, src.indexOf('\n}\n', ns + 1)) : '';
    const firstStatement = nsBody.split('\n').slice(2).find((l) => l.trim() && !/^\s*\/\//.test(l));
    check(`notifyStateChange's first statement is recordingNoticeStep(prev, next), so every state change passes through it (${firstStatement ? firstStatement.trim() : 'none'})`,
        !!firstStatement && firstStatement.trim() === 'recordingNoticeStep(prev, next);');
    const OLD_NOTIFY = /'recording-started-notice'/;
    check('main.js raises no "recording-started-notice" notification: the notice is shown in one place only',
        code.length > 0 && !code.some((l) => OLD_NOTIFY.test(l)));
    check('control: the same test finds the call planted in a copy of main.js',
        [...code, "        notify('recording-started-notice', 'Recording \\u2014 let everyone know', consent.NOTICE_LINE);"].some((l) => OLD_NOTIFY.test(l)));
    check('the starting -> recording branch still returns before the stalled/resumed pair',
        /if \(next === 'recording' && prev === 'starting'\) \{[\s\S]*?return;\s*\}\s*\/\/ The flapping pair\./.test(nsBody));
    // A detect prompt can't open during a capture, so it never meets the
    // recording notice from that side: handleDetectEvent returns while a
    // capture is running before it can reach promptForApp.
    const guarded = (text) => {
        const a = text.indexOf('\nfunction handleDetectEvent(');
        const hd = a >= 0 ? text.slice(a, text.indexOf('\n}\n', a + 1)) : '';
        const guard = hd.indexOf("if (state !== 'stopped' || session) {");
        const call = hd.indexOf('promptForApp(ev, key);');
        return guard >= 0 && call > guard && /if \(state !== 'stopped' \|\| session\) \{\s*console\.error\([^\n]*\);\s*return;\s*\}/.test(hd);
    };
    check('handleDetectEvent returns while a capture is running (state !== \'stopped\' || session) before it can reach promptForApp', guarded(src));
    check('control: the same test fails on a copy of main.js with that guard removed',
        !guarded(src.replace(/if \(state !== 'stopped' \|\| session\) \{\s*console\.error\(`detect: \$\{key\} started input while already[^\n]*\n\s*return;\s*\}/, '')));
    check("the prompt's timer and the check's expire step both end it through expireDetectPrompt",
        /timer: setTimeout\(\(\) => expireDetectPrompt\(key\), DETECT_PROMPT_EXPIRY_MS\)/.test(src)
        && /afterNoticeShownForCheck\('detect prompt ended', \(\) => expireDetectPrompt\(detectKey\(CHECK_PANEL_APP\)\)\)/.test(src));
    const steps = [['starting', 'recording', 'show'], ['stopped', 'starting', null], ['recording', 'stalled', null], ['stalled', 'recording', null],
        ['recording', 'stopped', 'close'], ['stalled', 'stopped', 'close'], ['starting', 'stopped', 'close']];
    check(`prompt-panel.js noticeStep: shown on starting -> recording only, closed on any stop, nothing else (${steps.map(([a, b]) => `${a}->${b}=${tryCall('noticeStep', a, b)}`).join(' ')})`,
        steps.every(([a, b, want]) => tryCall('noticeStep', a, b) === want));
    const nv = tryCall('panelView', 'recording-notice');
    check('prompt-panel.js: the recording notice says "Recording — let everyone know", its body is consent.NOTICE_LINE, and OK is its one button',
        !!nv && nv.title === 'Recording — let everyone know' && nv.body === consent.NOTICE_LINE
        && JSON.stringify(nv.buttons) === JSON.stringify([{ choice: 'ok', label: 'OK', primary: true }]), JSON.stringify(nv));
    check('prompt-panel.js: the recording notice accepts OK only, and OK is no other panel\'s answer',
        P.isAnswer('recording-notice', 'ok') && !P.isAnswer('recording-notice', 'record') && !P.isAnswer('recording-notice', 'later')
        && !P.isAnswer('detect-prompt', 'ok') && !P.isAnswer('signed-out', 'ok'));
    check('prompt-panel.js: the recording notice is the same width as the other panels and taller',
        typeof P.panelSize === 'function' && sizeOf('recording-notice').width === P.PANEL_SIZE.width && sizeOf('recording-notice').height > P.PANEL_SIZE.height
        && sizeOf('detect-prompt') === P.PANEL_SIZE && sizeOf('signed-out') === P.PANEL_SIZE);
    check('prompt-panel.js: top right of the work area, inset 16',
        JSON.stringify(P.panelPosition({ x: 0, y: 25, width: 1512, height: 920 })) === JSON.stringify({ x: 1512 - P.PANEL_SIZE.width - 16, y: 41 })
        && JSON.stringify(P.panelPosition({ x: -1920, y: 0, width: 1920, height: 1050 })) === JSON.stringify({ x: -P.PANEL_SIZE.width - 16, y: 16 }));
}

// The displays, from outside the app: frame and the work area's top inset (the
// menu bar), in the same top-left coordinates CGWindowList uses.
function displays() {
    const js = 'ObjC.import("AppKit"); const s = $.NSScreen.screens; const main = s.objectAtIndex(0).frame; const out = []; for (let i = 0; i < s.count; i++) { const f = s.objectAtIndex(i).frame; const v = s.objectAtIndex(i).visibleFrame; out.push({ x: f.origin.x, y: main.size.height - f.origin.y - f.size.height, width: f.size.width, height: f.size.height, top: (f.origin.y + f.size.height) - (v.origin.y + v.size.height) }); } JSON.stringify(out)';
    const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8', timeout: 15000 });
    try { return JSON.parse(r.stdout); } catch { return []; }
}

function writeWrapper(root) {
    const dir = path.join(root, 'wrapper');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: APP_NAME, version: '0.0.0', private: true, main: 'entry.js' }) + '\n');
    fs.writeFileSync(path.join(dir, 'entry.js'), `
const { app } = require('electron');
if (app.getName() !== ${JSON.stringify(APP_NAME)}) { console.error('wrapper: app name is ' + app.getName() + ': refusing'); process.exit(2); }
app.setPath('userData', process.env.CHECK_USERDATA);
require(${JSON.stringify(MAIN_JS)});
`);
    return dir;
}

(async () => {
    const built = ['micwatch', 'audiodevs', path.join('systemtap', '.build', 'release', 'systemtap'), path.join('miccap', '.build', 'release', 'miccap')]
        .map((p) => path.join(RECORDER_DIR, p)).filter((p) => fs.existsSync(p));
    if (built.length) { console.log(`check-prompt-panel: refusing: capture binaries are built in this checkout (${built.join(', ')})`); process.exit(2); }
    if (INSTALLED_NAMES.includes(APP_NAME)) { console.log('check-prompt-panel: refusing: the wrapper would run under the installed app\'s name'); process.exit(2); }
    if (!fs.existsSync(ELECTRON)) { console.log(`check-prompt-panel: refusing: no Electron at ${ELECTRON}`); process.exit(2); }

    textChecks();
    const installedBefore = INSTALLED_KEYCHAIN_ITEMS.map(keychainExit);
    check(`installed app's keychain item "${INSTALLED_KEYCHAIN_ITEMS[0]}" exists before the run (read only; exits: ${INSTALLED_KEYCHAIN_ITEMS.map((n, i) => `"${n}"=${installedBefore[i]}`).join(', ')})`,
        installedBefore[0] === 0);
    const keychainBefore = keychainHas(KEYCHAIN_ITEM);
    check(`the keychain item "${KEYCHAIN_ITEM}" does not exist before the run`, !keychainBefore);
    if (keychainBefore) { console.log(`\ncheck-prompt-panel: ${failures} FAILED`); process.exit(1); }
    const ds = displays();
    check(`the displays are read from outside the app (${ds.length})`, ds.length > 0, JSON.stringify(ds));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-check-prompt-panel-'));
    const wrapper = writeWrapper(root);
    try {
        const fixtures = ONLY ? FIXTURES.filter((fx) => fx.name === ONLY) : FIXTURES;
        check(`${ONLY ? `CHECK_FIXTURE=${ONLY} names a fixture` : 'every fixture runs'}`, fixtures.length > 0);
        for (const fx of fixtures) {
            try {
                await runFixture(fx, { root, wrapper, displays: ds });
            } catch (err) {
                check(`${fx.name}: the fixture is set up and launched`, false, `threw: ${err && err.message ? err.message.split('\n')[0] : String(err)}`);
            }
        }
    } finally {
        check(`teardown: the keychain item "${KEYCHAIN_ITEM}" does not exist (none was made)`, !keychainHas(KEYCHAIN_ITEM));
        const installedAfter = INSTALLED_KEYCHAIN_ITEMS.map(keychainExit);
        check(`teardown: the installed app's keychain items are unchanged (read only; exits before ${JSON.stringify(installedBefore)}, after ${JSON.stringify(installedAfter)})`,
            JSON.stringify(installedBefore) === JSON.stringify(installedAfter));
        fs.rmSync(root, { recursive: true, force: true });
        check('teardown: the temporary folder is gone', !fs.existsSync(root));
        console.log(failures === 0 ? '\ncheck-prompt-panel: all passed' : `\ncheck-prompt-panel: ${failures} FAILED`);
        process.exit(failures === 0 ? 0 : 1);
    }
})();
