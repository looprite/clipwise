// A name as the server compares it, on the Mac (SAA-260 step 4): a copy of
// normalizeName and nameKey in server/src/routes/capture-people.ts, so the
// identity window treats two names as one person exactly when ingest's
// same-name rule will. The window uses it to keep one chip per person, to keep
// the member's own name out of the guests, and to tell a typed name from a
// search result. check-capture-people.ts runs both copies over the same cases;
// change both or neither.

const MAX_NAME_LENGTH = 256;

// Trimmed, every run of whitespace one space, Unicode NFC. Null when nothing is
// left, when it is longer than a people.name can hold, or when it holds an @
// (an address typed as a name; identity data never carries one).
function normalizeName(raw) {
    if (typeof raw !== 'string') return null;
    const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (name.length === 0 || name.length > MAX_NAME_LENGTH || name.includes('@')) return null;
    return name;
}

// What two names are compared by: normalizeName, then lower case.
function nameKey(raw) {
    const name = normalizeName(raw);
    return name === null ? null : name.toLowerCase();
}

module.exports = { MAX_NAME_LENGTH, normalizeName, nameKey };
