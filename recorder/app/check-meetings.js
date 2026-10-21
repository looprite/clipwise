'use strict';

// Regression check for the recent-meetings rows (SAA-217). Made-up captures
// in a temporary folder (Architecture Decision 11); nothing real is read.
//
// Usage:
//   node check-meetings.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { listMeetings, filterRows } = require('./meetings.js');
const { lastMeeting } = require('./last-meeting.js');

let failed = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`);
    if (!ok) failed++;
}

const NOW = Date.parse('2026-03-06T20:00:00Z'); // a Friday, made up
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-meetings-check-'));
const w = (name, doc) => fs.writeFileSync(path.join(dir, name), JSON.stringify(doc));

function capture(stem, o = {}) {
    w(`manifest-${stem}.json`, {
        started_at: stem,
        trigger_app: o.app === undefined ? { key: 'k', name: 'Google Chrome' } : o.app,
        tracks: [{ duration_s: o.duration ?? 600 }, { duration_s: (o.duration ?? 600) - 0.02 }],
    });
    w(`pipeline-${stem}.json`, {
        db_recording_id: o.noDb ? null : `rid-${stem}`,
        updated_at: new Date(NOW - (o.updatedAgoMs ?? 3600e3)).toISOString(),
        steps: {
            transcribe: { state: o.transcribe || 'ok' },
            ingest: { state: o.ingest || 'ok' },
            ...(o.diarize ? { diarize: { state: o.diarize } } : {}),
        },
    });
    if (o.lines !== null) w(`transcript-${stem}.json`, { segments: Array.from({ length: o.lines ?? 5 }, () => ({})) });
    if (o.title) w(`calendar-match-${stem}.json`, { title: o.title, invitees: o.invitees || [] });
    if (o.identity) w(`identity-${stem}.json`, o.identity);
    if (o.voices) w(`voices-${stem}.json`, { voices: [] });
    if (o.voiceNames) w(`voice-names-${stem}.json`, { voices: [] });
}

// Mon 4 Mar .. Fri 6 Mar, made-up times (UTC)
capture('2026-02-26T15-00-00Z', { title: 'Too Old' });                                        // 8+ days back
capture('2026-03-02T15-00-00Z', {                                                            // group call, voices unnamed
    title: 'Made-Up Sync', duration: 840, voices: true,
    identity: { self: { name: 'Jon Example' }, guests: [{ name: 'Alice Example' }, { name: 'Bob Example' }, { name: 'Jon Example' }], scope: 'work' },
});
capture('2026-03-03T19-00-00Z', {                                                            // 1:1 on FaceTime, personal
    app: { key: 'com.apple.avconferenced', name: 'avconferenced' }, duration: 305,
    identity: { self: { name: 'Jon Example' }, guests: [{ name: 'Carol Example' }], scope: 'personal' },
});
capture('2026-03-04T14-00-00Z', { duration: 36, lines: 0, transcribe: 'skipped' });          // no speech
capture('2026-03-04T21-30-00Z', { ingest: 'failed', noDb: true, lines: null });              // failed
capture('2026-03-05T18-00-00Z', { title: 'Named Group', voices: true, voiceNames: true, duration: 4000,
    identity: { self: { name: 'Jon Example' }, guests: [{ name: 'Dan Example' }, { name: 'Eve Example' }] } });
capture('2026-03-06T19-58-00Z', { ingest: 'pending', noDb: true, lines: null, transcribe: 'ok', updatedAgoMs: 60e3 }); // processing now

const rows = listMeetings(dir, NOW);
const byStem = Object.fromEntries(rows.map((r) => [r.stem, r]));

check('newest first, only the past 7 days (6 rows, the old one left out)',
    rows.length === 6 && rows[0].stem === '2026-03-06T19-58-00Z' && !byStem['2026-02-26T15-00-00Z'],
    rows.map((r) => r.stem).join(' '));
check('states, newest first: pending, ready, failed, nospeech, ready, ready',
    rows.map((r) => r.state).join(',') === 'pending,ready,failed,nospeech,ready,ready',
    rows.map((r) => r.state).join(','));

const g = byStem['2026-03-02T15-00-00Z'];
check('group call: title, participants without the person themselves, people count',
    g.title === 'Made-Up Sync' && g.participants.join(',') === 'Alice Example,Bob Example' && g.people === 3, JSON.stringify(g));
check('group call: duration, work, voices not named yet; line is the state note only',
    g.durationSec > 839 && g.scope === 'work' && g.namingPending === true && g.canFix === true &&
    g.line === 'voices not named yet', g.line);
const named = byStem['2026-03-05T18-00-00Z'];
check('named group call: Fix names on, no "not named" note', named.canFix && !named.namingPending && !/not named/.test(named.line), named.line);
const one = byStem['2026-03-03T19-00-00Z'];
check('1:1: personal, Fix names off, untitled, empty third line',
    one.scope === 'personal' && one.canFix === false && one.title === null && one.line === '', one.line);
const none = byStem['2026-03-04T14-00-00Z'];
check('no speech: says so, cannot save', none.state === 'nospeech' && !none.canSave && none.line.startsWith('No speech captured'), none.line);
const bad = byStem['2026-03-04T21-30-00Z'];
check('failed capture: says so', bad.state === 'failed' && bad.line.startsWith("Couldn't be processed"), bad.line);
check('processing: says so, cannot save yet', rows[0].state === 'pending' && !rows[0].canSave && rows[0].line.startsWith('Still processing'), rows[0].line);

check('no ready row\'s line names an app, "Started manually", Personal/Work or a people count',
    rows.every((r) => !/Chrome|FaceTime|Started manually|Personal|Work|people/.test(r.line)), rows.map((r) => r.line).join(' | '));
const stemsOf = (f) => filterRows(rows, f).map((r) => r.stem).sort().join(',');
const scoped = (sc) => rows.filter((r) => r.scope === sc).map((r) => r.stem).sort().join(',');
check('filter All: every row', filterRows(rows, 'all').length === rows.length);
check('filter Work: only Work rows (the group call)', stemsOf('work') === scoped('work') && stemsOf('work') === '2026-03-02T15-00-00Z', stemsOf('work'));
check('filter Personal: only Personal rows (the 1:1)', stemsOf('personal') === scoped('personal') && stemsOf('personal') === '2026-03-03T19-00-00Z', stemsOf('personal'));
check('rows with no scope recorded show under All only',
    rows.filter((r) => r.scope === null).length === 4 &&
    rows.filter((r) => r.scope === null).every((r) => filterRows(rows, 'all').includes(r) && !filterRows(rows, 'work').includes(r) && !filterRows(rows, 'personal').includes(r)));

const sig = rows.filter((r) => r.state !== 'pending').map((r) => [r.title, r.participants.join('+'), r.startedAtMs, r.durationSec, r.line].join('|'));
check('every row is distinguishable from its own fields', new Set(sig).size === sig.length);

// The same classification as the tray item.
const lm = lastMeeting(dir, NOW);
check('the tray item and the window agree on the newest capture', lm.state === 'pending' && lm.stem === rows[0].stem, JSON.stringify(lm));
fs.rmSync(path.join(dir, 'pipeline-2026-03-06T19-58-00Z.json'));
fs.rmSync(path.join(dir, 'manifest-2026-03-06T19-58-00Z.json'));
check('without the processing capture, the tray item is the newest ready meeting',
    lastMeeting(dir, NOW).stem === '2026-03-05T18-00-00Z');

// Diarize readiness: a group call is not ready until diarize has finished.
{
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-meetings-diarize-'));
    // capture() writes to `dir`; point it at d2 for these.
    const writeTo = (stem, o) => {
        const keep = fs.readdirSync(dir);
        capture(stem, o);
        for (const f of fs.readdirSync(dir)) if (!keep.includes(f)) fs.renameSync(path.join(dir, f), path.join(d2, f));
    };
    const stateOf = (stem, o, now = NOW) => { for (const f of fs.readdirSync(d2)) fs.rmSync(path.join(d2, f)); writeTo(stem, o); const r = listMeetings(d2, now)[0]; return { state: r.state, canSave: r.canSave, line: r.line, last: lastMeeting(d2, now) }; };
    const S = '2026-03-06T18-00-00Z';
    let r = stateOf(S, { diarize: 'pending', updatedAgoMs: 60e3 });
    check('diarize pending -> not ready (window row)', r.state === 'pending' && !r.canSave && r.line.startsWith('Still processing'), JSON.stringify(r));
    check('diarize pending -> not ready (tray item)', r.last && r.last.state === 'pending', JSON.stringify(r.last));
    r = stateOf(S, { diarize: 'running', updatedAgoMs: 60e3 });
    check('diarize running -> not ready', r.state === 'pending' && !r.canSave, JSON.stringify(r));
    for (const st of ['ok', 'skipped', 'failed']) {
        r = stateOf(S, { diarize: st, updatedAgoMs: 60e3 });
        check(`diarize ${st} -> ready`, r.state === 'ready' && r.canSave && r.last && r.last.state === 'ready', JSON.stringify(r));
    }
    r = stateOf(S, { updatedAgoMs: 60e3 });
    check('no diarize step on a finished record -> ready', r.state === 'ready' && r.canSave && r.last.state === 'ready', JSON.stringify(r));
    r = stateOf(S, { diarize: 'pending', updatedAgoMs: 3 * 3600e3 });
    check('diarize left pending by a crashed pipeline (3 h) is not waited for', r.state === 'failed' && r.last === null, JSON.stringify(r));
    r = stateOf(S, { diarize: 'pending', updatedAgoMs: 60e3, lines: 0 });
    check('no speech stays no speech whatever diarize says', r.state === 'nospeech', JSON.stringify(r));
    fs.rmSync(d2, { recursive: true, force: true });
}

// ---- the trash (SAA-154) -----------------------------------------------------
// A capture with a trashed-<stem>.json marker is absent from the window's rows
// and from every per-capture selection, and listed only by listTrashed.
// Restoring (the marker going) brings it all back.
{
    const { listTrashed } = require('./meetings.js');
    const ia = require('./identity-answer.js');
    const t3 = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-trash-meetings-check-'));
    const tw = (name, doc) => fs.writeFileSync(path.join(t3, name), JSON.stringify(doc));
    const tcap = (stem, extra = {}) => {
        tw(`manifest-${stem}.json`, { started_at: stem, tracks: [{ duration_s: 600 }] });
        tw(`pipeline-${stem}.json`, {
            db_recording_id: `rid-${stem}`,
            updated_at: new Date(NOW - 3600e3).toISOString(),
            steps: { transcribe: { state: 'ok' }, ingest: { state: 'ok' } },
        });
        tw(`transcript-${stem}.json`, { segments: [{}, {}] });
        for (const [name, doc] of Object.entries(extra)) tw(name.replace('<s>', stem), doc);
    };
    const R1 = '2026-03-02T15-00-00Z', R2 = '2026-03-03T15-00-00Z', R3 = '2026-03-04T15-00-00Z';
    tcap(R1, { 'voice-names-<s>.json': {} });
    tcap(R2, { 'voices-<s>.json': {}, 'identity-later-<s>.json': {} });
    tcap(R3, { 'voice-names-<s>.json': {}, 'voices-<s>.json': {} });
    const mark = (stem) => tw(`trashed-${stem}.json`, { stem, source_id: `src-${stem}`, trashed_at: '2026-03-05T12:00:00.000Z' });
    const unmark = (stem) => fs.rmSync(path.join(t3, `trashed-${stem}.json`));
    const stemsOf = (rs) => rs.map((r) => r.stem).join(' ');

    // positive controls: nothing is trashed yet, everything is found
    check('trash: before any marker, the window lists all three, newest first', stemsOf(listMeetings(t3, NOW)) === `${R3} ${R2} ${R1}`, stemsOf(listMeetings(t3, NOW)));
    check('trash: before any marker, Save transcript names the newest', lastMeeting(t3, NOW).stem === R3);
    check('trash: before any marker, the selectors find the newest', ia.mostRecentNamedStem(t3) === R3 && ia.mostRecentCaptureStem(t3) === R3);
    check('trash: before any marker, the tray lists the pending identity and naming items',
        ia.pendingIdentityStems(t3).join() === R2 && ia.pendingVoiceNamingStems(t3).join() === R2, `${ia.pendingIdentityStems(t3)} / ${ia.pendingVoiceNamingStems(t3)}`);
    check('trash: the trash view is empty', listTrashed(t3).length === 0);

    mark(R3);
    check('trashed: gone from the window rows', stemsOf(listMeetings(t3, NOW)) === `${R2} ${R1}`, stemsOf(listMeetings(t3, NOW)));
    check('trashed: Save transcript names the previous meeting, not the trashed one', lastMeeting(t3, NOW).stem === R2, JSON.stringify(lastMeeting(t3, NOW)));
    check('trashed: Fix speaker names\' candidate and the newest-capture check skip it', ia.mostRecentNamedStem(t3) === R1 && ia.mostRecentCaptureStem(t3) === R2, `${ia.mostRecentNamedStem(t3)} ${ia.mostRecentCaptureStem(t3)}`);
    const tr = listTrashed(t3);
    check('trashed: the trash view lists it, with when it was trashed and not partial',
        tr.length === 1 && tr[0].stem === R3 && tr[0].trashedAtMs === Date.parse('2026-03-05T12:00:00.000Z') && tr[0].partial === false, JSON.stringify(tr));

    mark(R2);
    check('trashed: a trashed capture is dropped from the pending identity and naming items',
        ia.pendingIdentityStems(t3).length === 0 && ia.pendingVoiceNamingStems(t3).length === 0, `${ia.pendingIdentityStems(t3)} / ${ia.pendingVoiceNamingStems(t3)}`);
    mark(R1);
    check('trashed: with all three trashed there is nothing to save and the window is empty', lastMeeting(t3, NOW) === null && listMeetings(t3, NOW).length === 0);
    check('trashed: all three are in the trash view, newest first', stemsOf(listTrashed(t3)) === `${R3} ${R2} ${R1}`, stemsOf(listTrashed(t3)));

    for (const s of [R1, R2, R3]) unmark(s);
    check('restored: the window, Save transcript, selectors and tray items all find them again',
        stemsOf(listMeetings(t3, NOW)) === `${R3} ${R2} ${R1}` && lastMeeting(t3, NOW).stem === R3 &&
        ia.mostRecentNamedStem(t3) === R3 && ia.mostRecentCaptureStem(t3) === R3 &&
        ia.pendingIdentityStems(t3).join() === R2 && listTrashed(t3).length === 0);

    // A permanent delete interrupted after the files: only the marker is left.
    const GONE = '2026-03-01T09-00-00Z';
    mark(GONE);
    const g = listTrashed(t3);
    check('a marker alone (files already deleted) is listed as partial, and is not a meeting row',
        g.length === 1 && g[0].stem === GONE && g[0].partial === true && g[0].title === null && !listMeetings(t3, NOW).some((r) => r.stem === GONE), JSON.stringify(g));
    unmark(GONE);

    // Which rows can be sent to the trash: anything but a capture still in flight.
    const P = '2026-03-06T19-58-00Z'; // processing right now
    tw(`manifest-${P}.json`, { started_at: P, tracks: [{ duration_s: 60 }] });
    tw(`pipeline-${P}.json`, { db_recording_id: null, updated_at: new Date(NOW - 60e3).toISOString(), steps: { transcribe: { state: 'ok' }, ingest: { state: 'pending' } } });
    const N = '2026-03-04T14-00-00Z'; // no speech
    tw(`manifest-${N}.json`, { started_at: N, tracks: [{ duration_s: 36 }] });
    tw(`pipeline-${N}.json`, { db_recording_id: `rid-${N}`, updated_at: new Date(NOW - 3600e3).toISOString(), steps: { transcribe: { state: 'skipped' }, ingest: { state: 'ok' } } });
    tw(`transcript-${N}.json`, { segments: [] });
    const F = '2026-03-04T21-30-00Z'; // failed
    tw(`manifest-${F}.json`, { started_at: F, tracks: [{ duration_s: 60 }] });
    tw(`pipeline-${F}.json`, { db_recording_id: null, updated_at: new Date(NOW - 3600e3).toISOString(), steps: { transcribe: { state: 'ok' }, ingest: { state: 'failed' } } });
    const canTrash = Object.fromEntries(listMeetings(t3, NOW).map((r) => [r.state, r.canTrash]));
    check('canTrash: ready, no speech and failed can be trashed; a capture still processing cannot',
        canTrash.ready === true && canTrash.nospeech === true && canTrash.failed === true && canTrash.pending === false, JSON.stringify(canTrash));
    fs.rmSync(t3, { recursive: true, force: true });
}

// ---- the naming window's stop message (SAA-195, SAA-227) ---------------------
// stopMessageFor reads only the pipeline record. A capture-pipeline record
// (pipeline: "capture") has no ingest step and no model_revision; a direct
// record is read as it always was.
{
    const { stopMessageFor } = require('./voice-naming-wait.js');
    const ONE = 'Only one other voice on this call — nothing to name.';
    const CANT = "Couldn't separate the voices on this call.";
    const cap = (steps) => ({ pipeline: 'capture', steps });
    const ok = (detail) => ({ state: 'ok', detail });

    check('capture: the classifier refused it (diarize never ran) -> couldn\'t separate',
        stopMessageFor(cap({ transcribe: ok({}), classify: { state: 'failed' }, diarize: { state: 'pending' } })) === CANT);
    check('capture: diarize ran and found one voice, no naming data -> one other voice',
        stopMessageFor(cap({ transcribe: ok({}), classify: ok({}), diarize: ok({ voices_found: 1, naming_data: false }) })) === ONE);
    check('capture: diarize ran and found no voice -> one other voice',
        stopMessageFor(cap({ transcribe: ok({}), classify: ok({}), diarize: ok({ voices_found: 0, naming_data: false }) })) === ONE);
    check('capture: diarize found three voices but no naming data (them excluded, or naming_error) -> couldn\'t separate',
        stopMessageFor(cap({ transcribe: ok({}), classify: ok({}), diarize: ok({ voices_found: 3, naming_data: false, naming_error: 'ffmpeg missing' }) })) === CANT);
    check('capture: diarize skipped (the tool could not run) -> couldn\'t separate',
        stopMessageFor(cap({ transcribe: ok({}), classify: ok({}), diarize: { state: 'skipped', detail: { reason: 'diarize tool failed' } } })) === CANT);
    check('capture: still running (diarize pending, nothing failed) -> keep waiting',
        stopMessageFor(cap({ transcribe: { state: 'running' }, classify: { state: 'pending' }, diarize: { state: 'pending' } })) === null);
    check('capture: transcribe failed before diarize -> couldn\'t separate, as before',
        stopMessageFor(cap({ transcribe: { state: 'failed' }, classify: { state: 'pending' }, diarize: { state: 'pending' } })) === CANT);

    // A direct record (no `pipeline` key) is unchanged: diarize "ok" means it split
    // and naming data is still coming, so the window keeps waiting; a skip with a
    // model_revision is the one-voice case; ingest failing is couldn't-separate.
    const direct = (steps) => ({ db_recording_id: 'r', steps });
    check('direct: diarize ok (a split, naming data on its way) -> keep waiting, unchanged',
        stopMessageFor(direct({ transcribe: ok({}), ingest: ok({}), diarize: ok({ voices_found: 3 }) })) === null);
    check('direct: diarize skipped with a model_revision -> one other voice, unchanged',
        stopMessageFor(direct({ transcribe: ok({}), ingest: ok({}), diarize: { state: 'skipped', detail: { model_revision: 'm1' } } })) === ONE);
    check('direct: ingest failed before diarize -> couldn\'t separate, unchanged',
        stopMessageFor(direct({ transcribe: ok({}), ingest: { state: 'failed' }, diarize: { state: 'pending' } })) === CANT);
}

// ---- the server's calendar match (SAA-227 part F, decisions 15, 18 and 29) ----
// Two captures the capture pipeline handled and sent, neither with an identity
// answer. Each reply is one GET /captures/:captureId/jobs can return: the server
// sends `calendar` only once a match job is done. main.js pollJobStates writes
// the calendar with writeCalendarMatchFile and keeps jobStateOf's state on the
// queue entry; the window and the tray read both back.
//   M  extraction done, the match done, with its calendar. Bob has no name in
//      Google, so the server sent his address.
//   F  extraction done, the match failed (its retries used up), no calendar.
{
    const lm = require('./last-meeting.js');
    const c4 = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-meetings-calendar-check-'));
    const Q = path.join(c4, 'upload-queue');
    fs.mkdirSync(Q);
    const cw = (name, doc) => fs.writeFileSync(path.join(c4, name), JSON.stringify(doc));
    const has = typeof lm.writeCalendarMatchFile === 'function' && typeof lm.jobStateOf === 'function';
    // As pollJobStates handles a reply: the calendar written, the folded state kept.
    const sent = (stem, n, reply) => {
        cw(`manifest-${stem}.json`, { started_at: stem, recording_id: `A1B2C3D4-0000-4000-8000-00000000000${n}`, tracks: [{ duration_s: 1800 }] });
        cw(`pipeline-${stem}.json`, { pipeline: 'capture', updated_at: new Date(NOW - 3600e3).toISOString(), steps: { transcribe: { state: 'ok' }, classify: { state: 'ok' } } });
        cw(`transcript-${stem}.json`, { segments: [{}, {}, {}] });
        const wrote = has ? lm.writeCalendarMatchFile(c4, stem, reply.calendar) : false;
        const jobState = has ? lm.jobStateOf(reply.jobs) : '(no jobStateOf in last-meeting.js)';
        fs.writeFileSync(path.join(Q, `${stem}.json`), JSON.stringify({ stem, state: 'sent', sentAt: new Date(NOW - 3000e3).toISOString(), recordingId: `rid-${n}`, jobState }));
        return { wrote, jobState };
    };
    const M = '2026-03-06T16-00-00Z';
    const F = '2026-03-06T17-00-00Z';
    const m = sent(M, 1, {
        jobs: [{ kind: 'extract', state: 'done', attempts: 1 }, { kind: 'match', state: 'done', attempts: 1 }],
        calendar: { title: 'Made-Up Planning', invitees: [{ name: 'Ann Example' }, { name: 'bob@example.test' }] },
    });
    const f = sent(F, 2, {
        jobs: [{ kind: 'extract', state: 'done', attempts: 1 }, { kind: 'match', state: 'failed', attempts: 3 }],
        calendar: null,
    });
    const rows = listMeetings(c4, NOW, undefined, { uploadQueueDir: Q });
    const rowM = rows.find((r) => r.stem === M);
    const rowF = rows.find((r) => r.stem === F);
    const tray = lastMeeting(c4, NOW, { uploadQueueDir: Q });

    check('server calendar match: a capture with no identity answer shows the event title and its invitees as participants, the one with no name by address',
        m.wrote === true && !!rowM && rowM.title === 'Made-Up Planning' && rowM.participants.join(',') === 'Ann Example,bob@example.test',
        JSON.stringify({ wrote: m.wrote, title: rowM && rowM.title, participants: rowM && rowM.participants }));
    check('a failed match job does not show the capture as failed: extraction done is ready, in the window and the tray',
        f.jobState === 'done' && f.wrote === false && !!rowF && rowF.state === 'ready' && rowF.canSave === true && rowF.title === null && !!tray && tray.state === 'ready' && tray.stem === F,
        JSON.stringify({ jobState: f.jobState, wrote: f.wrote, row: rowF && rowF.state, title: rowF && rowF.title, tray: tray && [tray.state, tray.stem === F ? 'F' : tray.stem] }));
    fs.rmSync(c4, { recursive: true, force: true });
}

// ---- a sent capture whose jobs went unconfirmed (SAA-183) ---------------------
// "stale" is a status unknown, not a failure: the server was not heard from in
// time, and is asked again. A capture whose jobs failed, or that the server
// refused (409), still says it couldn't be processed.
//   S   every step ok, transcript lines, sent, jobs stale
//   JF  the same, jobs failed on the server
//   R   the same, refused by the server (409)
{
    const lm = require('./last-meeting.js');
    const c5 = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-meetings-stale-check-'));
    const Q = path.join(c5, 'upload-queue');
    fs.mkdirSync(Q);
    const cw = (name, doc) => fs.writeFileSync(path.join(c5, name), JSON.stringify(doc));
    const sentCapture = (stem, entry) => {
        cw(`manifest-${stem}.json`, { started_at: stem, tracks: [{ duration_s: 1800 }] });
        cw(`pipeline-${stem}.json`, { pipeline: 'capture', updated_at: new Date(NOW - 3600e3).toISOString(), steps: { transcribe: { state: 'ok' }, classify: { state: 'ok' }, diarize: { state: 'ok' } } });
        cw(`transcript-${stem}.json`, { segments: [{}, {}, {}] });
        fs.writeFileSync(path.join(Q, `${stem}.json`), JSON.stringify({ stem, sentAt: new Date(NOW - 3000e3).toISOString(), ...entry }));
    };
    const S = '2026-03-06T13-00-00Z', JF = '2026-03-06T14-00-00Z', R = '2026-03-06T15-00-00Z';
    sentCapture(S, { state: 'sent', lastStatus: 201, recordingId: 'rid-s', jobState: 'stale', matchPending: false });
    sentCapture(JF, { state: 'sent', lastStatus: 201, recordingId: 'rid-jf', jobState: 'failed', matchPending: false });
    sentCapture(R, { state: 'failed', lastStatus: 409, recordingId: null, jobState: null });
    const rows = Object.fromEntries(listMeetings(c5, NOW, undefined, { uploadQueueDir: Q }).map((r) => [r.stem, r]));
    const shown = (r) => JSON.stringify(r && { state: r.state, line: r.line });
    check('SAA-183: every step ok, transcript lines, sent with jobs stale -> not failed, the row says "Status unknown"',
        !!rows[S] && rows[S].state !== 'failed' && rows[S].line === 'Status unknown', shown(rows[S]));
    check('control: jobs failed on the server -> "Couldn\'t be processed"',
        !!rows[JF] && rows[JF].state === 'failed' && rows[JF].line.startsWith("Couldn't be processed"), shown(rows[JF]));
    check('control: refused by the server (409) -> "Couldn\'t be processed"',
        !!rows[R] && rows[R].state === 'failed' && rows[R].line.startsWith("Couldn't be processed"), shown(rows[R]));

    // The poll decision, driven as pollJobStates drives it: each ask at the time
    // the entry says it is next due (every 20 s when it says nothing), no reply
    // for 16 minutes, then a reply that the jobs are done.
    const has = typeof lm.jobPollStep === 'function';
    let e = { stem: S, state: 'sent', sentAt: new Date(NOW).toISOString(), recordingId: 'rid-s', jobState: null, matchPending: false };
    const end = NOW + 16 * 60e3;
    let t = NOW;
    let unanswered = 0;
    if (has) {
        for (;;) {
            const due = Date.parse(e.nextJobPollAt);
            t = Number.isFinite(due) ? due : t + 20e3;
            if (t >= end) break;
            e = lm.jobPollStep(e, { status: null, json: { error: 'ECONNREFUSED' } }, t);
            unanswered++;
        }
        e = lm.jobPollStep(e, { status: 200, json: { jobs: [{ kind: 'extract', state: 'done', attempts: 1 }] } }, end);
    }
    check('SAA-183: 16 minutes of no replies, then 200 done -> done',
        has && e.jobState === 'done', has ? `${unanswered} asks with no reply, then jobState=${e.jobState}` : '(no jobPollStep in last-meeting.js)');

    // The other half of the limit, unchanged: a server that answers on every ask
    // that the extraction is still running is given up on as stale.
    let a = { stem: S, state: 'sent', sentAt: new Date(NOW).toISOString(), recordingId: 'rid-s', jobState: null, matchPending: false };
    let gaveUp = null;
    let answered = 0;
    if (has) {
        const running = { status: 200, json: { jobs: [{ kind: 'extract', state: 'running', attempts: 1 }] } };
        for (let at = NOW + 20e3; at <= end; at += 20e3) {
            if (a.jobState === 'stale') break;
            ({ gaveUp, ...a } = lm.jobPollStep(a, running, at));
            answered++;
        }
    }
    check('SAA-183 control: 16 minutes of 200 with the extract job running on every ask -> stale, gave up on the jobs',
        has && a.jobState === 'stale' && gaveUp === 'jobs', has ? `${answered} answered asks, jobState=${a.jobState} gaveUp=${gaveUp}` : '(no jobPollStep in last-meeting.js)');
    fs.rmSync(c5, { recursive: true, force: true });
}

// ---- the tray's pipeline failure after a recovery pass (SAA-238) --------------
// main.js startRecovery, when the pass it started for a failed capture exits,
// withdraws the tray's failure if failureResolved says so. T is when the pass
// was triggered.
//   OK  the capture's record shows every step ok, and there is no recovery file
//       (the pass found nothing to re-run)
//   RR  recovery re-ran it: its recovery file says "recovered" after T, and its
//       record shows every step ok
//   BAD its record still shows a failed step, and there is no recovery file
//   NO  its record has no steps, and there is no recovery file
{
    const lm = require('./last-meeting.js');
    const c6 = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-meetings-recovery-check-'));
    const cw = (name, doc) => fs.writeFileSync(path.join(c6, name), JSON.stringify(doc));
    const T = NOW - 60e3;
    const record = (stem, steps) => cw(`pipeline-${stem}.json`, { pipeline: 'capture', updated_at: new Date(T + 30e3).toISOString(), steps });
    const allOk = { transcribe: { state: 'ok' }, classify: { state: 'ok' }, diarize: { state: 'ok' } };
    const OK = '2026-03-06T10-00-00Z', RR = '2026-03-06T11-00-00Z', BAD = '2026-03-06T12-00-00Z', NO = '2026-03-06T09-00-00Z';
    record(NO, {});
    record(OK, allOk);
    record(RR, allOk);
    cw(`recovery-${RR}.json`, { last_action: 'recovered', last_action_at: new Date(T + 30e3).toISOString() });
    record(BAD, { transcribe: { state: 'ok' }, classify: { state: 'ok' }, diarize: { state: 'failed' } });
    const has = typeof lm.failureResolved === 'function';
    const resolved = (stem) => (has ? lm.failureResolved(c6, stem, T) : '(no failureResolved in last-meeting.js)');
    check('SAA-238: a failed stem whose record shows every step ok, with no recovery file, clears on the next pass',
        resolved(OK) === true, String(resolved(OK)));
    check('control: a stem recovery actually re-ran ("recovered" after the pass began) still clears',
        resolved(RR) === true, String(resolved(RR)));
    check('control: a stem whose record still shows a failed step, with no recovery file, does not clear',
        resolved(BAD) === false, String(resolved(BAD)));
    check('control: a stem whose record has no steps, with no recovery file, does not clear',
        resolved(NO) === false, String(resolved(NO)));
    fs.rmSync(c6, { recursive: true, force: true });
}

// ---- naming settled by a one-guest answer (SAA-255 part 1) --------------------
// A call whose identity answer names exactly one guest has nothing left to name:
// that guest is the other side. Diarize can still leave naming data for it.
//   ONE  voices, an identity answer naming one guest, no voice-names
//   TWO  voices, an identity answer naming two guests, no voice-names
//   NAM  voices, an identity answer naming two guests, and a voice-names answer
//   ON1  voices, an identity answer naming one guest, and a voice-names answer
{
    const ia = require('./identity-answer.js');
    const c7 = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-meetings-naming-check-'));
    const cw = (name, doc) => fs.writeFileSync(path.join(c7, name), JSON.stringify(doc));
    const call = (stem, guests, named) => {
        cw(`manifest-${stem}.json`, { started_at: stem, tracks: [{ duration_s: 1800 }] });
        cw(`pipeline-${stem}.json`, { db_recording_id: `rid-${stem}`, updated_at: new Date(NOW - 3600e3).toISOString(), steps: { transcribe: { state: 'ok' }, ingest: { state: 'ok' }, diarize: { state: 'ok' } } });
        cw(`transcript-${stem}.json`, { segments: [{}, {}, {}] });
        cw(`voices-${stem}.json`, { voices: [{ voiceIndex: 1 }, { voiceIndex: 2 }] });
        cw(`identity-${stem}.json`, { self: { name: 'Jon Example' }, guests: guests.map((name) => ({ name })), scope: 'work' });
        if (named) cw(`voice-names-${stem}.json`, { voices: [] });
    };
    const ONE = '2026-03-05T10-00-00Z', TWO = '2026-03-05T11-00-00Z', NAM = '2026-03-05T12-00-00Z', ON1 = '2026-03-05T13-00-00Z';
    call(ONE, ['Ann Example'], false);
    call(ON1, ['Ann Example'], true);
    call(TWO, ['Ann Example', 'Bob Example'], false);
    call(NAM, ['Ann Example', 'Bob Example'], true);
    const rows = Object.fromEntries(listMeetings(c7, NOW).map((r) => [r.stem, r]));
    const tray = ia.pendingVoiceNamingStems(c7);
    const shown = (stem) => JSON.stringify({ state: rows[stem] && rows[stem].state, namingPending: rows[stem] && rows[stem].namingPending, canFix: rows[stem] && rows[stem].canFix, line: rows[stem] && rows[stem].line, inTray: tray.includes(stem) });
    check('SAA-255: voices, a one-guest identity and no voice-names -> not pending, not fixable, no tray item',
        !!rows[ONE] && rows[ONE].namingPending === false && rows[ONE].canFix === false && !/not named/.test(rows[ONE].line) && !tray.includes(ONE), shown(ONE));
    check('control: with two guests it stays pending (row and tray item)',
        !!rows[TWO] && rows[TWO].namingPending === true && rows[TWO].canFix === true && tray.includes(TWO), shown(TWO));
    check('control: with a voice-names answer it is not pending',
        !!rows[NAM] && rows[NAM].namingPending === false && !tray.includes(NAM), shown(NAM));
    check('control: a one-guest call with a voice-names answer keeps Fix names and is not pending',
        !!rows[ON1] && rows[ON1].canFix === true && rows[ON1].namingPending === false && !tray.includes(ON1), shown(ON1));
    fs.rmSync(c7, { recursive: true, force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
if (failed > 0) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
}
console.log('\nall checks passed');
