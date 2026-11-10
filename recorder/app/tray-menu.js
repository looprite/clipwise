// The menu bar menu's order and its one status line (SAA-281). main.js's
// renderTray turns each key into its Electron item; this file only decides which
// keys there are and in what order, so the order can be checked without Electron
// (check-consent.js), like setup.js's trayAccountItems.
//
// Order, groups separated by dividers ('-'):
//   status, then any action notes and prompts right under it
//   Start or Stop recording, and "Copy recording notice" while recording
//   Recent meetings, Save transcript, Recognize voices
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
// capture is starting, running or stalled), hasMeeting (Save transcript has a
// meeting to save), accountItems (setup.js trayAccountItems, in its order).
function trayMenuOrder(s) {
    const out = ['status'];
    for (const k of NOTE_KEYS) if (s[k]) out.push(k);
    for (const k of PROMPT_KEYS) if (s[k]) out.push('-', k);
    out.push('-', 'start-stop');
    if (s.active) out.push('copy-notice');
    out.push('-', 'recent-meetings');
    if (s.hasMeeting) out.push('save-transcript');
    out.push('recognize-voices');
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
// (the newest upload-queue entry, or null). time(ms) is the Mac's local time
// format, e.g. "9:00 AM"; stemTimeMs(stem) is when a capture started.
function trayStatusLine(s, time, stemTimeMs) {
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
    if (u.jobState === 'done') return `Stopped · last call ready ${time(stemTimeMs(u.stem))}`;
    if (u.jobState === 'failed') return 'Stopped · last call failed to process — see Recent meetings';
    if (u.jobState === 'none') return 'Stopped · last call uploaded';
    if (u.jobState === 'gone') return 'Stopped · last call no longer on the server';
    if (u.jobState === 'stale') return 'Stopped · last call status unknown';
    return 'Stopped · last call processing';
}

module.exports = { trayMenuOrder, startStopLabel, trayStatusLine, NOTE_KEYS, PROMPT_KEYS };
