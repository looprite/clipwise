#!/usr/bin/env node
// The identity window's rules on the Mac, without a window (SAA-221, SAA-260
// step 4). What the page keeps from the server's calendar preview
// (calendarPrefillFrom); the people field the page runs (peopleField and
// friends in identity-answer.js, which identity.html requires): invitee chips,
// the large-call chip, search and typed names, the host's own name, and what
// each chip sends on Save; the answer file (buildAnswerDoc) and the name-once
// file (buildInviteeNamesDoc, writeInviteeNames); the footer and the host-name
// cache; and the voices part's rows and choices. Every rule has its control. The
// last cases read main.js, identity.html and build-app.sh as text.
//
// The step-1 checklist this file used to cover (guestList, nameInvitee and the
// known-names roster) is gone with SAA-260 step 4's window.
//
//   node check-calendar-prefill.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const ia = require('./identity-answer.js');

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
    if (!ok) failures++;
}
// For rules whose functions may not exist yet: a throw is that case's FAIL, and
// the rest still run.
function checkFn(name, fn) {
    let result;
    try {
        result = fn();
    } catch (err) {
        result = [false, `threw ${err && err.message ? err.message.split('\n')[0] : String(err)}`];
    }
    check(name, !!result[0], result[1] || '');
}
const A = 'anne@example.test';
const B = 'bob@example.test';
const HOST = 'Jon Example';
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';
const PH = '99999999-9999-4999-8999-999999999999'; // a person carrying the host's name (the backfill case)
const field = () => ia.peopleField({ hostNames: [HOST] });
const chipsOf = (f) => JSON.stringify(f.chips.map((c) => ({ name: c.name, email: c.email, personId: c.personId, tag: c.tag })));
const prefill = (named, unnamed = []) => ({ title: 'Weekly sync', named, unnamed });
const searched = (results) => ({ searched: true, results });
const OFFLINE = { searched: false, results: [] };

// --- p: what the page keeps from the reply ---------------------------------
{
    check('p: no match is no prefill', ia.calendarPrefillFrom({ matched: false, title: 'x', named: ['Ann'], unnamed: [A] }) === null);
    check('p: control: a match is a prefill', ia.calendarPrefillFrom({ matched: true, title: 'x', named: [], unnamed: [] }) !== null);
    const p = ia.calendarPrefillFrom({
        matched: true,
        title: '  Weekly sync  ',
        named: ['Ann Example', 'typed@address.test', '', 7],
        unnamed: ['Anne@Example.test', 'anne@example.test', 'no-at-sign', B],
    });
    check('p: a named entry with an @ is dropped', !p.named.includes('typed@address.test'), JSON.stringify(p));
    check('p: control: a plain name is kept', JSON.stringify(p.named) === JSON.stringify(['Ann Example']), JSON.stringify(p));
    check('p: unnamed addresses are lowercased, once each, and one with no @ is dropped',
        JSON.stringify(p.unnamed) === JSON.stringify([A, B]), JSON.stringify(p));
    check('p: the title is trimmed', p.title === 'Weekly sync', JSON.stringify(p));
}

