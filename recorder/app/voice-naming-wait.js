// Step 2's stop conditions (SAA-195, 2026-09-25 fix), pulled out of main.js
// so this decision can be exercised directly against fixture data — no
// Electron, no window, no timer — rather than only through the live poll.
//
// Reads exactly two facts off the pipeline record (pipeline-<stem>.json, as
// the direct pipeline wrote it before the cut-over): steps.diarize.state and, only when that is
// "skipped", steps.diarize.detail.model_revision, plus steps.transcribe.state
// and steps.ingest.state. No text parsing of any `reason` string anywhere
// here.
//
// steps.diarize.state is "skipped" for every non-split outcome alike, benign
// or not (the direct pipeline's diarize step used that one state either way).
// model_revision is what tells them apart: it is only ever non-null when the
// diarize tool actually ran and produced a real sidecar — the two-party gate
// and the identity-already-named skip both pass it through from that real
// result. Every other skip (Apple Silicon, a missing binary or audio file, a
// timeout, a tool error) left it null.
//
// A capture-pipeline record (`pipeline: "capture"`, capture-cli.ts, SAA-227) has
// no ingest step and no model_revision. Its diarize step is "ok" whenever the
// tool ran, with detail.voices_found, and "skipped" only when it could not run.
// The caller has already looked for naming data, so "ok" here means none was
// written: one voice or none is the one-voice message, anything else (the
// `them` track excluded, or naming data that failed to build) is the
// couldn't-separate one. A classifier refusal stops the pipeline before
// diarize. Everything else falls through to the rules below.
function stopMessageFor(sidecar) {
    const diarizeStep = sidecar && sidecar.steps && sidecar.steps.diarize;
    const transcribeState = sidecar && sidecar.steps && sidecar.steps.transcribe && sidecar.steps.transcribe.state;
    const ingestState = sidecar && sidecar.steps && sidecar.steps.ingest && sidecar.steps.ingest.state;

    if (sidecar && sidecar.pipeline === 'capture') {
        const classifyState = sidecar.steps && sidecar.steps.classify && sidecar.steps.classify.state;
        if (classifyState === 'failed') return "Couldn't separate the voices on this call.";
        if (diarizeStep && diarizeStep.state === 'ok') {
            const voicesFound = diarizeStep.detail && diarizeStep.detail.voices_found;
            return typeof voicesFound === 'number' && voicesFound <= 1
                ? 'Only one other voice on this call — nothing to name.'
                : "Couldn't separate the voices on this call.";
        }
        if (diarizeStep && diarizeStep.state === 'skipped') return "Couldn't separate the voices on this call.";
    }

    if (diarizeStep && diarizeStep.state === 'skipped') {
        const modelRevision = diarizeStep.detail && diarizeStep.detail.model_revision;
        return modelRevision != null
            ? 'Only one other voice on this call — nothing to name.'
            : "Couldn't separate the voices on this call.";
    }
    if ((!diarizeStep || diarizeStep.state === 'pending')
        && (transcribeState === 'failed' || ingestState === 'failed')) {
        // The pipeline died before ever reaching diarize.
        return "Couldn't separate the voices on this call.";
    }
    return null;
}

module.exports = { stopMessageFor };
