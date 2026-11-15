// The small Clipwise panel that asks the first-call question, carries the
// "signed out" notice (SAA-291) and the "Recording — let everyone know" notice
// when a capture starts (SAA-299). No Electron here, so check-prompt-panel.js
// can read it directly: what each panel says, which answers each panel accepts,
// how big it is, where on a display it sits, and when the recording notice
// opens and closes. main.js makes the window (showPromptPanel) and does what an
// answer means.
//
// Why a panel and not a notification: Architecture Decision 17 (2026-08-30
// amendment). Whether a notification was shown can't be seen from inside the
// app, and with Clipwise's notifications switched off the question never
// appeared and the call was not recorded (SAA-291, 11-13). A window of the
// app's own does not depend on that setting.

'use strict';

const consent = require('./consent.js');

// Each kind's answers, in the order the page lays them out, and the one that
// is styled as the main button. Fixed words: they are what the log may say.
const KINDS = {
    // Same three answers as the notification had (SAA-113, 2026-08-30). "Always
    // record" and "Never ask about this app" each write a rule for the app;
    // "Not now" writes nothing, and is also what an expired prompt means.
    'detect-prompt': {
        answers: ['never', 'not_now', 'record'],
        primary: 'record',
    },
    // "Later" closes it for this session; the tray's "Sign in to Clipwise…" is
    // the way back. No expiry and no re-show on a timer (SAA-291, 11-14).
    'signed-out': {
        answers: ['later', 'sign_in'],
        primary: 'sign_in',
    },
    // The line to say aloud when a capture starts (SAA-216), moved here from a
    // notification (SAA-299, 11-15). One button. It closes on OK or when the
    // recording stops (noticeStep), never on a timer: a panel that closes on
    // its own brings back the problem it exists for, that nobody can tell
    // whether it was seen.
    'recording-notice': {
        answers: ['ok'],
        primary: 'ok',
    },
};

const LABELS = {
    record: 'Always record',
    not_now: 'Not now',
    never: 'Never ask about this app',
    sign_in: 'Sign in…',
    later: 'Later',
    ok: 'OK',
};

// The panel's content box, in points. Two short lines and one row of buttons.
const PANEL_SIZE = { width: 380, height: 112 };
// The recording notice's body is the whole notice line, which wraps to more
// than one line at this width; check-prompt-panel.js measures that it fits.
// 130: one body line more than the other panels (17.55 at 13px/1.35 on 112),
// rounded up, so the space above the buttons stays theirs (SAA-299, measured).
const NOTICE_PANEL_SIZE = { width: 380, height: 130 };

function panelSize(kind) {
    return kind === 'recording-notice' ? NOTICE_PANEL_SIZE : PANEL_SIZE;
}

// Distance from the display's top-right corner, roughly where a notification
// banner sits.
const PANEL_INSET = 16;

function isKind(kind) {
    return Object.prototype.hasOwnProperty.call(KINDS, kind);
}

function isAnswer(kind, choice) {
    return isKind(kind) && typeof choice === 'string' && KINDS[kind].answers.includes(choice);
}

// What the page draws: { kind, title, body, buttons: [{ choice, label, primary }] }.
// appName is the name a person reads (main.js displayNameForDetectedKey); it
// goes to the page only, never to the log.
function panelView(kind, { appName } = {}) {
    if (!isKind(kind)) return null;
    const buttons = KINDS[kind].answers.map((choice) => ({
        choice, label: LABELS[choice], primary: choice === KINDS[kind].primary,
    }));
    if (kind === 'detect-prompt') {
        return {
            kind,
            title: `${appName || 'An app'} is using the microphone`,
            body: 'Record calls from this app?',
            buttons,
        };
    }
    if (kind === 'recording-notice') {
        // The body is the same line "Copy recording notice" puts on the
        // clipboard.
        return {
            kind,
            title: 'Recording \u2014 let everyone know',
            body: consent.NOTICE_LINE,
            buttons,
        };
    }
    return {
        kind,
        title: 'Clipwise is signed out',
        body: 'Recordings are kept and will upload after you sign in.',
        buttons,
    };
}

// Top-right of a display's work area (without the menu bar and Dock), inset.
// workArea is Electron's { x, y, width, height } for the display under the
// cursor; the panel goes there because Electron can't tell which display the
// call is on.
function panelPosition(workArea, size = PANEL_SIZE, inset = PANEL_INSET) {
    return {
        x: Math.round(workArea.x + workArea.width - size.width - inset),
        y: Math.round(workArea.y + inset),
    };
}

// Why a panel closed, as the log may say it. An answer, the prompt's expiry,
// another panel taking its place, a sign-in finishing elsewhere, the recording
// stopping (the recording notice), or the window going for any other reason
// (closed).
function closeReasons() {
    const out = [];
    for (const kind of Object.keys(KINDS)) for (const a of KINDS[kind].answers) out.push(`answer ${a}`);
    return [...new Set(out), 'expiry', 'replaced', 'signed-in', 'stopped', 'closed'];
}

// What a capture's state change means for the recording notice (SAA-299):
// 'show' when both tracks start writing (starting -> recording, the move that
// used to raise the "Recording — let everyone know" notification, so the same
// starts show it), 'close' on any stop, and null otherwise. A stalled capture
// that resumes (stalled -> recording) shows nothing: one notice per capture.
function noticeStep(prev, next) {
    if (prev === 'starting' && next === 'recording') return 'show';
    if (next === 'stopped') return 'close';
    return null;
}

module.exports = { KINDS, LABELS, PANEL_SIZE, NOTICE_PANEL_SIZE, PANEL_INSET, isKind, isAnswer, panelView, panelSize,
    panelPosition, closeReasons, noticeStep };
