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
//   unknown   sent, and the server never confirmed how its jobs ended (a
//             capture-pipeline capture only; see classifyServerCapture)
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
// Failed when the server refused it, or its jobs failed, are gone, or there were
// none. Unknown when its jobs went unconfirmed past the polling limit ("stale"):
// nothing says they failed, and the server is asked again (SAA-183). Pending
// while it waits to be sent or its jobs run. With no entry, it is pending only
// while its pipeline was recently active, like a pre-cutover capture.
const SERVER_CAPTURE_FAILED_JOBS = new Set(['failed', 'gone', 'none']);

// Whether a pipeline record shows every step finished: ok, or skipped.
function stepsFinished(pipeline) {
    return Object.values(pipeline.steps || {}).every((s) => s && (s.state === 'ok' || s.state === 'skipped'));
}

function classifyServerCapture(dir, stem, pipeline, title, now, uploadQueueDir) {
    const steps = pipeline.steps || {};
    const updatedMs = Date.parse(pipeline.updated_at || '');
    const recentlyActive = Number.isFinite(updatedMs) && now - updatedMs < PENDING_WITH_PIPELINE_MS;
    // The classifier refused the capture: a second run refuses it again.
    if (steps.classify && steps.classify.state === 'failed') return { state: 'failed', stem, title };
    if (!stepsFinished(pipeline)) return { state: recentlyActive ? 'pending' : 'failed', stem, title };
    const lines = transcriptLineCount(path.join(dir, `transcript-${stem}.json`));
    if (!(lines && lines > 0)) return { state: 'nospeech', stem, title };
    const entry = uploadQueueDir ? readJson(path.join(uploadQueueDir, `${stem}.json`)) : null;
    if (!entry) return { state: recentlyActive ? 'pending' : 'failed', stem, title };
    if (entry.state === 'sent' && entry.jobState === 'done' && entry.recordingId) {
        return { state: 'ready', stem, title, recordingId: entry.recordingId };
    }
    if (entry.state === 'failed') return { state: 'failed', stem, title };
    if (entry.state === 'sent' && SERVER_CAPTURE_FAILED_JOBS.has(entry.jobState)) return { state: 'failed', stem, title };
    if (entry.state === 'sent' && entry.jobState === 'stale') return { state: 'unknown', stem, title };
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

// --- the tray's pipeline failure, after a recovery pass (main.js startRecovery) --
//
// Whether a capture whose pipeline failed is no longer failed, read once the
// recovery pass started for it has exited. Either its record now shows every
// step finished (ok or skipped): whatever failed was finished since, by that
// pass or before it, whether or not the pass left a recovery record (SAA-238);
// a record with no steps has finished nothing.
// Or the pass reports it complete: its recovery-<stem>.json says "complete" or
// "recovered" (capture-recover.ts's Attempts.last_action), written after
// `triggeredAtMs`, when the pass began, so a record an earlier pass left behind
// is not read as this one clearing it (SAA-183).
const RECOVERY_COMPLETE_ACTIONS = new Set(['complete', 'recovered']);

function failureResolved(dir, stem, triggeredAtMs) {
    const pipeline = readJson(path.join(dir, `pipeline-${stem}.json`));
    if (pipeline && Object.keys(pipeline.steps || {}).length > 0 && stepsFinished(pipeline)) return true;
    const record = readJson(path.join(dir, `recovery-${stem}.json`));
    const actionAtMs = record && record.last_action_at ? Date.parse(record.last_action_at) : NaN;
    return !!record && RECOVERY_COMPLETE_ACTIONS.has(record.last_action) && Number.isFinite(actionAtMs) && actionAtMs > triggeredAtMs;
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

// --- a sent capture's server jobs (main.js pollJobStates) --------------------
//
// The jobs as GET /captures/:captureId/jobs lists them, folded into the one state
// the queue entry keeps: running while any is queued or running, failed when none
// is and one failed, done when all are done, none when there are none. Only the
// extraction jobs count (SAA-227 decision 18): the calendar match is extra, and a
// failed or slow match never makes a capture failed or keeps it from ready.
function jobStateOf(jobs) {
    const extraction = jobs.filter((j) => j.kind !== 'match');
    if (extraction.length === 0) return 'none';
    if (extraction.some((j) => j.state === 'queued' || j.state === 'running')) return 'running';
    if (extraction.some((j) => j.state === 'failed')) return 'failed';
    return 'done';
}

// Whether a match job is still to finish, so the asking goes on for its title.
function matchPendingOf(jobs) {
    return jobs.some((j) => j.kind === 'match' && (j.state === 'queued' || j.state === 'running'));
}

// --- what one ask about a sent capture's jobs leaves on its queue entry ------
//
// main.js pollJobStates asks GET /captures/:captureId/jobs and writes back what
// this returns. Answered, the next ask is JOB_POLL_MS later. Not answered (no
// HTTP reply at all: the server or the network was down), nothing about the
// jobs is learned, the next ask backs off from JOB_NO_REPLY_FIRST_MS doubling
// to JOB_NO_REPLY_MAX_MS, like the upload queue, and the asking never gives up:
// an unreachable server is not a reason to stop (SAA-183).
//
// JOB_POLL_LIMIT_MS counts only time the server was answering: the time from
// the send, or from an answered ask, to the next answered ask. Once past it, a
// state still unsettled is "stale" (status unknown, shown as such, never as
// failed) and a pending calendar match is given up on, so a stalled job cannot
// keep this Mac querying a server that answers. A stale capture is asked once
// more at launch, on wake and when Recent meetings opens; a reply then settles
// it, and anything else leaves it stale. A new send of a capture starts all of
// this again (main.js sendQueuedCapture clears these fields).
//
// `reply` is captureServerRequest's: { status, json }, status null when no
// reply came. `now` is in ms. -> the entry as it now stands, with `gaveUp`
// ('jobs', 'match' or null) saying what this ask stopped asking about.
const JOB_POLL_MS = 20 * 1000;
const JOB_POLL_LIMIT_MS = 15 * 60 * 1000;
const JOB_NO_REPLY_FIRST_MS = 60 * 1000;
const JOB_NO_REPLY_MAX_MS = 60 * 60 * 1000;
const JOB_SETTLED = new Set(['done', 'failed', 'none', 'gone', 'stale']);

function jobNoReplyBackoffMs(unanswered) {
    return Math.min(JOB_NO_REPLY_MAX_MS, JOB_NO_REPLY_FIRST_MS * 2 ** Math.max(0, unanswered - 1));
}

function jobPollStep(entry, reply, now) {
    const at = new Date(now).toISOString();
    if (!reply || reply.status == null) {
        const unanswered = (entry.jobUnanswered || 0) + 1;
        return { ...entry, jobPolledAt: at, jobUnanswered: unanswered, nextJobPollAt: new Date(now + jobNoReplyBackoffMs(unanswered)).toISOString(), gaveUp: null };
    }
    // The time since the last answer counts only when that answer was the last ask.
    const lastAnsweredMs = Date.parse(entry.jobPolledAt || entry.sentAt);
    const answeredMs = (entry.jobAnsweredMs || 0) + (!entry.jobUnanswered && Number.isFinite(lastAnsweredMs) ? Math.max(0, now - lastAnsweredMs) : 0);
    let jobState = entry.jobState;
    let matchPending = entry.matchPending === true;
    if (reply.status === 200 && reply.json && Array.isArray(reply.json.jobs)) {
        jobState = jobStateOf(reply.json.jobs);
        matchPending = matchPendingOf(reply.json.jobs);
    } else if (reply.status === 404) {
        jobState = 'gone';
        matchPending = false;
    }
    let gaveUp = null;
    if (answeredMs > JOB_POLL_LIMIT_MS) {
        if (matchPending) {
            matchPending = false;
            gaveUp = 'match';
        }
        if (!JOB_SETTLED.has(jobState)) {
            jobState = 'stale';
            gaveUp = 'jobs';
        }
    }
    return {
        ...entry, jobState, matchPending, jobAnsweredMs: answeredMs, jobPolledAt: at, jobUnanswered: 0,
        nextJobPollAt: new Date(now + JOB_POLL_MS).toISOString(), gaveUp,
    };
}

// The server's calendar match for a capture (the jobs reply's `calendar`: the
// title, and each invitee's name or address), written where calendarTitle and
// Recent Meetings' participants read it, in the shape they read (SAA-227
// decision 15). Written whole to a .tmp beside it, then renamed. Anything not of
// that shape writes nothing. -> whether it wrote.
function writeCalendarMatchFile(dir, stem, calendar) {
    if (!calendar || typeof calendar !== 'object' || !Array.isArray(calendar.invitees)) return false;
    const title = typeof calendar.title === 'string' && calendar.title.trim() ? calendar.title : null;
    const invitees = calendar.invitees
        .filter((i) => i && typeof i.name === 'string' && i.name.trim())
        .map((i) => ({ name: i.name }));
    if (!title && invitees.length === 0) return false;
    const file = path.join(dir, `calendar-match-${stem}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ title, invitees }, null, 2) + '\n');
    fs.renameSync(`${file}.tmp`, file);
    return true;
}

module.exports = {
    lastMeeting, classifyCapture, captureStems, isTrashed, trashedStems, calendarTitle, stemTimeMs, readJson,
    jobStateOf, matchPendingOf, writeCalendarMatchFile, jobPollStep, JOB_POLL_MS, JOB_POLL_LIMIT_MS, JOB_SETTLED,
    failureResolved,
};
