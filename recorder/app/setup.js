// First-run setup (SAA-198 step 4): the rules behind the "Set up Clipwise"
// window and the tray items around it, launch at login, the offer to move to
// Applications and the recording time in the menu bar title.
//
// The window has four screens, in this order (engineering call 8): the
// recording notice, the team's address, sign-in, and the two audio
// permissions. Each screen's "done" is read from what is already on disk or
// asked of macOS, never from the window: consent.json, capture-server.json, the
// capture token, and the two grants. So a window closed halfway reopens where it
// was left, and an install that already had all four never sees it.
//
// setup.json records that setup was finished once, either by Done in the window
// or the moment all four are found done (settleSetup), so an install that had
// them all before this file existed is never offered setup. After that the
// window never opens again as setup: a later sign-out is "Sign in to Clipwise…"
// in the tray, as before (Jon, 10-13). A raised notice version then shows the
// notice screen alone, not setup (an engineering choice, made in the build).
//
// Split out of main.js, like consent.js, so no Electron is needed to exercise
// it: check-consent.js runs these rules directly. main.js carries them out.

'use strict';

const fs = require('fs');
const path = require('path');

// The fifth, 'claude' (Jon's call 9, SAA-198 step 6), has no "done" of its own:
// it is what the window shows once the four before it are done, and Done there
// finishes setup. Nothing records whether it was seen, and nothing checks the
// connection; an install that already had all four done never opens the window
// as setup, so never shows it.
const SCREENS = ['notice', 'address', 'signin', 'permissions', 'claude'];

function setupPath(supportDir) {
    return path.join(supportDir, 'setup.json');
}

// Written atomically, creating the directory first. Idempotent: the first time is
// kept. Throws if it cannot be written, so the caller does not treat it as saved.
function writeOnce(file, key, now) {
    try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (doc && typeof doc[key] === 'string' && doc[key]) return doc;
    } catch {}
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const doc = { [key]: now.toISOString() };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(`${file}.tmp`, file);
    return doc;
}

function readStamp(file, key) {
    try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        return !!doc && typeof doc === 'object' && typeof doc[key] === 'string' && doc[key].length > 0;
    } catch {
        return false;
    }
}

function isSetupCompleted(supportDir) {
    return readStamp(setupPath(supportDir), 'completed_at');
}

function recordSetupCompleted(supportDir, now = new Date()) {
    return writeOnce(setupPath(supportDir), 'completed_at', now);
}

// A grant counts as settled unless it is unanswered or refused. "restricted",
// "unavailable" and an unexpected value are not statements about this person's
// answer (main.js deniedServices reads them the same way), so they do not hold
// setup open forever.
function permissionSettled(state) {
    return state !== 'notDetermined' && state !== 'denied';
}

// The first of the four screens with a "done" that is not yet done, or null
// when all four are (the window then shows 'claude').
//   status: { acknowledged, server, signedIn, mic, tap }
function firstIncompleteScreen(status) {
    if (!status.acknowledged) return 'notice';
    if (!status.server) return 'address';
    if (!status.signedIn) return 'signin';
    if (!permissionSettled(status.mic) || !permissionSettled(status.tap)) return 'permissions';
    return null;
}

