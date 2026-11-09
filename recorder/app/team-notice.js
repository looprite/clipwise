// Who accepted the recording notice, as the admin's "Team: who accepted the
// notice…" window shows it (Gate 1, item 2). The lines are made here, from what
// GET /captures/members/notice answered and this build's notice version
// (consent.js STATEMENT_VERSION); the page draws them as text and does nothing
// else with them.
//
// One line per member:
//   "<name> (<email>), <role>: accepted version <v> (current) on <YYYY-MM-DD>"
//   "<name> (<email>), <role>: not yet (last accepted version <v> on <date>)"
//   "<email>, <role>: not yet"            (no name, nothing on record)
// A member on a version below the current one is "not yet": what they agreed to
// is not what members agree to now. Dates are the UTC day the Mac recorded the
// answer, so every admin sees the same day.
//
// Split out of main.js, like consent.js, so no Electron is needed to check it.

'use strict';

const day = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '');

function memberLine(m, currentVersion) {
    const email = String((m && m.email) || '');
    const name = m && typeof m.name === 'string' && m.name.trim() ? m.name.trim() : null;
    const role = m && m.role === 'admin' ? 'admin' : 'member';
    const who = name ? `${name} (${email})` : email;
    const latest = m && Number.isInteger(m.latestVersion) ? m.latestVersion : null;
    const when = day(m && m.acceptedAt);
    if (latest !== null && latest >= currentVersion) {
        const current = latest === currentVersion ? ' (current)' : '';
        return `${who}, ${role}: accepted version ${latest}${current}${when ? ` on ${when}` : ''}`;
    }
    const last = latest !== null ? ` (last accepted version ${latest}${when ? ` on ${when}` : ''})` : '';
    return `${who}, ${role}: not yet${last}`;
}

function formatTeamNotice(members, currentVersion) {
    const list = Array.isArray(members) ? members : [];
    return {
        heading: `Current notice: version ${currentVersion}`,
        lines: list.map((m) => memberLine(m, currentVersion)),
    };
}

module.exports = { formatTeamNotice };
