// The body of POST /captures (server/src/routes/captures.ts captureSchema), from
// the capture's files on disk: the transcript, the manifest, the classification
// the pipeline recorded, the identity answer and the voice names when there are
// any, and the voices diarize found. Throws when a file it needs is missing or
// unreadable; the thrown error names the file, never what is in it.
//
// Moved out of main.js unchanged (SAA-260 step 3), so a plain-node check can
// build the body from a fixture folder and show that nothing from the voice
// prints on this Mac (voice-prints.js) ever reaches it: the body is built from
// the recordings folder's capture files only, and from diarize's file it takes
// each voice's index and total seconds, never its embedding.

const fs = require('fs');
const path = require('path');
const { assignVoice } = require('./identity-answer.js');

function buildCapturePayload(outdir, stem) {
    const readJson = (name) => {
        try {
            return JSON.parse(fs.readFileSync(path.join(outdir, name), 'utf8'));
        } catch (err) {
            const e = new Error(`${name}: ${err.code || err.name}`);
            e.code = err.code || err.name;
            throw e;
        }
    };
    const transcript = readJson(`transcript-${stem}.json`);
    const manifest = readJson(`manifest-${stem}.json`);
    const sidecar = readJson(`pipeline-${stem}.json`);
    // The direct pipeline records it at ingest; the database-free one
    // (capture-cli.ts) at its own classify step.
    const stepDetail = (name) => (sidecar.steps && sidecar.steps[name] && sidecar.steps[name].detail) || null;
    const classification = (stepDetail('ingest') || stepDetail('classify') || {}).classification || null;
    if (!classification) throw new Error(`pipeline-${stem}.json: no classification at ingest or classify`);
    // Direct ingest stores a missing model as null (ingest/clipwise.ts:438); the
    // endpoint takes only a string, so there is no faithful default to send.
    if (typeof transcript.model !== 'string') throw new Error(`transcript-${stem}.json: no model`);
    let identity;
    try {
        identity = readJson(`identity-${stem}.json`);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    // The prompt writes self.source: null when no name was given
    // (identity-answer.js:138-141); the endpoint takes a string or nothing.
    if (identity && identity.self && identity.self.source === null) delete identity.self.source;
    let voiceNames;
    try {
        voiceNames = readJson(`voice-names-${stem}.json`);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    // Names typed at the prompt for invitees the calendar could not name
    // (SAA-221), from their own file: never part of identity.
    let inviteeNames;
    try {
        inviteeNames = readJson(`invitee-names-${stem}.json`).invitees;
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    // What diarize produced (SAA-227 decisions 1 and 4): each voice's index and
    // total seconds, and each `them` segment's voice by the majority rule. The
    // server decides whether that is a split. Its turn times, clip ranges and
    // embeddings stay here. No sidecar, an unreadable one or one that reports an
    // error means no voice data, as diarize.ts treats it: the capture still goes.
    let diarized = null;
    try {
        const doc = readJson(`diarize-${stem}.json`);
        if (!doc.error && Array.isArray(doc.voices) && Array.isArray(doc.segments)) diarized = doc;
    } catch {}
    const segments = transcript.segments.map((s) => {
        const seg = { track: s.track, startMs: s.start_ms, endMs: s.end_ms, text: s.text };
        if (diarized && s.track === 'them') {
            const voiceIndex = assignVoice(s.start_ms / 1000, s.end_ms / 1000, diarized.segments);
            if (voiceIndex !== null) seg.voiceIndex = voiceIndex;
        }
        return seg;
    });
    return {
        // Verbatim: manifest ids are uppercase, as are the rows filed under
        // them before the cut-over.
        captureId: manifest.recording_id,
        startedAt: manifest.started_at,
        stem,
        engine: transcript.engine || 'whisper.cpp',
        model: transcript.model,
        segments,
        // Counted off the transcript's own segments (SAA-78), not off the
        // array above that is about to be sent.
        sourceFidelity: {
            declaredTurnCount: transcript.segments.length,
            declaredBodyChars: transcript.segments.reduce((n, s) => n + s.text.length, 0),
            countedFrom: `transcript-${stem}.json segments[].text`,
        },
        classification: {
            verdict: classification.verdict,
            concern: classification.concern,
            reason: classification.reason,
            excludedLabels: classification.excludedLabels,
            tracks: classification.tracks,
            thresholds: classification.thresholds,
        },
        capture: {
            tracks: manifest.tracks,
            permissions: manifest.permissions || {},
            triggerApp: manifest.trigger_app || null,
        },
        // The acknowledgement the capture started under, from its manifest; a
        // manifest from before part I has none, and none is sent.
        notice: manifest.notice
            ? { version: manifest.notice.version, acknowledgedAt: manifest.notice.acknowledged_at }
            : undefined,
        content: transcript.content,
        aec: transcript.aec,
        autostop: transcript.autostop,
        identity,
        voiceNames,
        inviteeNames: Array.isArray(inviteeNames) && inviteeNames.length ? inviteeNames : undefined,
        voices: diarized ? diarized.voices.map((v) => ({ voiceIndex: v.voiceIndex, totalSeconds: v.totalSeconds })) : undefined,
    };
}

module.exports = { buildCapturePayload };
