// Who accepted the recording notice, as the admin's "Team: who accepted the
// notice…" window shows it (Gate 1, item 2). The lines are made here, from what
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
    return {
        heading: updated ? `Current notice: updated ${updated}` : 'Current notice',
        lines: list.map((m) => memberLine(m, currentVersion)),
    };
}

module.exports = { formatTeamNotice, longDay };
