// Whether an answer to the "Record calls from this app?" prompt starts a
// capture, and which trigger app that capture carries (SAA-269). Moved out of
// main.js's answerDetectPrompt unchanged, so it runs without Electron:
// check-detect-answer.js drives it, and runs each start it returns through
// autostop.step.
//
// choice is 'record', 'not_now' or 'never'. live is whether the prompt was
// still up when the answer came; holding is whether the app is still using the
// microphone. Only 'record' can start anything, and only while the app still
// holds the mic: the call is still going. That holds whether the prompt is
// live or has lapsed. With the mic released the call is over, and nothing
// starts; the "record" decision main.js has already saved means the app's next
// use of the mic starts a capture through the allowed-app path
// (handleDetectEvent), with its trigger.
//
// The trigger is what main.js hands startRecording as pendingStartTrigger.
// main.js writes the "record" decision, sends the late-start and nothing-
// recorded notifications, and starts the capture.
//
// A start carries the app that asked as its trigger, as the allowed-app path
// does: auto-stop watches it, and its scope is inferred. Before SAA-269 a
// prompt-started capture had no trigger, so it was a manual start that never
// auto-stopped. That this is what happened on a new Mac's first FaceTime call
// (trigger_app null, stop_cause manual, recording on until a manual stop) is
// inferred from its metadata and the code, not proven from its logs.
//
// A live prompt with the mic already released would otherwise start a capture
// whose trigger has nothing left to release: autostopBegin reads no pids, and
// it could never auto-stop.

'use strict';

function startForAnswer({ choice, live, holding, key, name }) {
    if (choice !== 'record') return { start: false, trigger: null };
    if (holding) return { start: true, trigger: { key, name } };
    return { start: false, trigger: null };
}

module.exports = { startForAnswer };
