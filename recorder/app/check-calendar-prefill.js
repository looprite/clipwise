#!/usr/bin/env node
// The calendar prefill's rules on the Mac (SAA-221), without a window: what the
// page keeps from the server's preview (calendarPrefillFrom), the step 1 guest
// list the page runs (guestList and friends in identity-answer.js, which
// identity.html requires), the name-once file (buildInviteeNamesDoc,
// writeInviteeNames) and the @ backstop in buildAnswerDoc. Every rule has its
// control. The last cases read main.js, identity.html and build-app.sh as text.
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
const show = (list) => JSON.stringify({
    boxes: list.boxes.map((b) => `${b.checked ? '[x]' : '[ ]'} ${b.name}`),
    entries: ia.inviteeEntries(list),
});
const boxNamed = (list, name) => list.boxes.filter((b) => b.name.toLowerCase() === name.toLowerCase());
const A = 'anne@example.test';
const B = 'bob@example.test';

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

// --- g: preselection, and any touch cancelling it -----------------------------
{
    const untouched = ia.guestList(['Ann Example', 'Carl Known'], []);
    ia.applyCalendarNames(untouched, ['ann example', 'Dee New']);
    check('g: untouched: a named invitee with a known box checks that box (case-insensitive)',
        boxNamed(untouched, 'Ann Example').length === 1 && boxNamed(untouched, 'Ann Example')[0].checked, show(untouched));
    check('g: untouched: a named invitee with no box gets one, checked',
        boxNamed(untouched, 'Dee New').length === 1 && boxNamed(untouched, 'Dee New')[0].checked, show(untouched));
    check('g: a known box the calendar does not name stays unchecked',
        !boxNamed(untouched, 'Carl Known')[0].checked, show(untouched));

    const touches = {
        'checking a box': (l) => ia.setGuestChecked(l, 'Carl Known', true),
        'typing in "Someone new?"': (l) => ia.touchGuests(l),
        'naming an invitee': (l) => ia.nameInvitee(l, B, 'Bob Example'),
    };
    for (const [how, touch] of Object.entries(touches)) {
        const l = ia.guestList(['Ann Example', 'Carl Known'], []);
        touch(l);
        ia.applyCalendarNames(l, ['Ann Example', 'Dee New']);
        check(`g: after ${how}, the calendar checks nothing it names`,
            !boxNamed(l, 'Ann Example')[0].checked && !boxNamed(l, 'Dee New')[0].checked, show(l));
        check(`g: after ${how}, a named invitee with no box still gets one, unchecked`,
            boxNamed(l, 'Dee New').length === 1, show(l));
    }
}

