'use strict';

// The rows of the recent-meetings window (SAA-217, Architecture Decision 18):
// every capture of the past week, newest first, each with what identifies it
// — title, who was on it, when, how long, and one line saying what kind of
// meeting it was. Nothing here reads a transcript: no moments, no search, no
// summary (Decision 18). Everything is read from the files the recorder and
// pipeline leave beside the recordings.
//
// The state of each row (ready / nospeech / failed / pending) is
// classifyCapture's, the same classification the tray's "Save transcript"
// item uses.

const fs = require('fs');
const path = require('path');
const { classifyCapture, captureStems, stemTimeMs, readJson } = require('./last-meeting.js');

const DAYS = 7;

// What the detected app is called to a person. Anything not listed shows as
// the app's own name.
const APP_NAMES = { avconferenced: 'FaceTime' };

function cleanName(v) {
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// Who else was on the call: the guests the person named when asked, else the
// calendar event's invitees. Never the person themselves.
function participantsFor(dir, stem) {
    const identity = readJson(path.join(dir, `identity-${stem}.json`));
    const self = identity && identity.self ? cleanName(identity.self.name) : null;
    let names = [];
    if (identity && Array.isArray(identity.guests)) {
        names = identity.guests.map((g) => cleanName(g && g.name)).filter(Boolean);
    } else {
        const cal = readJson(path.join(dir, `calendar-match-${stem}.json`));
        if (cal && Array.isArray(cal.invitees)) {
            names = cal.invitees.map((i) => cleanName(i && i.name)).filter(Boolean);
        }
    }
    const seen = new Set();
    return names.filter((n) => {
        const k = n.toLowerCase();
        if ((self && k === self.toLowerCase()) || seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

function durationSecFor(manifest) {
    const tracks = manifest && manifest.tracks;
    const list = Array.isArray(tracks) ? tracks : tracks && typeof tracks === 'object' ? Object.values(tracks) : [];
    let best = 0;
    for (const t of list) if (t && Number.isFinite(t.duration_s)) best = Math.max(best, t.duration_s);
    return best > 0 ? best : null;
}

// The one identifying line. For now it carries only the state notes; topics
// will fill it later (Decision 18, amended 2026-10-01). It does not carry the
// app, how capture started, Personal/Work or the people count.
function identifyingLine(row) {
    const parts = [];
    if (row.state === 'nospeech') parts.push('No speech captured');
    else if (row.state === 'failed') parts.push("Couldn't be processed");
    else if (row.state === 'pending') parts.push('Still processing');
    if (row.state === 'ready' && row.namingPending) parts.push('voices not named yet');
    return parts.join(' · ');
}

// -> rows, newest first. `now` is injectable for checks.
function listMeetings(dir, now = Date.now(), days = DAYS) {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const rows = [];
    for (const stem of captureStems(dir)) {
        const startedAtMs = stemTimeMs(stem);
        if (!Number.isFinite(startedAtMs) || startedAtMs < cutoff || startedAtMs > now + 60 * 1000) continue;
        const c = classifyCapture(dir, stem, now);
        const manifest = readJson(path.join(dir, `manifest-${stem}.json`));
        const appRaw = manifest && manifest.trigger_app ? cleanName(manifest.trigger_app.name) : null;
        const identity = readJson(path.join(dir, `identity-${stem}.json`));
        const participants = participantsFor(dir, stem);
        const hasVoices = fs.existsSync(path.join(dir, `voices-${stem}.json`));
        const named = fs.existsSync(path.join(dir, `voice-names-${stem}.json`));
        const row = {
            stem,
            startedAtMs,
            state: c.state,
            title: c.title,
            participants,
            people: participants.length + 1,
            durationSec: durationSecFor(manifest),
            app: appRaw ? APP_NAMES[appRaw] || appRaw : null,
            scope: identity && (identity.scope === 'work' || identity.scope === 'personal') ? identity.scope : null,
            canSave: c.state === 'ready',
            // Naming data exists only for a call diarize split into voices.
            canFix: hasVoices,
            hasNames: named,
            namingPending: hasVoices && !named,
        };
        row.line = identifyingLine(row);
        rows.push(row);
    }
    return rows;
}

// The All / Work / Personal switch. A row with no scope recorded matches
// neither Work nor Personal, so it shows under All only.
function filterRows(rows, filter) {
    return filter === 'work' || filter === 'personal' ? rows.filter((r) => r.scope === filter) : rows;
}

module.exports = { listMeetings, identifyingLine, filterRows, DAYS };
