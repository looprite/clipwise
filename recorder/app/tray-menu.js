// The menu bar menu's order and its one status line (SAA-281). main.js's
// renderTray turns each key into its Electron item; this file only decides which
// keys there are and in what order, so the order can be checked without Electron
// (check-consent.js), like setup.js's trayAccountItems.
//
// Order, groups separated by dividers ('-'), as revised 2026-11-10 (SAA-281):
//   status, then any action notes and prompts right under it
//   Start or Stop recording, and "Copy recording notice" while recording
//   Recent meetings, Recognize voices (Save transcript is in Recent meetings)
//   Detected applications, then the notice items of setup.js trayAccountItems:
//     Read the recording notice, Who accepted the notice (admins only); before
//     setup or the notice is done, Finish setting up or Recording notice in
//     their place
//   About (its message box opens the acknowledgements), Open at login, Sign out
//     (Sign in in its place while signed out), Quit
//
// Split out of main.js, like setup.js and team-notice.js, so no Electron is
// needed to check it.

'use strict';

// The notes, one line each, right under the status line with no divider.
const NOTE_KEYS = ['allow-audio', 'location-note', 'update', 'pipeline-note', 'permission-note'];
// The prompts, each its own group under the notes, each after a divider.
const PROMPT_KEYS = ['detect-prompt', 'permission-fixes', 'retry-pipeline', 'pending-identity', 'voice-naming', 'fix-speaker-names'];
// The account items that go in the last group, between Open at login and Quit;
// the rest of trayAccountItems (the notice items) go after Detected applications.
const SESSION_KEYS = ['sign-in', 'sign-out'];

// s: which notes and prompts are showing (booleans named by key), active (a
// capture is starting, running or stalled), accountItems (setup.js
// trayAccountItems, in its order).
function trayMenuOrder(s) {
    const out = ['status'];
    for (const k of NOTE_KEYS) if (s[k]) out.push(k);
    for (const k of PROMPT_KEYS) if (s[k]) out.push('-', k);
    out.push('-', 'start-stop');
    if (s.active) out.push('copy-notice');
    out.push('-', 'recent-meetings', 'recognize-voices');
    const account = Array.isArray(s.accountItems) ? s.accountItems : [];
    out.push('-', 'detected-apps', ...account.filter((k) => !SESSION_KEYS.includes(k)));
    out.push('-', 'about', 'open-at-login', ...account.filter((k) => SESSION_KEYS.includes(k)), 'quit');
    return out;
}

// The one item that starts or stops a capture: its label.
function startStopLabel(active) {
    return active ? 'Stop recording' : 'Start recording';
}

// The one status line, in place of "Status: …" and the three upload lines.
// s: state (stopped, starting, recording, stalled), startedAtMs (when this
// capture started), pipeline (the Mac's processing of the last call: null,
// 'running' or 'failed'), server (a team address is set), signedIn, lastUpload
// (the newest upload-queue entry, or null), nowMs (now; without it the last
// call's time is shown alone). time(ms) is the Mac's local time format, e.g.
// "9:00 AM"; stemTimeMs(stem) is when a capture started; day is the Mac's
// local { weekday(ms), date(ms) } formats, e.g. "Mon" and "Nov 3", for
// dayAndTime.
function trayStatusLine(s, time, stemTimeMs, day) {
    if (s.state === 'starting') return 'Starting recording…';
    if (s.state === 'recording') return `Recording · started ${time(s.startedAtMs)}`;
    if (s.state === 'stalled') return `Recording · stalled — started ${time(s.startedAtMs)}`;
    if (s.pipeline === 'failed') return 'Stopped · last call failed to process — see Retry below';
    if (s.pipeline === 'running') return 'Stopped · last call processing';
    if (!s.server) return 'Stopped';
    if (!s.signedIn) return 'Stopped · not signed in';
    const u = s.lastUpload;
    if (!u) return 'Stopped';
    if (u.state === 'queued') return u.attempts > 0 ? 'Stopped · last call retrying upload' : 'Stopped · last call processing';
    if (u.state === 'failed') return "Stopped · last call didn't upload — see Recent meetings";
    if (u.jobState === 'done') return `Stopped · last call ready ${dayAndTime(stemTimeMs(u.stem), s.nowMs, time, day)}`;
    if (u.jobState === 'failed') return 'Stopped · last call failed to process — see Recent meetings';
    if (u.jobState === 'none') return 'Stopped · last call uploaded';
    if (u.jobState === 'gone') return 'Stopped · last call no longer on the server';
    if (u.jobState === 'stale') return 'Stopped · last call status unknown';
    return 'Stopped · last call processing';
}

