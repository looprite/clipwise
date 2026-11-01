// Near-duplicate names (SAA-169, by name key since SAA-260 step 4): the pure half
// of check-name-duplicates.ts, so its rule is checked without a database
// (check-near-duplicates.ts).
//
// Names are compared by nameKey (routes/capture-people.ts): NFC, every run of
// whitespace one space, trimmed, lowercased; a name holding an @, empty or past
// people.name's length has no key and is left out. Spellings that share a key
// are one name, as ingest's same-name rule treats them, not a near-duplicate
// pair. Two keys one or two edits apart are a pair ("Liillan Dwyer" next to
// "Lillian Dwyer"). Nothing here merges or edits anything.

import { nameKey } from "../routes/capture-people.js";

// Small counts (tens of names) make the O(n^2) pair check trivial; this does
// not need to scale further than an account's own roster.
export function levenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const prev = new Array<number>(bl + 1);
  const curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    for (let j = 0; j <= bl; j++) prev[j] = curr[j];
  }
  return prev[bl];
}

// "Differs by one or two characters" (SAA-169's own phrasing): distance 1 or 2
// between keys, not 0 (the same name) and not larger (unrelated names).
export const NEAR_DUPLICATE_MAX_DISTANCE = 2;

export type NearDuplicatePair = { a: string; b: string; distance: number };
// One key stored under two or more spellings ("Ann Example", "ann  example").
// Information, not a problem: ingest's same-name rule already treats them as
// one person.
export type SameKeySpellings = { key: string; spellings: string[] };

// -> how many distinct names (by key) there are; every pair of them one or two
// edits apart, each shown by its first stored spelling in sorted order; and
// every key stored under two or more distinct spellings, the spellings as
// stored, sorted.
export function nearDuplicates(rawNames: Iterable<unknown>): {
  distinctCount: number;
  pairs: NearDuplicatePair[];
  sameKey: SameKeySpellings[];
} {
  const spellings = new Map<string, Set<string>>();
  for (const raw of rawNames) {
    const key = nameKey(raw);
    if (key === null) continue;
    const set = spellings.get(key) ?? new Set<string>();
    set.add(raw as string);
    spellings.set(key, set);
  }
  const keys = [...spellings.keys()].sort();
  const sorted = new Map(keys.map((k) => [k, [...(spellings.get(k) as Set<string>)].sort()]));
  const pairs: NearDuplicatePair[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const distance = levenshtein(keys[i], keys[j]);
      if (distance > 0 && distance <= NEAR_DUPLICATE_MAX_DISTANCE) {
        pairs.push({ a: (sorted.get(keys[i]) as string[])[0], b: (sorted.get(keys[j]) as string[])[0], distance });
      }
    }
  }
  const sameKey = keys
    .filter((k) => (sorted.get(k) as string[]).length >= 2)
    .map((k) => ({ key: k, spellings: sorted.get(k) as string[] }));
  return { distinctCount: keys.length, pairs, sameKey };
}