// --- c: invitees as chips (SAA-260 step 4) -----------------------------------
checkFn('c: invitees arrive as chips tagged "invited": a named one by name, one with only an address by its address', () => {
    const f = field();
    ia.applyInvitees(f, prefill(['Ann Example'], [B]));
    const ok = f.chips.length === 2
        && f.chips[0].name === 'Ann Example' && f.chips[0].tag === 'invited' && f.chips[0].email === null
        && f.chips[1].name === null && f.chips[1].email === B && f.chips[1].tag === 'invited';
    return [ok, chipsOf(f)];
});
checkFn('c: an invitee chip with a name is sent as {name}, with no personId (the preview gives none)', () => {
    const f = field();
    ia.applyInvitees(f, prefill(['Ann Example']));
    return [JSON.stringify(ia.answerGuests(f)) === JSON.stringify([{ name: 'Ann Example' }]), JSON.stringify(ia.answerGuests(f))];
});
checkFn('c: a removed invitee chip sends nothing', () => {
    const f = field();
    ia.applyInvitees(f, prefill(['Ann Example', 'Bob Sample']));
    ia.removeChip(f, f.chips[0].id);
    return [JSON.stringify(ia.answerGuests(f)) === JSON.stringify([{ name: 'Bob Sample' }]), JSON.stringify(ia.answerGuests(f))];
});
checkFn('c: an address chip left unnamed sends nothing, in guests or inviteeNames (invited is not attended)', () => {
    const f = field();
    ia.applyInvitees(f, prefill([], [A]));
    return [ia.answerGuests(f).length === 0 && ia.inviteePairs(f).length === 0, `${JSON.stringify(ia.answerGuests(f))} ${JSON.stringify(ia.inviteePairs(f))}`];
});
checkFn('c: an address chip named with new text sends the name, and the address with it as a name-once pair', () => {
    const f = field();
    ia.applyInvitees(f, prefill([], [A]));
    ia.nameAddress(f, f.chips[0].id, ' Anne  Example ', searched([]));
    const ok = JSON.stringify(ia.answerGuests(f)) === JSON.stringify([{ name: 'Anne Example' }])
        && JSON.stringify(ia.inviteePairs(f)) === JSON.stringify([{ email: A, name: 'Anne Example' }]);
    return [ok, `${JSON.stringify(ia.answerGuests(f))} ${JSON.stringify(ia.inviteePairs(f))}`];
});
checkFn('c: an address chip given a known person sends that personId, and no name-once pair', () => {
    const f = field();
    ia.applyInvitees(f, prefill([], [A]));
    ia.nameAddress(f, f.chips[0].id, { id: P1, name: 'Anne Example' });
    const ok = JSON.stringify(ia.answerGuests(f)) === JSON.stringify([{ name: 'Anne Example', personId: P1 }]) && ia.inviteePairs(f).length === 0;
    return [ok, `${JSON.stringify(ia.answerGuests(f))} ${JSON.stringify(ia.inviteePairs(f))}`];
});
checkFn('c: a named invitee under the host\'s own name gets no chip', () => {
    const f = field();
    ia.applyInvitees(f, prefill(['jon  EXAMPLE', 'Ann Example']));
    return [f.chips.length === 1 && f.chips[0].name === 'Ann Example', chipsOf(f)];
});
checkFn('c: six invitees are six chips (control for the large call)', () => {
    const f = field();
    ia.applyInvitees(f, prefill(['N1 A', 'N2 A', 'N3 A', 'N4 A'], ['x1@example.test', 'x2@example.test']));
    return [f.chips.length === 6 && f.large === null && ia.largeCallLabel(f) === null, `${chipsOf(f)} large=${JSON.stringify(f.large)}`];
});
checkFn('c: seven invitees are one chip, "7 invited · not confirmed", and no invitee chips', () => {
    const f = field();
    ia.applyInvitees(f, prefill(['N1 A', 'N2 A', 'N3 A', 'N4 A', 'N5 A'], ['x1@example.test', 'x2@example.test']));
    return [f.chips.length === 0 && ia.largeCallLabel(f) === '7 invited · not confirmed' && ia.LARGE_CALL_INVITEES === 6,
        `${chipsOf(f)} label=${JSON.stringify(ia.largeCallLabel(f))}`];
});
checkFn('c: nothing from the large-call chip goes to guests or inviteeNames', () => {
    const f = field();
    ia.applyInvitees(f, prefill(['N1 A', 'N2 A', 'N3 A', 'N4 A', 'N5 A'], ['x1@example.test', 'x2@example.test']));
    return [ia.answerGuests(f).length === 0 && ia.inviteePairs(f).length === 0, `${JSON.stringify(ia.answerGuests(f))} ${JSON.stringify(ia.inviteePairs(f))}`];
});
checkFn('c: "Show the 7" offers each invitee as a suggestion; one added becomes an "invited" chip that is sent', () => {
    const f = field();
    ia.applyInvitees(f, prefill(['N1 A', 'N2 A', 'N3 A', 'N4 A', 'N5 A'], ['x1@example.test', 'x2@example.test']));
    const offered = ia.largeCallSuggestions(f);
    ia.addSuggestion(f, offered.find((s) => s.name === 'N2 A'));
    const ok = offered.length === 7 && f.chips.length === 1 && f.chips[0].tag === 'invited'
        && JSON.stringify(ia.answerGuests(f)) === JSON.stringify([{ name: 'N2 A' }])
        && ia.largeCallSuggestions(f).length === 6;
    return [ok, `${JSON.stringify(offered)} ${chipsOf(f)}`];
});

