// Day logs (recorder-YYYY-MM-DD.log) are kept for 30 days (SAA-243 item 7).
// main.js runs this at launch and once a day.

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 30;
const DAY_LOG = /^recorder-(\d{4})-(\d{2})-(\d{2})\.log$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// A calendar date as a day number, so the difference between two is a whole
// number of days whatever the clocks did in between (a 23- or 25-hour day at a
// daylight-saving change cannot move the boundary).
function dayNumber(year, monthIndex, day) {
    return Date.UTC(year, monthIndex, day) / DAY_MS;
}

// The day log's own date, from its name, or null when the name is not a day
// log or its date does not exist (recorder-2026-02-31.log).
function dayLogDate(name) {
    const m = DAY_LOG.exec(name);
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    const t = new Date(Date.UTC(y, mo, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo || t.getUTCDate() !== d) return null;
    return dayNumber(y, mo, d);
}

// Removes every day log in `dir` dated more than KEEP_DAYS days before `now`'s
// local date: the file's name says which day it is (main.js names it by the
// local date), and nothing else is looked at. A file that cannot be removed is
// counted by its error code and the rest are still handled.
// -> { removed, failed: [code, ...] }
function pruneDayLogs(dir, now = new Date()) {
    const today = dayNumber(now.getFullYear(), now.getMonth(), now.getDate());
    let removed = 0;
    const failed = [];
    for (const name of fs.readdirSync(dir)) {
        const date = dayLogDate(name);
        if (date === null || today - date <= KEEP_DAYS) continue;
        try {
            fs.unlinkSync(path.join(dir, name));
            removed++;
        } catch (err) {
            failed.push(err.code || err.name);
        }
    }
    return { removed, failed };
}

module.exports = { KEEP_DAYS, pruneDayLogs };
