'use strict';

// What state a capture is in, and which meeting the tray's "Save transcript"
// item acts on (SAA-199). The recent-meetings window (SAA-217) lists captures
// by the same classification, so the two never disagree about what counts as
// a meeting. Read from the files the pipeline leaves beside the recordings,
// because main.js has no database access.
//
// States (classifyCapture), for a capture the direct pipeline handled before the
// cut-over (SAA-227):
//   ready     ingested (the pipeline record has a db_recording_id and the
//             ingest step is ok, or skipped because an earlier run already
//             did it), the transcript has at least one line, and diarize has
//             finished (ok, skipped or failed) or never was a step
//   nospeech  nothing to save: the transcript has no lines, or nothing was
//             transcribed at all
//   failed    the pipeline failed (or was abandoned) before it finished
//   pending   still recording or still being processed
//
// Every capture since the cut-over is handled by the capture pipeline
// (capture-cli.ts) and is ready by its server jobs instead; see
// classifyServerCapture.
//
// lastMeeting picks the newest capture that is ready. A newer capture with no
// speech or a failed pipeline is skipped. The newest capture still pending is
// reported as pending, not skipped: showing the previous meeting while a newer
// one is moments from ready would offer the wrong one. A capture that is
// neither finished nor recently active (a crashed pipeline) is not waited for.

const fs = require('fs');
const path = require('path');

const PENDING_WITHOUT_PIPELINE_MS = 6 * 60 * 60 * 1000; // a long call can still be recording
const PENDING_WITH_PIPELINE_MS = 30 * 60 * 1000;

const lineCountCache = new Map(); // transcript path -> { mtimeMs, count }

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function transcriptLineCount(file) {
    let mtimeMs;
    try {
        mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
        return null;
    }
    const hit = lineCountCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.count;
    const doc = readJson(file);
    const count = doc && Array.isArray(doc.segments) ? doc.segments.length : null;
    lineCountCache.set(file, { mtimeMs, count });
    return count;
}

function stemTimeMs(stem) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(stem || '');
    if (!m) return NaN;
    return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

// The meeting's title: the calendar event it was matched to. Null when there
// was no match; the caller shows "Untitled".
function calendarTitle(dir, stem) {
    const doc = readJson(path.join(dir, `calendar-match-${stem}.json`));
    return doc && typeof doc.title === 'string' && doc.title.trim() ? doc.title.trim() : null;
}

// A capture the capture pipeline (capture-cli.ts, SAA-227) handled:
// what this Mac does ends at the upload, and the rest is the server's. Ready once
// the capture was sent and its server jobs are done, as its upload-queue entry
// records them (main.js pollJobStates); the recording id is the server's.
// Failed when the server refused it, or its jobs failed, are gone, or went
// unconfirmed past the polling limit ("stale"), or there were none. Pending while
// it waits to be sent or its jobs run. With no entry, it is pending only while
// its pipeline was recently active, like a pre-cutover capture.
const SERVER_CAPTURE_FAILED_JOBS = new Set(['failed', 'gone', 'stale', 'none']);

function classifyServerCapture(dir, stem, pipeline, title, now, uploadQueueDir) {
    const steps = pipeline.steps || {};
    const updatedMs = Date.parse(pipeline.updated_at || '');
    const recentlyActive = Number.isFinite(updatedMs) && now - updatedMs < PENDING_WITH_PIPELINE_MS;
    // The classifier refused the capture: a second run refuses it again.
    if (steps.classify && steps.classify.state === 'failed') return { state: 'failed', stem, title };
    const settled = Object.values(steps).every((s) => s && (s.state === 'ok' || s.state === 'skipped'));
    if (!settled) return { state: recentlyActive ? 'pending' : 'failed', stem, title };
    const lines = transcriptLineCount(path.join(dir, `transcript-${stem}.json`));
    if (!(lines && lines > 0)) return { state: 'nospeech', stem, title };
    const entry = uploadQueueDir ? readJson(path.join(uploadQueueDir, `${stem}.json`)) : null;
    if (!entry) return { state: recentlyActive ? 'pending' : 'failed', stem, title };
    if (entry.state === 'sent' && entry.jobState === 'done' && entry.recordingId) {
        return { state: 'ready', stem, title, recordingId: entry.recordingId };
    }
    if (entry.state === 'failed') return { state: 'failed', stem, title };
    if (entry.state === 'sent' && SERVER_CAPTURE_FAILED_JOBS.has(entry.jobState)) return { state: 'failed', stem, title };
    return { state: 'pending', stem, title };
}