// --- s: search, typing, the host's own name -----------------------------------
checkFn('s: a person picked from search or Recent is sent with their personId', () => {
    const f = field();
    ia.addPerson(f, { id: P1, name: 'Ann Example' });
    return [JSON.stringify(ia.answerGuests(f)) === JSON.stringify([{ name: 'Ann Example', personId: P1 }]), JSON.stringify(ia.answerGuests(f))];
});
checkFn('s: a typed name the search did not find is tagged "new", with the spelling line under the field', () => {
    const f = field();
    ia.addTyped(f, 'Fin  Taylor', searched([{ id: P1, name: 'Fina Taylor' }]));
    const ok = f.chips.length === 1 && f.chips[0].tag === 'new' && f.chips[0].personId === null
        && ia.newNameLine(f) === 'Fin Taylor is someone new. Check the spelling before saving.';
    return [ok, `${chipsOf(f)} line=${JSON.stringify(ia.newNameLine(f))}`];
});
checkFn('s: a "new" chip is sent as {name} only', () => {
    const f = field();
    ia.addTyped(f, 'Fin Taylor', searched([]));
    return [JSON.stringify(ia.answerGuests(f)) === JSON.stringify([{ name: 'Fin Taylor' }]), JSON.stringify(ia.answerGuests(f))];
});
checkFn('s: typed while the search could not answer, a name is tagged "not checked", with no "new" line', () => {
    const f = field();
    ia.addTyped(f, 'Fin Taylor', OFFLINE);
    return [f.chips.length === 1 && f.chips[0].tag === 'not checked' && ia.newNameLine(f) === null, `${chipsOf(f)} line=${JSON.stringify(ia.newNameLine(f))}`];
});
checkFn('s: control: the same name with the search answered is "new"', () => {
    const f = field();
    ia.addTyped(f, 'Fin Taylor', searched([]));
    return [f.chips[0] && f.chips[0].tag === 'new', chipsOf(f)];
});
checkFn('s: a typed name that is exactly one search result (case, spacing, NFC aside) is that person, not "new"', () => {
    const f = field();
    ia.addTyped(f, 'jose\u0301   EXAMPLE', searched([{ id: P2, name: 'Jos\u00e9 Example' }, { id: P3, name: 'Josefa Example' }]));
    return [f.chips.length === 1 && f.chips[0].personId === P2 && f.chips[0].tag === null, chipsOf(f)];
});
checkFn('s: a typed name matching two search results is sent by name only, and is not "new"', () => {
    const f = field();
    ia.addTyped(f, 'Sam Lee', searched([{ id: P2, name: 'Sam Lee' }, { id: P3, name: 'sam lee' }]));
    const ok = f.chips.length === 1 && f.chips[0].personId === null && f.chips[0].tag === null
        && JSON.stringify(ia.answerGuests(f)) === JSON.stringify([{ name: 'Sam Lee' }]);
    return [ok, chipsOf(f)];
});
checkFn('s: one chip per person: the same name again in another case or spacing adds nothing', () => {
    const f = field();
    ia.addTyped(f, 'Fin Taylor', searched([]));
    ia.addTyped(f, '  fin   taylor ', searched([]));
    return [f.chips.length === 1, chipsOf(f)];
});
checkFn('s: picking the person a "new" chip turned out to be gives that chip the personId, still one chip', () => {
    const f = field();
    ia.addTyped(f, 'Fin Taylor', OFFLINE);
    ia.addPerson(f, { id: P1, name: 'Fin Taylor' });
    return [f.chips.length === 1 && f.chips[0].personId === P1 && f.chips[0].tag === null, chipsOf(f)];
});
checkFn('s: the host\'s own name, typed in any case, spacing or Unicode form, is refused', () => {
    const f = ia.peopleField({ hostNames: ['Jos\u00e9 Host'] });
    const r = ia.addTyped(f, 'jose\u0301 HOST', searched([]));
    return [f.chips.length === 0 && r && r.refused === 'host', `${chipsOf(f)} ${JSON.stringify(r)}`];
});
checkFn('s: a person carrying the host\'s name, picked, is refused too', () => {
    const f = field();
    const r = ia.addPerson(f, { id: PH, name: 'Jon Example' });
    return [f.chips.length === 0 && r && r.refused === 'host', `${chipsOf(f)} ${JSON.stringify(r)}`];
});
checkFn('s: control: another name is accepted', () => {
    const f = field();
    const r = ia.addTyped(f, 'Jon Exampel', searched([]));
    return [f.chips.length === 1 && r && !r.refused, `${chipsOf(f)} ${JSON.stringify(r)}`];
});
checkFn('s: suggestions leave out the host\'s name and anyone already on a chip, and keep the server\'s order', () => {
    const f = field();
    ia.addPerson(f, { id: P2, name: 'Bob Sample' });
    const got = ia.filterSuggestions(f, [{ id: PH, name: 'Jon Example' }, { id: P1, name: 'Ann Example' }, { id: P2, name: 'Bob Sample' }, { id: P3, name: 'Cy Person' }], 4);
    return [JSON.stringify(got.map((p) => p.id)) === JSON.stringify([P1, P3]), JSON.stringify(got)];
});
checkFn('s: the Recent row shows at most the limit asked for', () => {
    const f = field();
    const people = ['A', 'B', 'C', 'D', 'E', 'F'].map((n, i) => ({ id: `${i}${P1.slice(1)}`, name: `${n} Person` }));
    return [ia.filterSuggestions(f, people, 4).length === 4, String(ia.filterSuggestions(f, people, 4).length)];
});
checkFn('s: a name with an @ is refused, and blocks Save while it is typed', () => {
    const f = field();
    const r = ia.addTyped(f, 'fin@example.test', searched([]));
    return [f.chips.length === 0 && r && r.refused === 'at' && ia.saveBlocked(['fin@example.test']) === true, `${chipsOf(f)} ${JSON.stringify(r)}`];
});
checkFn('s: control: plain text does not block Save', () => [ia.saveBlocked(['Fin Taylor', '']) === false, String(ia.saveBlocked(['Fin Taylor', '']))]);
checkFn('s: a removed picked chip sends nothing', () => {
    const f = field();
    ia.addPerson(f, { id: P1, name: 'Ann Example' });
    ia.removeChip(f, f.chips[0].id);
    return [ia.answerGuests(f).length === 0, JSON.stringify(ia.answerGuests(f))];
});
checkFn('s: a chip\'s name is the normalised name (NFC, one space)', () => {
    const f = field();
    ia.addTyped(f, '  Jose\u0301    Example ', searched([]));
    return [f.chips[0] && f.chips[0].name === 'Jos\u00e9 Example', chipsOf(f)];
});

