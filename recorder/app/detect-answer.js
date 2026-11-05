// Whether an answer to the "Record calls from this app?" prompt starts a
// capture, and which trigger app that capture carries (SAA-269). Moved out of
// main.js's answerDetectPrompt unchanged, so it runs without Electron:
// check-detect-answer.js drives it, and runs each start it returns through
// autostop.step.
//
// choice is 'record', 'not_now' or 'never'. live is whether the prompt was
// still up when the answer came; holding is whether the app is still using the
// microphone. Only 'record' can start anything: at once while the prompt is
// live, and late only while the app still holds the mic (the call is still
// going). Late with the mic released, the call is over and nothing starts.
//
// The trigger is what main.js hands startRecording as pendingStartTrigger.
// main.js writes the "record" decision, sends the late-start and nothing-
// recorded notifications, and starts the capture.

'use strict';

function startForAnswer({ choice, live, holding, key, name }) {
    if (choice !== 'record') return { start: false, trigger: null };
    if (live) return { start: true, trigger: null };
    if (holding) return { start: true, trigger: null };
    return { start: false, trigger: null };
}

module.exports = { startForAnswer };