// When a call was, by the Mac's local calendar (SAA-285): the time alone on
// the day of nowMs, "Mon 4:00 PM" from 1 to 6 days before it, and
// "Nov 3 4:00 PM" from 7 days before it. A time later than nowMs, or no
// nowMs, is the time alone.
function dayAndTime(ms, nowMs, time, day) {
    if (!Number.isFinite(nowMs) || !day) return time(ms);
    const midnight = (x) => { const d = new Date(x); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
    // Rounded: a day across a clock change is 23 or 25 hours long.
    const daysAgo = Math.round((midnight(nowMs) - midnight(ms)) / 86400000);
    if (!(daysAgo >= 1)) return time(ms);
    return `${daysAgo < 7 ? day.weekday(ms) : day.date(ms)} ${time(ms)}`;
}

// Whether the Mac's local date at nowMs differs from the one at drawnMs, the
// last time the menu was drawn: main.js redraws on true, so the status line's
// day (dayAndTime) is right after midnight. False with no draw yet.
function localDateChanged(drawnMs, nowMs) {
    if (!Number.isFinite(drawnMs) || !Number.isFinite(nowMs)) return false;
    const a = new Date(drawnMs);
    const b = new Date(nowMs);
    return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
}

// "About Clipwise" (SAA-281): a message box with the name and version, and the
// acknowledgements one button away, since the macOS About panel's text can't
// hold a link. OK is the default; main.js opens the acknowledgements on
// response 0. commit is build-info.json's, which build-app.sh writes into
// every bundle it builds; it is null only when there is no build-info.json,
// that is, when the app runs from source. The commit itself is not shown:
// jargon for members, and each version is one build (SAA-281, 11-11). A run
// from source adds a line saying so.
function aboutDialog({ version, commit }) {
    return {
        buttons: ['Acknowledgements…', 'OK'], defaultId: 1, cancelId: 1,
        message: 'Clipwise',
        detail: commit ? `Version ${version}` : `Version ${version}\nRun from a checkout, not a built app`,
    };
}

// The item for a call whose "Who was on this call?" was left unanswered
// (SAA-284): its start time by the Mac's local calendar (dayAndTime), and its
// title once the server's calendar match is on disk, so calls on the same day
// read differently. A long title is cut, and the item's own "…" marks the cut.
const PENDING_TITLE_MAX = 40;
function pendingIdentityLabel({ startedAtMs, title, autoStopped, nowMs }, time, day) {
    const call = Number.isFinite(startedAtMs) ? `the ${dayAndTime(startedAtMs, nowMs, time, day)} call` : 'this call';
    const t = typeof title === 'string' ? title.trim().replace(/\s+/g, ' ') : '';
    const named = t ? ` — ${t.length > PENDING_TITLE_MAX ? t.slice(0, PENDING_TITLE_MAX - 1).trimEnd() : t}` : '';
    return `Who was on ${call}${named}…${autoStopped ? ' (auto-stopped)' : ''}`;
}

// The permission finding as the menu shows it (SAA-271 edges 1 and 2). issue is
// main.js's permissionIssue: { denied, note, dismissed }. Dismiss warning takes
// away the ⚠, the note line and itself, never the "Open … settings…" items: they
// stay until a start gets past the permission gate. -> { note, open, dismiss,
// attention }.
function permissionView(issue) {
    if (!issue) return { note: null, open: [], dismiss: false, attention: false };
    const dismissed = !!issue.dismissed;
    return {
        note: dismissed ? null : issue.note || null,
        open: Array.isArray(issue.denied) ? issue.denied.slice() : [],
        dismiss: !dismissed,
        attention: !dismissed,
    };
}

module.exports = { trayMenuOrder, startStopLabel, trayStatusLine, dayAndTime, localDateChanged, aboutDialog, pendingIdentityLabel, permissionView, NOTE_KEYS, PROMPT_KEYS };