// --- a: the answer file --------------------------------------------------------
checkFn('a: guests carry personId where the chip has one', () => {
    const doc = ia.buildAnswerDoc({ stem: 's', recordingId: 'r', guests: [{ name: 'Ann Example', personId: P1 }, { name: 'Fin Taylor' }], selfName: HOST, scope: 'work' });
    return [JSON.stringify(doc.guests) === JSON.stringify([{ name: 'Ann Example', personId: P1 }, { name: 'Fin Taylor' }]), JSON.stringify(doc.guests)];
});
checkFn('a: a personId that is not a uuid is not sent (the server refuses a capture carrying one); the name is', () => {
    const doc = ia.buildAnswerDoc({ stem: 's', recordingId: 'r', guests: [{ name: 'Ann Example', personId: 'p1' }], selfName: HOST, scope: 'work' });
    return [JSON.stringify(doc.guests) === JSON.stringify([{ name: 'Ann Example' }]), JSON.stringify(doc.guests)];
});
checkFn('a: the host name comes from the account: self.source is account_display_name', () => {
    const doc = ia.buildAnswerDoc({ stem: 's', recordingId: 'r', guests: [], selfName: HOST, scope: 'work' });
    return [doc.self.name === HOST && doc.self.source === 'account_display_name', JSON.stringify(doc.self)];
});
checkFn('a: with no name known, self.name and self.source are null', () => {
    const doc = ia.buildAnswerDoc({ stem: 's', recordingId: 'r', guests: [], selfName: null, scope: 'work' });
    return [doc.self.name === null && doc.self.source === null, JSON.stringify(doc.self)];
});
checkFn('a: a guest or self name with an @ is dropped, and the whole doc holds no @', () => {
    const doc = ia.buildAnswerDoc({ stem: 's', recordingId: 'r', guests: [{ name: 'Ann Example' }, { name: 'typed@address.test', personId: P1 }], selfName: 'me@example.test', scope: 'work' });
    const ok = JSON.stringify(doc.guests) === JSON.stringify([{ name: 'Ann Example' }]) && doc.self.name === null && !JSON.stringify(doc).includes('@');
    return [ok, JSON.stringify(doc)];
});
checkFn('a: control: the same scan finds an @ planted in a copy', () => {
    const doc = ia.buildAnswerDoc({ stem: 's', recordingId: 'r', guests: [{ name: 'Ann Example' }], selfName: HOST, scope: 'work' });
    return [JSON.stringify({ ...doc, planted: 'x@y' }).includes('@'), ''];
});
{
    const saved = { guests: [{ name: 'Ann Example', personId: P1 }, { name: 'Bob Sample' }, { name: 'Cy Person', personId: P3 }], scope: 'work' };
    checkFn('a: the same people in another order, spelled with other case or spacing, are no change (guests compared as a set)', () => {
        const got = ia.answerChanged(saved, [{ name: 'Cy Person', personId: P3 }, { name: ' bob  sample ' }, { name: 'Ann Example', personId: P1 }], 'work');
        return [got === false, String(got)];
    });
    checkFn('a: control: one person differing is a change: a name, a personId, one added, one removed, or the scope', () => {
        const got = [
            ia.answerChanged(saved, [{ name: 'Ann Example', personId: P1 }, { name: 'Bob Sampler' }, { name: 'Cy Person', personId: P3 }], 'work'),
            ia.answerChanged(saved, [{ name: 'Ann Example', personId: P2 }, { name: 'Bob Sample' }, { name: 'Cy Person', personId: P3 }], 'work'),
            ia.answerChanged(saved, [...saved.guests, { name: 'Dana Lee' }], 'work'),
            ia.answerChanged(saved, saved.guests.slice(0, 2), 'work'),
            ia.answerChanged(saved, saved.guests, 'personal'),
        ];
        return [JSON.stringify(got) === JSON.stringify([true, true, true, true, true]), JSON.stringify(got)];
    });
}
checkFn('a: the footer reads "Recorded by <name> (you)", and "Recorded by you" with no name or an address', () => {
    const got = [ia.recordedByLine(HOST), ia.recordedByLine(null), ia.recordedByLine('jd@example.test')];
    return [JSON.stringify(got) === JSON.stringify(['Recorded by Jon Example (you)', 'Recorded by you', 'Recorded by you']), JSON.stringify(got)];
});
checkFn('a: the host name is the account\'s when GET /captures/me answers, else the cached one, else none', () => {
    const got = [
        ia.selfNameFrom({ displayName: 'Jon Account' }, 'Jon Cached'),
        ia.selfNameFrom(null, 'Jon Cached'),
        ia.selfNameFrom(null, null),
        ia.selfNameFrom({ displayName: null }, 'Jon Cached'),
    ];
    return [JSON.stringify(got) === JSON.stringify(['Jon Account', 'Jon Cached', null, 'Jon Cached']), JSON.stringify(got)];
});