// -> { state, stem, title, recordingId? }. `opts.uploadQueueDir` is where the
// upload queue's entries are, for captures the capture pipeline handled.
function classifyCapture(dir, stem, now = Date.now(), opts = {}) {
    const title = calendarTitle(dir, stem);
    const pipeline = readJson(path.join(dir, `pipeline-${stem}.json`));
    const startedMs = stemTimeMs(stem);

    if (!pipeline) {
        // No pipeline record yet: still recording, or just stopped.
        if (Number.isFinite(startedMs) && now - startedMs < PENDING_WITHOUT_PIPELINE_MS) {
            return { state: 'pending', stem, title };
        }
        return { state: 'failed', stem, title };
    }
    if (pipeline.pipeline === 'capture') {
        return classifyServerCapture(dir, stem, pipeline, title, now, opts.uploadQueueDir);
    }
    const steps = pipeline.steps || {};
    const ingest = steps.ingest ? steps.ingest.state : null;
    const transcribe = steps.transcribe ? steps.transcribe.state : null;

    // 'skipped' counts as ingested when there is a recording id: a manual
    // re-run of an already-ingested capture skips the ingest step.
    if ((ingest === 'ok' || ingest === 'skipped') && pipeline.db_recording_id) {
        const lines = transcriptLineCount(path.join(dir, `transcript-${stem}.json`));
        if (!(lines && lines > 0)) return { state: 'nospeech', stem, title };
        // Not ready until diarize has finished one way or another: before
        // that, a call with several people still has all its call audio under
        // one speaker, and a saved file would present them as one voice. A
        // record with no diarize step at all (a capture from before diarize
        // existed) is done. A diarize step left unfinished by a crashed
        // pipeline is not waited for, same as any other step.
        const diarize = steps.diarize ? steps.diarize.state : null;
        if (steps.diarize && diarize !== 'ok' && diarize !== 'skipped' && diarize !== 'failed') {
            const updatedMs = Date.parse(pipeline.updated_at || '');
            if (Number.isFinite(updatedMs) && now - updatedMs < PENDING_WITH_PIPELINE_MS) {
                return { state: 'pending', stem, title };
            }
            return { state: 'failed', stem, title };
        }
        return { state: 'ready', stem, title, recordingId: pipeline.db_recording_id };
    }
    // Nothing was transcribed: the capture held no speech.
    if (transcribe === 'skipped' && ingest !== 'pending') return { state: 'nospeech', stem, title };
    if (ingest === 'failed' || ingest === 'skipped') return { state: 'failed', stem, title };
    // Not finished: pending only while the pipeline is recently active.
    const updatedMs = Date.parse(pipeline.updated_at || '');
    if (Number.isFinite(updatedMs) && now - updatedMs < PENDING_WITH_PIPELINE_MS) {
        return { state: 'pending', stem, title };
    }
    return { state: 'failed', stem, title };
}

// A capture in the trash (SAA-154) has a trashed-<stem>.json marker beside its
// files. main.js writes it once the server has trashed the capture
// (runTrashOnServer); before the cut-over, the direct path's trash script
// wrote it. A
// trashed capture is absent from every list here: the window's meetings, the
// tray's Save transcript item, and every other per-capture selection.
function isTrashed(dir, stem) {
    return fs.existsSync(path.join(dir, `trashed-${stem}.json`));
}

// Stems with a marker, whether or not the capture's other files still exist
// (a permanent delete interrupted part way leaves the marker alone).
function trashedStems(dir) {
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const stems = [];
    for (const file of files) {
        const m = /^trashed-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.json$/.exec(file);
        if (m) stems.push(m[1]);
    }
    return stems.sort().reverse(); // newest first
}

// Captures that are not in the trash, newest first.
function captureStems(dir) {
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const stems = [];
    for (const file of files) {
        const m = /^manifest-(.+)\.json$/.exec(file);
        if (m && !files.includes(`trashed-${m[1]}.json`)) stems.push(m[1]);
    }
    return stems.sort().reverse(); // newest first
}

// -> { state: 'ready', stem, recordingId, title } | { state: 'pending', stem, title } | null
function lastMeeting(dir, now = Date.now(), opts = {}) {
    for (const stem of captureStems(dir)) {
        const c = classifyCapture(dir, stem, now, opts);
        if (c.state === 'ready' || c.state === 'pending') return c;
    }
    return null;
}

module.exports = { lastMeeting, classifyCapture, captureStems, isTrashed, trashedStems, calendarTitle, stemTimeMs, readJson };
