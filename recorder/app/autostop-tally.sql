-- Auto-stop tally (SAA-184), live mode. Read-only: SELECTs only.
-- Reads recordings.metadata.autostop: the block recorder/app/autostop.js builds
-- (autostopBlock) and server/src/ingest/clipwise.ts stores. Live since 2026-10-07
-- for every app that triggers a capture; the older rollout tally ("matched",
-- counted per Chrome/FaceTime key) is retired with the rollout it measured.
-- Blocks written before then say mode 'log_only' and stop_cause 'manual'.
--
-- What stopping wrongly looks like now. An auto-stop cannot see the mic come
-- back afterwards (the capture is over), so a call that was cut short shows up
-- as ANOTHER capture starting soon after. Section 3 is that detector: an
-- auto-stopped capture followed, within 10 minutes of its stopped_at, by the
-- next capture, whatever started it. A hand-started capture counts: pressing
-- Start again is what a person does after being cut off. Whether the next
-- capture came from the same trigger is reported beside it as its own column,
-- not folded into the flag.
--
-- The flag is a prompt to listen, not a verdict: two real back-to-back calls in
-- the same app also look like this (a known gap, see the open list).
-- The grace window is 5s (autostop.js GRACE_MS, set 2026-10-07; it was 120s),
-- so a call that drops and comes back after more than 5s is cut short by
-- design and this detector is the check on how often that happens. Compare
-- against stop_cause 'auto' rows whose block has grace_ms 5000; earlier blocks
-- say 120000.
--
-- Section 3's expressions were validated on 20 literal rows (the file's own
-- text between BEGIN/END detector, only the source CTE swapped for VALUES), in
-- a read-only session that touched no table. Cases, id -> cut_short_any /
-- next_same_trigger:
--   A1   auto, next capture 9 min later, same trigger          -> true / true
--   A2   auto, next capture 11 min later                       -> false / false
--   A3   auto, next capture exactly 10:00 later                -> true / true (inclusive)
--   A4   auto, next capture 5 min later, different trigger     -> true / false
--   A5   stop_cause manual, same-trigger capture 3 min later   -> absent (not a subject)
--   A6   auto, next capture hand-started (no trigger), 4 min   -> true / false
--   A7   auto, nothing for 90 min                              -> false / false
--   A8   auto, next capture has no autostop block, 5 min       -> true / false
--   A9   stop_cause child_exit, next capture in 2 min          -> absent (not a subject)
--   A10, A11, A12  three in a row: A10 is compared with A11 (4 min) and not
--        with A12 (25 min); A11 with A12 (5 min); A12 is manual, absent.
-- Negative controls, each of which must disagree with the cases: the window
-- widened to 10 hours flips A2 and A7; `<=` changed to `<` flips A3; the
-- stop_cause filter removed makes A5 and A9 appear.

-- 1. Tally per trigger key and stop cause
WITH c AS (
  SELECT r.id, r.started_at, r.metadata->'autostop' AS a
  FROM recordings r
  WHERE r.source = 'clipwise-recorder'
    AND jsonb_typeof(r.metadata->'autostop') = 'object'
)
SELECT a->>'trigger_key' AS trigger_key,
       a->>'stop_cause'  AS stop_cause,
       a->>'mode'        AS mode,
       count(*)          AS captures
FROM c
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- 2. Per capture: every capture that has a block, any trigger key
WITH c AS (
  SELECT r.id, r.started_at, r.metadata->'autostop' AS a
  FROM recordings r
  WHERE r.source = 'clipwise-recorder'
    AND jsonb_typeof(r.metadata->'autostop') = 'object'
)
SELECT left(id::text, 8) AS id8, started_at,
       a->>'trigger_key'  AS trigger_key,
       a->>'trigger_exe'  AS trigger_exe,
       a->>'stop_cause'   AS stop_cause,
       a->>'mode'         AS mode,
       a->>'would_stop_at' AS auto_stop_decided_at,
       a->'window_open_at_stop'->>'opened_at' AS window_opened_at,
       (a->'window_open_at_stop'->>'stopped_after_ms')::int AS stopped_after_ms,
       (SELECT count(*) FROM jsonb_array_elements(coalesce(a->'cancellations', '[]'::jsonb)) x
         WHERE x->>'reason' = 'reacquire') AS reacquire_windows
FROM c
ORDER BY started_at;

-- 3. Cut-short detector
-- The population is EVERY clipwise-recorder capture, not only those with a
-- block, because the successor of an auto-stop may be an older or hand-started
-- capture. Subjects are the ones with stop_cause = 'auto'.
-- BEGIN detector
WITH c AS (
  SELECT r.id, r.started_at, r.metadata->'autostop' AS a
  FROM recordings r
  WHERE r.source = 'clipwise-recorder'
)
-- END source
, nxt AS (
  SELECT id, started_at, a,
         lead(id)         OVER w AS next_id,
         lead(started_at) OVER w AS next_started_at,
         lead(a)          OVER w AS next_a
  FROM c
  WINDOW w AS (ORDER BY started_at, id)
)
SELECT left(id::text, 8)      AS id8,
       a->>'trigger_key'      AS trigger_key,
       a->>'stopped_at'       AS stopped_at,
       left(next_id::text, 8) AS next_id8,
       next_started_at,
       round(extract(epoch FROM (next_started_at - (a->>'stopped_at')::timestamptz))::numeric) AS gap_s,
       next_a->>'trigger_key' AS next_trigger_key,
       coalesce(next_started_at >= (a->>'stopped_at')::timestamptz
            AND next_started_at - (a->>'stopped_at')::timestamptz <= interval '10 minutes', false) AS cut_short_any,
       coalesce(next_started_at >= (a->>'stopped_at')::timestamptz
            AND next_started_at - (a->>'stopped_at')::timestamptz <= interval '10 minutes'
            AND next_a->>'trigger_key' IS NOT NULL
            AND next_a->>'trigger_key' = a->>'trigger_key', false) AS next_same_trigger
FROM nxt
WHERE jsonb_typeof(a) = 'object' AND a->>'stop_cause' = 'auto'
ORDER BY started_at;
-- END detector