// --- i: the name-once file ----------------------------------------------------
{
    const doc = ia.buildInviteeNamesDoc({
        stem: 'S',
        recordingId: 'R',
        allowed: [A, B],
        pairs: [
            { email: 'Anne@Example.test', name: ' Anne Example ' },
            { email: A, name: 'Second Spelling' },
            { email: B, name: 'bob@typed.test' },
            { email: 'stranger@example.test', name: 'Not Offered' },
            { email: B, name: '' },
            { email: B, name: 'x'.repeat(257) },
        ],
    });
    check('i: kept: an offered address, lowercased, with its trimmed name, once',
        JSON.stringify(doc.invitees) === JSON.stringify([{ email: A, name: 'Anne Example' }]), JSON.stringify(doc.invitees));
    const ok = ia.buildInviteeNamesDoc({ stem: 'S', recordingId: 'R', allowed: [B], pairs: [{ email: B, name: 'Bob Example' }] });
    check('i: control: the same address shape with a plain name is kept (the @ name, empty name and 257-char name above were not)',
        ok.invitees.length === 1, JSON.stringify(ok.invitees));
    check('i: a pair for an address the preview did not offer is dropped',
        !doc.invitees.some((p) => p.email === 'stranger@example.test'), JSON.stringify(doc.invitees));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-check-calendar-prefill-'));
    const STEM = '2026-10-26T18-00-00Z';
    const written = ia.writeInviteeNames(dir, { ...doc, stem: STEM });
    check('i: written to invitee-names-<stem>.json', path.basename(written) === `invitee-names-${STEM}.json`, written);
    check('i: read back as written', JSON.stringify(ia.readInviteeNames(dir, STEM).invitees) === JSON.stringify(doc.invitees));
    ia.writeAnswer(dir, ia.buildAnswerDoc({ stem: STEM, recordingId: 'R', guests: [{ name: 'Carl Guest' }], selfName: 'Jon Example', scope: 'work' }));
    const identityText = fs.readFileSync(path.join(dir, `identity-${STEM}.json`), 'utf8');
    check('i: the identity file beside it holds no @ and no typed invitee name',
        !identityText.includes('@') && !identityText.includes('Anne Example'), identityText);
    check('i: control: the invitee file does hold the address', fs.readFileSync(written, 'utf8').includes(A));
    check('i: control: the identity file holds the guest it was given (SAA-260 step 4: guests as objects)', identityText.includes('Carl Guest'), identityText);
    fs.rmSync(dir, { recursive: true, force: true });
}

