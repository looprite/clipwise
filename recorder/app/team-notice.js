// The admin's "Team members…" window (Gate 1, item 2; SAA-348): who accepted
// the recording notice, and Add and Remove. The lines are made here, from what
// GET /captures/members/notice answered, this build's notice version
// (consent.js STATEMENT_VERSION) and the day that version was published
// (consent.js NOTICE_UPDATED); the page draws them as text and does nothing
// else with them.
//
// Dates, not version numbers (SAA-285, wording decided 2026-11-10). The
// version number stays in the database and decides which line a member gets:
//   heading  "Current notice: updated <Mon D, YYYY>"
//   current  "<name> (<role>) — accepted <Mon D, YYYY>"
//   older    "<name> (<role>) — accepted an earlier notice; will be asked again at next start"
//   none     "<name> (<role>) — hasn't accepted yet; will be asked at next start"
//   newer    "<name> (<role>) — accepted a newer notice"   (a newer build's answer)
// <name> is the email when no name is on record. Dates are the UTC day the Mac
// recorded the answer, so every admin sees the same day, in fixed English
// month names, so they do not depend on the Mac's language.
//
// Add and Remove (SAA-348) go through POST /captures/members and
// POST /captures/members/remove. What the page may send is checked here
// (addPayload, removePayload), and what the window says about each answer is
// written here: the confirmation before Remove (removeDialog), the line after
// an add (addedMessage), the removal report (removalLines) and each refusal
// (refusalMessage). The server's report carries ids and counts, never an
// address, so the address in these lines is the one the admin sent.
//
// Split out of main.js, like consent.js, so no Electron is needed to check it.