// Whether setup counts as finished, given what is done now. Not yet recorded but
// all four done: recorded at this moment, so an install that was set up before
// setup.json existed (or by hand) never sees "Finish setting up Clipwise…".
// A write that fails still answers from what is done now; it is tried again on
// the next call.
function settleSetup(supportDir, status, now = new Date()) {
    if (isSetupCompleted(supportDir)) return true;
    if (firstIncompleteScreen(status) !== null) return false;
    try { recordSetupCompleted(supportDir, now); } catch {}
    return true;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

// What the person typed, as the origin to check. No scheme means https. http is
// accepted only for this Mac (localhost, 127.0.0.1), which is how a scratch
// server is reached. Anything after the host is dropped.
function normalizeTeamAddress(input) {
    const text = String(input || '').trim();
    if (!text) return { ok: false, error: 'Enter your team’s Clipwise address.' };
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
    let url;
    try {
        url = new URL(withScheme);
    } catch {
        return { ok: false, error: 'That isn’t a web address.' };
    }
    if (url.protocol === 'https:') return { ok: true, origin: url.origin, host: url.host };
    if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return { ok: true, origin: url.origin, host: url.host };
    if (url.protocol === 'http:') return { ok: false, error: 'The address has to start with https://.' };
    return { ok: false, error: 'That isn’t a web address.' };
}

// Does the reply to GET <origin>/.well-known/oauth-protected-resource say this is
// a Clipwise server, and one whose sign-in lives at this same origin? The route
// exists on every instance already (server/src/app.ts), so the server needs no
// change for this check.
function isClipwiseDiscovery(origin, status, body) {
    return status === 200
        && !!body && typeof body === 'object'
        && body.resource_name === 'Clipwise'
        && Array.isArray(body.authorization_servers)
        && body.authorization_servers[0] === `${origin}/api/auth`;
}

// The address Claude connects to: the team's MCP endpoint, the server's own
// origin plus /mcp (server/src/app.ts mounts the MCP endpoint there). Null with
// no server set.
function claudeAddress(origin) {
    return origin ? `${origin}/mcp` : null;
}

// The account items the tray offers, in order:
//   'finish-setup'      setup never finished: the one way back into the window
//   'recording-notice'  setup finished, but the notice is not agreed to (a raised version)
//   'sign-in'           setup finished, a server is set and this Mac holds no token for it
//   'sign-out'          signed in
function trayAccountItems({ setupCompleted, acknowledged, server, signedIn }) {
    const out = [];
    if (!setupCompleted) out.push('finish-setup');
    else {
        if (!acknowledged) out.push('recording-notice');
        if (server && !signedIn) out.push('sign-in');
    }
    if (signedIn) out.push('sign-out');
    return out;
}

// The recording time in the menu bar title (Jon's call 8): "3:52", "1:02:03".
function formatElapsed(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Launch at login is on by default (Jon's call 6), set once: the first time this
// app runs from Applications with setup finished. login-item.json records that it
// was set, so turning it off in the tray stays off. Never from anywhere else:
// launch at login needs a path that stays put.
function loginItemPath(supportDir) {
    return path.join(supportDir, 'login-item.json');
}

function loginDefaultApplied(supportDir) {
    return readStamp(loginItemPath(supportDir), 'default_applied_at');
}

function recordLoginDefaultApplied(supportDir, now = new Date()) {
    return writeOnce(loginItemPath(supportDir), 'default_applied_at', now);
}

function shouldApplyLoginDefault({ inApplications, setupCompleted, defaultApplied }) {
    return !!inApplications && !!setupCompleted && !defaultApplied;
}

// The offer to move to Applications: only for the built app, and only when it is
// running from anywhere else (straight from the .dmg, or translocated). A run
// from a checkout is development, not an install.
//
// Not when the installed copy is this build or a newer one: Electron's move
// replaces a same-named app in Applications, so a stale copy started from a
// worktree or a backup would put itself in place of the one installed. An older
// installed copy keeps the offer, since a newer .dmg is how an update arrives
// until there is auto-update, and so does one whose build-info can't be read.
function shouldOfferMove({ bundled, inApplications, running = null, installed = null }) {
    return !!bundled && !inApplications && !installedIsSameOrNewer(running, installed);
}

// Same commit, or a later built_at. Either side missing reads as not same-or-newer, so the offer stays.
function installedIsSameOrNewer(running, installed) {
    if (!running || !installed) return false;
    if (installed.commit && installed.commit === running.commit) return true;
    const a = Date.parse(installed.built_at);
    const b = Date.parse(running.built_at);
    return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

// Why a built app can't update itself where it runs, or null when it can
// (SAA-253 decision 6). Squirrel replaces the bundle in place, so it needs the
// installed copy in Applications and a folder this account can write to. A
// translocated app runs from a read-only copy, whatever Applications says. A run
// from a checkout is development and is not asked.
function updateBlocker({ bundled, inApplications, appPath, parentWritable }) {
    if (!bundled) return null;
    if (appPath.includes('/AppTranslocation/')) return 'translocated';
    if (!inApplications) return 'outside-applications';
    if (!parentWritable) return 'not-writable';
    return null;
}

// What a built app running from outside Applications says about it: a tray line
// and a notification, both naming the path (~ for the home folder), and that it
// can't update itself there. In Applications but in a folder this account can't
// write to, a warning that it stays on this build. Null otherwise, and for a run
// from a checkout.
function locationWarning({ bundled, inApplications, appPath, home, parentWritable = true }) {
    const blocker = updateBlocker({ bundled, inApplications, appPath, parentWritable });
    if (!blocker) return null;
    const shown = home && appPath.startsWith(home + '/') ? '~' + appPath.slice(home.length) : appPath;
    if (blocker === 'not-writable') {
        return {
            tray: `Can't update itself: this account can't replace ${shown}`,
            title: "Clipwise can't update itself",
            body: `${shown}\nIt keeps recording, but this account can't replace it, so it stays on this build.`,
        };
    }
    return {
        tray: `Not the installed app: running from ${shown}`,
        title: 'Clipwise is running from outside Applications',
        body: `${shown}\nIt keeps recording, but it may be an old build, and it can't update itself here.`,
    };
}

module.exports = {
    SCREENS,
    setupPath, isSetupCompleted, recordSetupCompleted,
    permissionSettled, firstIncompleteScreen, settleSetup,
    normalizeTeamAddress, isClipwiseDiscovery, claudeAddress,
    trayAccountItems, formatElapsed,
    loginItemPath, loginDefaultApplied, recordLoginDefaultApplied, shouldApplyLoginDefault,
    shouldOfferMove, updateBlocker, locationWarning,
};
