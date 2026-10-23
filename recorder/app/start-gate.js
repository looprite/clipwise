// The audio permissions at the start of a capture (SAA-124). A grant nobody has
// answered yet makes the start wait for the answer on the setup window's
// permissions screen, instead of starting and running into the 9 s start
// timeout while macOS's prompt is up. main.js carries out what these decide.

// How long a turned-away start is kept for agreeing or answering to carry out.
const BLOCKED_START_TTL_MS = 10 * 60 * 1000;

// The answers audiodevs can give that are statements about this app's grant.
const KNOWN = new Set(['granted', 'denied', 'notDetermined']);

// mic, tap: as audiodevs reports them. ->
//   'refuse'   either is denied: the capture is refused, as before.
//   'fallback' the system audio grant could not be read (unavailable, an
//              unexpected value): start without this gate, as before it existed.
//              A private API that vanished must never stop every capture.
//   'block'    either has not been answered: wait for the answers.
//   'start'    anything else.
function permissionGate(mic, tap) {
    if (mic === 'denied' || tap === 'denied') return 'refuse';
    if (!KNOWN.has(tap)) return 'fallback';
    if (mic === 'notDetermined' || tap === 'notDetermined') return 'block';
    return 'start';
}

// What to do with a start the gate turned away, now that the grants read
// mic/tap. holdsMic(key) says whether the triggering app still holds the
// microphone, as for the recording notice. ->
//   'none'        nothing is waiting: no start, one turned away for the notice,
//                 or one older than BLOCKED_START_TTL_MS.
//   'wait'        the system audio prompt's child is still running (a capture
//                 must not start beside it), or a grant is still unanswered.
//   'drop-denied' a grant was denied: the start is dropped.
//   'call-ended'  the app that started it no longer holds the microphone.
//   'start'       start it now.
function resumeAfterPermissions(blocked, mic, tap, holdsMic, { promptRunning = false, now = Date.now() } = {}) {
    if (!blocked || blocked.reason !== 'permissions' || now - blocked.at > BLOCKED_START_TTL_MS) return 'none';
    if (promptRunning) return 'wait';
    if (mic === 'denied' || tap === 'denied') return 'drop-denied';
    if (mic === 'notDetermined' || tap === 'notDetermined') return 'wait';
    const trigger = blocked.trigger;
    if (trigger && trigger.key && !holdsMic(trigger.key)) return 'call-ended';
    return 'start';
}

// The setup window a blocked start opened at the permissions screen, once the
// grants read mic/tap. finishedBefore: setup had been finished before the
// window opened. ->
//   'stay'     a grant is still unanswered.
//   'close'    both answered, setup finished before: the window ends here, and
//              no step the member already did is shown again.
//   'continue' both answered, setup not finished: it goes on to its next
//              unfinished screen.
function permissionsWindowNext(finishedBefore, mic, tap) {
    if (mic === 'notDetermined' || tap === 'notDetermined') return 'stay';
    return finishedBefore ? 'close' : 'continue';
}

module.exports = { BLOCKED_START_TTL_MS, permissionGate, resumeAfterPermissions, permissionsWindowNext };