// --- v: the voices part --------------------------------------------------------
const naming = (n) => ({ voices: Array.from({ length: n }, (_, i) => ({ voiceIndex: i + 1, clipPaths: [`/c/${i + 1}.wav`], lines: [] })) });
const diarize = (secs) => ({ voices: secs.map((s, i) => ({ voiceIndex: i + 1, totalSeconds: s })) });
checkFn('v: the voices part shows for two or more voices, and not for one or none', () => {
    const got = [ia.showVoicesPart(naming(2)), ia.showVoicesPart(naming(1)), ia.showVoicesPart(null)];
    return [JSON.stringify(got) === JSON.stringify([true, false, false]), JSON.stringify(got)];
});
checkFn('v: rows are longest first with their talk time; past two, the rest are behind "Show them"', () => {
    const r = ia.voiceRows(naming(4), diarize([45, 1080, 30, 660]), 2);
    const ok = JSON.stringify(r.rows.map((x) => [x.voiceIndex, x.talk])) === JSON.stringify([[2, '18 min'], [4, '11 min']]) && r.hidden === 2;
    return [ok, JSON.stringify(r)];
});
checkFn('v: control: with every row shown, nothing is hidden and short talk reads in seconds', () => {
    const r = ia.voiceRows(naming(4), diarize([45, 1080, 30, 660]), 4);
    return [r.rows.length === 4 && r.hidden === 0 && r.rows[3].talk === '30 sec', JSON.stringify(r)];
});
checkFn('v: a voice\'s choices are the named chips, then "Leave unnamed" and "Add someone…"', () => {
    const f = field();
    ia.applyInvitees(f, prefill(['Ann Example'], [B]));
    ia.addPerson(f, { id: P1, name: 'Cy Person' });
    const got = ia.voiceOptions(f);
    return [JSON.stringify(got) === JSON.stringify(['Ann Example', 'Cy Person', 'Leave unnamed', 'Add someone…']), JSON.stringify(got)];
});
checkFn('v: a name chosen for a second voice moves to it; the first is left unnamed', () => {
    const choices = new Map([[1, 'Ann Example'], [2, null]]);
    ia.chooseVoice(choices, 2, 'ann example');
    return [choices.get(1) === null && choices.get(2) === 'ann example', JSON.stringify([...choices])];
});
{
    // Shaped like voice-clips.ts NamingData: { recording_id, stem, generated_at,
    // voices: [{ voiceIndex, clipPaths, lines: [{ text, start, end }] }] }.
    const typed = () => ({
        recording_id: 'r', stem: 's', generated_at: '2026-11-01T15:40:00.000Z',
        voices: [
            { voiceIndex: 1, clipPaths: ['/c/1a.wav', '/c/1b.wav'], lines: [{ text: 'the first long line', start: 12.48, end: 19.5 }, { text: 'the second', start: 301, end: 306.125 }] },
            { voiceIndex: 2, clipPaths: ['/c/2a.wav'], lines: [{ text: 'voice two speaking', start: 0, end: 4.25 }] },
        ],
    });
    checkFn('v: namingDataForPage keeps each voice\'s voiceIndex, clipPaths and lines, and each line\'s text, start and end unchanged', () => {
        const src = typed();
        const out = ia.namingDataForPage(src);
        const want = { voices: src.voices.map((v) => ({ voiceIndex: v.voiceIndex, clipPaths: v.clipPaths, lines: v.lines })) };
        return [JSON.stringify(out) === JSON.stringify(want), JSON.stringify(out)];
    });
    checkFn('v: control: an embedding planted on a voice, on a line and at the top is dropped, and the rest still comes through', () => {
        const src = typed();
        src.embedding = [0.5, 0.25];
        src.voices[0].embedding = [0.1, 0.2, 0.3];
        src.voices[1].lines[0].embedding = [0.9];
        const planted = JSON.stringify(src).includes('embedding');
        const out = ia.namingDataForPage(src);
        const text = JSON.stringify(out);
        const ok = planted && !text.includes('embedding')
            && out.voices[0].lines[1].start === 301 && out.voices[0].lines[1].end === 306.125
            && out.voices[1].lines[0].start === 0 && out.voices[1].lines[0].end === 4.25;
        return [ok, `planted=${planted} ${text}`];
    });
}
checkFn('v: the voice-names answer names each voice or leaves it null, nothing guessed', () => {
    const doc = ia.buildVoiceNamesDoc({ stem: 's', recordingId: 'r', voices: [{ voiceIndex: 1, name: 'Ann Example' }, { voiceIndex: 2, name: null }] });
    return [JSON.stringify(doc.voices) === JSON.stringify([{ voiceIndex: 1, name: 'Ann Example' }, { voiceIndex: 2, name: null }]), JSON.stringify(doc.voices)];
});