// --- n: name-once ----------------------------------------------------------
{
    // A typo corrected.
    const l = ia.guestList([], []);
    ia.nameInvitee(l, A, 'Anne Exmaple');
    ia.nameInvitee(l, A, 'Anne Example');
    check('n: a typo corrected leaves one checked box, renamed in place, not two',
        l.boxes.length === 1 && l.boxes[0].name === 'Anne Example' && l.boxes[0].checked, show(l));
    check('n: the entry holds the corrected name', JSON.stringify(ia.inviteeEntries(l)) === JSON.stringify([{ email: A, name: 'Anne Example' }]), show(l));
    const two = ia.guestList([], []);
    ia.nameInvitee(two, A, 'Anne Exmaple');
    ia.nameInvitee(two, B, 'Anne Example');
    check('n: control: the same two names on two addresses give two boxes', two.boxes.length === 2, show(two));
}
{
    // Retyped to a name that already has its own box.
    const l = ia.guestList(['Ann Known'], []);
    ia.nameInvitee(l, A, 'Ann Knwn');
    ia.nameInvitee(l, A, 'Ann Known');
    check('n: retyped to a known name: the created box goes and the known box is checked',
        l.boxes.length === 1 && l.boxes[0].name === 'Ann Known' && l.boxes[0].checked, show(l));
    ia.nameInvitee(l, A, '');
    check('n: control: clearing it then leaves the known box (a box from before is never removed)',
        boxNamed(l, 'Ann Known').length === 1, show(l));
}
{
    // Clearing.
    const l = ia.guestList(['Carl Known'], []);
    ia.nameInvitee(l, A, 'Anne Example');
    ia.nameInvitee(l, A, '');
    check('n: clearing removes the entry and the box it created',
        ia.inviteeEntries(l).length === 0 && boxNamed(l, 'Anne Example').length === 0, show(l));
    check('n: control: clearing leaves the box from before alone', boxNamed(l, 'Carl Known').length === 1, show(l));
}
{
    // Unchecking keeps the entry.
    const l = ia.guestList([], []);
    ia.nameInvitee(l, A, 'Anne Example');
    check('n: control: once typed, the name is a guest', ia.checkedGuestNames(l).includes('Anne Example'), show(l));
    ia.setGuestChecked(l, 'Anne Example', false);
    check('n: unchecking takes them out of the guests', !ia.checkedGuestNames(l).includes('Anne Example'), show(l));
    check('n: unchecking keeps the name-once entry', JSON.stringify(ia.inviteeEntries(l)) === JSON.stringify([{ email: A, name: 'Anne Example' }]), show(l));
    check('n: unchecking keeps the box', boxNamed(l, 'Anne Example').length === 1, show(l));
    ia.nameInvitee(l, A, 'Anne Example');
    check('n: committing the same name again (Save) leaves the box unchecked', !boxNamed(l, 'Anne Example')[0].checked, show(l));
    ia.nameInvitee(l, A, 'Anne Example-Smith');
    check('n: control: a different name checks it again', boxNamed(l, 'Anne Example-Smith')[0]?.checked === true, show(l));
}
{
    // Two addresses given the same new name.
    const l = ia.guestList([], []);
    ia.nameInvitee(l, A, 'Sam Shared');
    ia.nameInvitee(l, B, 'Sam Shared');
    ia.nameInvitee(l, A, '');
    check('n: two addresses, one name: clearing one keeps the box (the other entry now owns it)',
        boxNamed(l, 'Sam Shared').length === 1 && l.entries.get(B).created === boxNamed(l, 'Sam Shared')[0], show(l));
    ia.nameInvitee(l, B, '');
    check('n: clearing the other then removes it', boxNamed(l, 'Sam Shared').length === 0, show(l));
    const one = ia.guestList([], []);
    ia.nameInvitee(one, A, 'Sam Shared');
    ia.nameInvitee(one, A, '');
    check('n: control: with no second entry, clearing removes the box at once', one.boxes.length === 0, show(one));
    const ren = ia.guestList([], []);
    ia.nameInvitee(ren, A, 'Sam Shared');
    ia.nameInvitee(ren, B, 'Sam Shared');
    ia.nameInvitee(ren, A, 'Sam Other');
    check('n: two addresses, one name: retyping one does not rename the box under the other',
        boxNamed(ren, 'Sam Shared').length === 1 && boxNamed(ren, 'Sam Other').length === 1, show(ren));
}
{
    // A name with an @.
    const l = ia.guestList([], []);
    ia.nameInvitee(l, A, 'anne@example.test');
    check('n: a name with an @ records nothing and adds no box', l.entries.size === 0 && l.boxes.length === 0, show(l));
    ia.nameInvitee(l, A, 'Anne Example');
    check('n: control: a plain name for the same address records an entry', l.entries.size === 1, show(l));
    ia.nameInvitee(l, A, 'x@y');
    check('n: an @ name after a plain one leaves the entry as it was', ia.inviteeEntries(l)[0].name === 'Anne Example', show(l));
}
{
    // A box from before: its state is restored.
    const corrected = ia.guestList(['Ann Known'], []);
    ia.nameInvitee(corrected, A, 'Ann Known');
    check('n: typing a known unchecked name checks its box', boxNamed(corrected, 'Ann Known')[0].checked, show(corrected));
    ia.nameInvitee(corrected, A, 'Anne Example');
    check('n: then correcting it leaves the known box unchecked again', !boxNamed(corrected, 'Ann Known')[0].checked, show(corrected));
    const cleared = ia.guestList(['Ann Known'], []);
    ia.nameInvitee(cleared, A, 'Ann Known');
    ia.nameInvitee(cleared, A, '');
    check('n: typing a known unchecked name then clearing it leaves the box unchecked', !boxNamed(cleared, 'Ann Known')[0].checked, show(cleared));
    const wasOn = ia.guestList(['Ann Known'], ['Ann Known']);
    ia.nameInvitee(wasOn, A, 'Ann Known');
    ia.nameInvitee(wasOn, A, 'Anne Example');
    check('n: control: a known box checked before stays checked after a correction', boxNamed(wasOn, 'Ann Known')[0].checked, show(wasOn));
    const wasOn2 = ia.guestList(['Ann Known'], ['Ann Known']);
    ia.nameInvitee(wasOn2, A, 'Ann Known');
    ia.nameInvitee(wasOn2, A, '');
    check('n: control: a known box checked before stays checked after clearing', boxNamed(wasOn2, 'Ann Known')[0].checked, show(wasOn2));
    const toggled = ia.guestList(['Ann Known'], []);
    ia.nameInvitee(toggled, A, 'Ann Known');
    ia.setGuestChecked(toggled, 'Ann Known', false);
    ia.setGuestChecked(toggled, 'Ann Known', true);
    ia.nameInvitee(toggled, A, '');
    check('n: toggled by the member since, the box is left as they set it (checked)', boxNamed(toggled, 'Ann Known')[0].checked, show(toggled));
    check('n: control: untoggled, the same clear unchecks it (cleared case above)', !boxNamed(cleared, 'Ann Known')[0].checked);
    const both = ia.guestList(['Ann Known'], []);
    ia.nameInvitee(both, A, 'Ann Known');
    ia.nameInvitee(both, B, 'Ann Known');
    ia.nameInvitee(both, A, '');
    check('n: two entries on one known box: clearing one keeps it checked for the other', boxNamed(both, 'Ann Known')[0].checked, show(both));
    ia.nameInvitee(both, B, '');
    check('n: clearing both restores the state from before the first (unchecked)', !boxNamed(both, 'Ann Known')[0].checked, show(both));
}

