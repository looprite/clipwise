// The menu bar menu's order and its one status line (SAA-281). main.js's
// renderTray turns each key into its Electron item; this file only decides which
// keys there are and in what order, so the order can be checked without Electron
// (check-consent.js), like setup.js's trayAccountItems.
//
// Order, groups separated by dividers ('-'):
//   status, then any action notes and prompts right under it
//   Start or Stop recording, and "Copy recording notice" while recording
//   Recent meetings, Recognize voices (Save transcript is in Recent meetings)
//   Detected applications, Open at login
//   the account items (setup.js trayAccountItems): Read the recording notice,
//     Who accepted the notice (admins only), Sign out; before setup or sign-in
//     is done, Finish setting up, Recording notice or Sign in in their place
//   About, Acknowledgements, Quit
//
// Split out of main.js, like setup.js and team-notice.js, so no Electron is
// needed to check it.

'use strict';

// The notes, one line each, right under the status line with no divider.
const NOTE_KEYS = ['allow-audio', 'location-note', 'update', 'pipeline-note', 'permission-note'];
// The prompts, each its own group under the notes, each after a divider.
const PROMPT_KEYS = ['detect-prompt', 'permission-fixes', 'retry-pipeline', 'pending-identity', 'voice-naming', 'fix-speaker-names'];

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
    out.push('-', 'detected-apps', 'open-at-login');
    const account = Array.isArray(s.accountItems) ? s.accountItems : [];
    if (account.length) out.push('-', ...account);
    out.push('-', 'about', 'acknowledgements', 'quit');
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

module.exports = { trayMenuOrder, startStopLabel, trayStatusLine, dayAndTime, localDateChanged, NOTE_KEYS, PROMPT_KEYS };
