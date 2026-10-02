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

fs.rmSync(dir, { recursive: true, force: true });
if (failed > 0) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
}
console.log('\nall checks passed');
