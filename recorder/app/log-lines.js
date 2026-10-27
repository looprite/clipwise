// The day log's lines for the paths that handle call content (SAA-243 item 7).
// The day log keeps counts and kinds only: no names, no meeting titles, no
// notification text, no saved transcript's filename. Each function takes only
// what its line may say, so content cannot reach it by accident.

// A notification, by the identifier of the place that raised it. Its title and
// body can carry a meeting title or an app's name, so neither is logged.
function notifyLine(kind) {
    return `notify: ${kind}`;
}

function notifyDeliveredLine(kind) {
    return `notify: delivered — ${kind}`;
}

// A saved transcript: how many turns, never where it went (the suggested
// filename is the meeting's title).
function saveTranscriptSavedLine(stem, turns, unattributedTurns) {
    return `[clipwise-recorder] save-transcript ${stem}: saved ${turns} turns (${unattributedTurns} unattributed)`;
}

// A failure on the save-transcript path. Only the error's code: an fs error's
// message names the file, and the file is named after the meeting.
function saveTranscriptFailedLine(stem, err) {
    return `[clipwise-recorder] save-transcript ${stem}: failed — ${errCode(err)}`;
}

// Who was on the call, as counts: whether the member gave their own name, how
// many guests were named, and the scope ('work', 'personal' or null).
function identityLine(stem, selfGiven, guestCount, scope, finalPath) {
    return `[clipwise-recorder] identity ${stem}: self=${selfGiven ? 'given' : 'none'} `
        + `guests=${guestCount} scope=${scope || 'none'} -> ${finalPath}`;
}

// The voices on the call, as counts: how many, and how many were given a name.
function voiceNamesLine(stem, voiceCount, namedCount, finalPath) {
    return `[clipwise-recorder] voice-names ${stem}: voices=${voiceCount} named=${namedCount} -> ${finalPath}`;
}

// The calendar preview at stop (SAA-221): what came of it, how long it took and
// how many invitees it named and left unnamed. Never a title, name or address.
function calendarPreviewLine(stem, outcome, ms, prefill) {
    const timing = Number.isFinite(ms) ? ` after ${ms}ms` : '';
    const counts = prefill ? ` named=${prefill.named.length} unnamed=${prefill.unnamed.length}` : '';
    return `[clipwise-recorder] calendar-preview ${stem}: ${outcome}${timing}${counts}`;
}

// Names typed for invitees at the prompt, as a count.
function inviteeNamesLine(stem, count, finalPath) {
    return `[clipwise-recorder] invitee-names ${stem}: invitees=${count} -> ${finalPath}`;
}

function inviteeNamesFailedLine(stem, err) {
    return `[clipwise-recorder] invitee-names ${stem}: could not write — ${errCode(err)}`;
}

function errCode(err) {
    return (err && (err.code || err.name)) || 'error';
}

module.exports = {
    notifyLine, notifyDeliveredLine,
    saveTranscriptSavedLine, saveTranscriptFailedLine,
    identityLine, voiceNamesLine,
    calendarPreviewLine, inviteeNamesLine, inviteeNamesFailedLine,
};