'use strict';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-11-10…" -> "Nov 10, 2026"; anything else -> ''.
function longDay(iso) {
    const m = typeof iso === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return '';
    return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

function memberLine(m, currentVersion) {
    const email = String((m && m.email) || '');
    const name = m && typeof m.name === 'string' && m.name.trim() ? m.name.trim() : null;
    const role = m && m.role === 'admin' ? 'admin' : 'member';
    const who = `${name || email} (${role})`;
    const latest = m && Number.isInteger(m.latestVersion) ? m.latestVersion : null;
    if (latest === null) return `${who} — hasn't accepted yet; will be asked at next start`;
    if (latest > currentVersion) return `${who} — accepted a newer notice`;
    if (latest < currentVersion) return `${who} — accepted an earlier notice; will be asked again at next start`;
    const when = longDay(m && m.acceptedAt);
    return `${who} — accepted${when ? ` ${when}` : ''}`;
}

// updatedOn: the day this version was published, "YYYY-MM-DD".
function formatTeamNotice(members, currentVersion, updatedOn) {
    const list = Array.isArray(members) ? members : [];
    const updated = longDay(updatedOn);
    const lines = list.map((m) => memberLine(m, currentVersion));
    return {
        heading: updated ? `Current notice: updated ${updated}` : 'Current notice',
        lines,
        // The same lines with each member's email, for the row's Remove button.
        rows: list.map((m, i) => ({ line: lines[i], email: String((m && m.email) || '') })),
    };
}

const ROLES = ['member', 'admin'];
const isPlainObject = (p) => !!p && typeof p === 'object' && !Array.isArray(p) && Object.getPrototypeOf(p) === Object.prototype;

// Add: exactly { email, role }, the email a non-empty string (trimmed), the role
// "member" or "admin"; anything else is null and nothing is sent. Whether the
// email is an address is the server's to say (400 invalid_email).
function addPayload(p) {
    if (!isPlainObject(p) || Object.keys(p).sort().join(',') !== 'email,role') return null;
    if (typeof p.email !== 'string' || !p.email.trim() || !ROLES.includes(p.role)) return null;
    return { email: p.email.trim(), role: p.role };
}

// Remove: exactly { email }, a non-empty string (trimmed).
function removePayload(p) {
    if (!isPlainObject(p) || Object.keys(p).join(',') !== 'email') return null;
    if (typeof p.email !== 'string' || !p.email.trim()) return null;
    return { email: p.email.trim() };
}

// The confirmation main.js shows before any removal. Cancel is the default.
function removeDialog(email) {
    return {
        type: 'warning',
        message: `Remove ${email} from your team?`,
        detail: [
            "This changes your live team now, and it can't be undone.",
            '',
            'Deleted: their sign-ins on every Mac and in Claude; their personal calls, the calls in their trash and their demo calls; and their calendar connection. Clipwise also asks Google to end its calendar access.',
            '',
            'Kept: their work calls and their calls not yet labelled, which stay with the team.',
            '',
            "This address can't be added to the team again.",
        ].join('\n'),
        buttons: ['Cancel', 'Remove'],
        defaultId: 0,
        cancelId: 0,
    };
}

function addedMessage(email, added) {
    return `Added ${email} as ${added && added.role === 'admin' ? 'an admin' : 'a member'}.`;
}

function refusalMessage(email, status, code) {
    if (status === null || status === undefined) return 'No answer from the server. Check the list to see whether it went through.';
    const words = {
        '403 admin_only': 'Only an admin of your team can do this.',
        '400 invalid_email': `"${email}" isn't an email address.`,
        '400 invalid_request': 'That address is too long.',
        '404 not_a_member': `${email} isn't on your team.`,
        '409 already_member': `${email} is already on your team.`,
        '409 member_removed': `${email} was removed from your team earlier and can't be added again.`,
        '409 already_removed': `${email} has already been removed.`,
        '409 cannot_remove_self': "You can't remove yourself. Another admin can.",
        '409 last_admin': `${email} is your team's only admin. Add another admin first.`,
    };
    return words[`${status} ${code}`] || `Something went wrong (server ${status}). Check the list to see whether it went through.`;
}

const GOOGLE = {
    revoked: "Clipwise's calendar access ended at Google.",
    already_invalid: "Clipwise's calendar access had already ended at Google.",
    refused: "Google refused to end Clipwise's calendar access.",
    unreachable: "Google couldn't be reached to end Clipwise's calendar access.",
    not_attempted: "Clipwise's calendar access couldn't be ended from here.",
};

// The removal report (server auth/members.ts RemovalReport) in plain lines. The
// server's adminNote, when there is one, is shown as written: it carries the
// Third-party apps line.
function removalLines(email, report) {
    const r = report && typeof report === 'object' ? report : {};
    const n = (x) => (Number.isInteger(x) && x >= 0 ? x : 0);
    const calls = (x) => `${x} call${x === 1 ? '' : 's'}`;
    const d = r.deleted || {};
    const k = r.kept || {};
    const v = r.revoked || {};
    const google = r.calendar && Array.isArray(r.calendar.google) ? r.calendar.google : [];
    const lines = [
        `Removed ${email}.`,
        `Deleted ${calls(n(d.recordings))}: ${n(d.personal)} personal, ${n(d.trashed)} in the trash, ${n(d.demo)} demo.`,
        `Kept ${calls(n(k.work) + n(k.unlabelled))} for the team: ${n(k.work)} work, ${n(k.unlabelled)} not labelled.`,
        n(v.sessions) + n(v.accessTokens) + n(v.refreshTokens) > 0 ? 'Signed out of Clipwise everywhere.' : "They weren't signed in anywhere.",
    ];
    if (google.length === 0) lines.push('No calendar was connected.');
    google.forEach((g, i) => {
        const what = GOOGLE[g && g.outcome] || "Google didn't confirm that Clipwise's calendar access ended.";
        lines.push(google.length > 1 ? `Calendar ${i + 1}: ${what}` : what);
    });
    if (typeof r.adminNote === 'string' && r.adminNote.trim()) lines.push(r.adminNote.trim());
    return lines;
}

module.exports = { formatTeamNotice, longDay, addPayload, removePayload, removeDialog, addedMessage, refusalMessage, removalLines };