// --- b: the @ backstop in the identity file ---------------------------------
{
    const doc = ia.buildAnswerDoc({ stem: 's', recordingId: 'r', names: ['Ann Example', 'typed@address.test'], selfName: 'me@example.test', scope: 'work' });
    check('b: a guest name with an @ is dropped', JSON.stringify(doc.guests) === JSON.stringify([{ name: 'Ann Example' }]), JSON.stringify(doc));
    check('b: a self name with an @ is dropped, with no source', doc.self.name === null && doc.self.source === null, JSON.stringify(doc));
    const plain = ia.buildAnswerDoc({ stem: 's', recordingId: 'r', names: ['Ann Example'], selfName: 'Jon Example', scope: 'work' });
    check('b: control: a plain self name is kept', plain.self.name === 'Jon Example' && plain.self.source === 'recorder_identity_prompt', JSON.stringify(plain));
    check('b: the whole identity doc holds no @', !JSON.stringify(doc).includes('@'), JSON.stringify(doc));
    check('b: control: the same scan finds an @ planted in a copy', JSON.stringify({ ...doc, planted: 'x@y' }).includes('@'));
}

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
    ia.writeAnswer(dir, ia.buildAnswerDoc({ stem: STEM, recordingId: 'R', names: ['Carl Guest'], selfName: 'Jon Example', scope: 'work' }));
    const identityText = fs.readFileSync(path.join(dir, `identity-${STEM}.json`), 'utf8');
    check('i: the identity file beside it holds no @ and no typed invitee name',
        !identityText.includes('@') && !identityText.includes('Anne Example'), identityText);
    check('i: control: the invitee file does hold the address', fs.readFileSync(written, 'utf8').includes(A));
    const known = ia.knownGuestNames(dir);
    check('i: the known-names roster does not read the invitee file', !known.includes('Anne Example'), JSON.stringify(known));
    check('i: control: it does read the identity file beside it', known.includes('Carl Guest'), JSON.stringify(known));
    fs.rmSync(dir, { recursive: true, force: true });
}

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
    check('t: identity.html sends inviteeNames from the guest list, outside the identity answer fields',
        /inviteeNames: ia\.inviteeEntries\(list\)/.test(html));
    check('t: build-app.sh copies identity-answer.js beside identity.html (the page requires it)',
        build.includes('cp "$APP_SRC/identity-answer.js" "$C/Resources/app/identity-answer.js"')
        && build.includes('cp "$APP_SRC/identity.html" "$C/Resources/app/identity.html"'));
}

console.log(failures === 0 ? '\ncheck-calendar-prefill: all passed' : `\ncheck-calendar-prefill: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