// --- t: text checks ---------------------------------------------------------
{
    const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, 'identity.html'), 'utf8');
    const build = fs.readFileSync(path.join(__dirname, 'build-app.sh'), 'utf8');
    const calls = main.split('\n').filter((l) => /requestCalendarPreview\(/.test(l) && !/^\s*(function|\/\/)/.test(l));
    check('t: main.js asks for a preview from one place only (promptForIdentity, at stop)',
        calls.length === 1 && /requestCalendarPreview\(queued\)/.test(calls[0]), calls.join(' | '));
    const fnStart = html.indexOf('function applyCalendar(');
    const fnEnd = html.indexOf("ipcRenderer.on('identity:calendar'", fnStart);
    const applyText = fnStart >= 0 && fnEnd > fnStart ? html.slice(fnStart, fnEnd) : '';
    check('t: identity.html applyCalendar never touches scope', applyText.length > 0 && !/scope/i.test(applyText), `${applyText.length} chars`);
    check('t: control: identity.html does handle scope elsewhere', /selectedScope\(\)/.test(html));
    check('t: build-app.sh copies identity-answer.js beside identity.html (the page requires it)',
        build.includes('cp "$APP_SRC/identity-answer.js" "$C/Resources/app/identity-answer.js"')
        && build.includes('cp "$APP_SRC/identity.html" "$C/Resources/app/identity.html"'));
    check('t: build-app.sh copies people-name.js beside them (identity-answer.js requires it)',
        build.includes('cp "$APP_SRC/people-name.js" "$C/Resources/app/people-name.js"'));
    check('t: identity.html sends inviteeNames from the people field, outside the identity answer fields',
        /inviteeNames: ia\.inviteePairs\(field\)/.test(html));
    check('t: identity.html sends guests from the people field', /guests: ia\.answerGuests\(field\)/.test(html));
    check('t: the old checklist is gone: no knownNames in main.js or identity.html, no knownGuestNames export',
        !/knownNames/.test(main) && !/knownNames/.test(html) && typeof ia.knownGuestNames === 'undefined');
    check('t: control: the same scan finds knownNames planted in a copy of main.js', /knownNames/.test(`${main}\nknownNames: []`));
    check('t: the host field is gone from identity.html', !/id="self"/.test(html));
    check('t: identity.html has no "Voice 1 is you"', !/Voice 1 is you/.test(html));
    check('t: IDENTITY_WINDOW is 460 wide, 220 to 600 high',
        JSON.stringify(ia.IDENTITY_WINDOW) === JSON.stringify({ width: 460, minHeight: 220, maxHeight: 600 }), JSON.stringify(ia.IDENTITY_WINDOW));
}

console.log(failures === 0 ? '\ncheck-calendar-prefill: all passed' : `\ncheck-calendar-prefill: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
