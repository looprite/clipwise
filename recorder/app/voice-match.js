// The matcher, watch only (SAA-260 step 3, SAA-196): after a capture's voices
// are separated, each voice diarize kept is scored against every voice print on
// this Mac, and the scores are logged. It names no one: nothing it computes is
// shown, sent or written anywhere but the score log.
//
// One line per voice in voice-prints/scores.jsonl (voice-prints.js), with ids
// and scores only:
//   { kind: 'match', at, stem, voice, seconds, modelRevision, profiles,
//     best: { id, score } | null, runnerUp: { id, score } | null, self }
// `self` is the score against the member's own print, or null. The capture's
// own contributions are left out of every profile it is scored against, so a
// capture processed again never matches itself. The `confirmed` lines
// voice-prints.js appends when the server's person ids arrive are the ground
// truth these are read against, to set a cut-off (a threshold plus a margin
// over the runner-up) before anything is named.
//
// Runs only while voice prints are on. Off: nothing is read or written.

const fs = require('fs');
const path = require('path');
const { cosine } = require('./voice-prints.js');

const round = (x) => (typeof x === 'number' ? Math.round(x * 10000) / 10000 : null);

// Pure: one voice's vector against the profiles -> best and runner-up.
function rank(vec, people) {
    const scored = people
        .map((p) => ({ id: p.id, score: cosine(vec, p.embedding) }))
        .filter((s) => s.score !== null)
        .sort((a, b) => b.score - a.score);
    const out = (s) => (s ? { id: s.id, score: round(s.score) } : null);
    return { best: out(scored[0]), runnerUp: out(scored[1]) };
}

// store is voice-prints.js createVoicePrints(...). -> { voices, profiles } or { skipped }.
function matchCapture(store, outdir, stem, now = () => new Date()) {
    if (!store.isEnabled()) return { skipped: 'off' };
    let diarized;
    try {
        diarized = JSON.parse(fs.readFileSync(path.join(outdir, `diarize-${stem}.json`), 'utf8'));
    } catch {
        return { skipped: 'no_diarize_file' };
    }
    if (!diarized || diarized.error || !Array.isArray(diarized.voices)) return { skipped: 'no_voices' };
    const { people, self } = store.matchProfiles(stem);
    const at = now().toISOString();
    const lines = [];
    for (const v of diarized.voices) {
        if (!Array.isArray(v.embedding) || v.embedding.length === 0) continue;
        const { best, runnerUp } = rank(v.embedding, people);
        lines.push({
            kind: 'match', at, stem, voice: v.voiceIndex,
            seconds: round(v.totalSeconds), modelRevision: diarized.modelRevision || null,
            profiles: people.length, best, runnerUp, self: self ? round(cosine(v.embedding, self)) : null,
        });
    }
    store.appendScoreLines(lines);
    return { voices: lines.length, profiles: people.length };
}

module.exports = { rank, matchCapture };
