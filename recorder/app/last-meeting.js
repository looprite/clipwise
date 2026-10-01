'use strict';

// Which meeting the tray's "Save transcript" item acts on (SAA-199): the most
// recent capture that has a transcript with something in it. Read from the
// files the pipeline leaves beside the recordings, because main.js has no
// database access — the same reason identity-answer.js reads files.
//
// A capture counts as the meeting only when it was ingested (the pipeline
// record has a db_recording_id and the ingest step is ok, or skipped because
// an earlier run already did it) and its transcript has at least one line. A newer capture with no speech, or one whose
// pipeline failed, is skipped — this is the rule that decides which meeting
// the item names, and it is stated in the item's label (title and time) so
// the person can see which one they are about to save.
//
// The newest capture still being processed is reported as `pending`, not
// skipped: showing the previous meeting while a newer one is a few seconds
// from ready would offer the wrong one. A capture that is neither finished
// nor recently active (a crashed pipeline) is not waited for.

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

// The meeting's title for the label: the calendar event it was matched to.
// Null when there was no match; the caller shows "Untitled call".
function calendarTitle(dir, stem) {
    const doc = readJson(path.join(dir, `calendar-match-${stem}.json`));
    return doc && typeof doc.title === 'string' && doc.title.trim() ? doc.title.trim() : null;
}

// -> { state: 'ready', stem, recordingId, title } | { state: 'pending', stem, title } | null
function lastMeeting(dir, now = Date.now()) {
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return null;
    }
    const stems = [];
    for (const file of files) {
        const m = /^manifest-(.+)\.json$/.exec(file);
        if (m) stems.push(m[1]);
    }
    stems.sort().reverse(); // newest first

    for (const stem of stems) {
        const title = calendarTitle(dir, stem);
        const pipeline = readJson(path.join(dir, `pipeline-${stem}.json`));
        const startedMs = stemTimeMs(stem);

        if (!pipeline) {
            // No pipeline record yet: still recording, or just stopped.
            if (Number.isFinite(startedMs) && now - startedMs < PENDING_WITHOUT_PIPELINE_MS) {
                return { state: 'pending', stem, title };
            }
            continue;
        }
        const ingest = pipeline.steps && pipeline.steps.ingest ? pipeline.steps.ingest.state : null;
        // 'skipped' counts as ingested when there is a recording id: a manual
        // re-run of an already-ingested capture skips the ingest step.
        if ((ingest === 'ok' || ingest === 'skipped') && pipeline.db_recording_id) {
            const lines = transcriptLineCount(path.join(dir, `transcript-${stem}.json`));
            if (lines && lines > 0) return { state: 'ready', stem, recordingId: pipeline.db_recording_id, title };
            continue; // ingested, but no speech
        }
        if (ingest === 'failed' || ingest === 'skipped') continue;
        // Not finished: pending only while the pipeline is recently active.
        const updatedMs = Date.parse(pipeline.updated_at || '');
        if (Number.isFinite(updatedMs) && now - updatedMs < PENDING_WITH_PIPELINE_MS) {
            return { state: 'pending', stem, title };
        }
    }
    return null;
}

module.exports = { lastMeeting, calendarTitle, stemTimeMs };
