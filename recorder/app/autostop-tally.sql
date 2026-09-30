-- Auto-stop tally (SAA-184, logging-only build cd59ddf). Read-only: SELECTs only.
-- Reads recordings.metadata.autostop: the block recorder/app/autostop.js builds
-- (autostopBlock) and server/src/ingest/clipwise.ts stores.
--
-- "matched" = the would-stop fired AND the trigger's mic did not come back after
-- it (a would-stop followed by a reacquire never counts), OR the capture was
-- stopped by hand while a grace window was open (window_open_at_stop), which is
-- what pressing Stop seconds after hanging up leaves behind.
-- It does NOT show that the would-stop landed after the call ended; that is a
-- listen / read-the-log check. A capture that started with no known trigger pids
-- can open a window from an unrelated pid's release; the block doesn't flag that
-- (autostop-<stem>.log says "pid was not in the set").
-- Captures from before the build have autostop = JSON null (not SQL NULL) in
-- principle, hence the jsonb_typeof filter; today they simply lack the key.
-- check-autostop.js holds the same rule as a JavaScript predicate.
--
-- Cases the `matched` expression was validated against (2026-09-30, run read-only
-- over literal jsonb rows in a VALUES list; every row came out as expected):
--   a.  would-stop fired, no reacquire after                    -> matched
--   b.  would-stop fired, then reacquire (in_start 1)           -> not matched
--   c.  manual stop, no window open                             -> not matched
--   d.  manual stop, window open                                -> matched
--   e.  stopped by child_exit, no would-stop, no window         -> not matched
--   x1. window open at stop, stop_cause child_exit              -> not matched
--   x2. would-stop fired, events_after_would_stop key absent    -> matched (missing counts as 0)

-- 1. Tally per trigger key (the two rollout keys)
WITH c AS (
  SELECT r.id, r.started_at, r.metadata->'autostop' AS a
  FROM recordings r
  WHERE r.source = 'clipwise-recorder'
    AND jsonb_typeof(r.metadata->'autostop') = 'object'
)
SELECT a->>'trigger_key' AS trigger_key,
       count(*) AS captures,
       count(*) FILTER (WHERE coalesce((a->>'would_stop_at' IS NOT NULL
                                          AND coalesce((a->'events_after_would_stop'->>'in_start')::int, 0) = 0)
                                       OR (a->>'window_open_at_stop' IS NOT NULL AND a->>'stop_cause' = 'manual'), false)) AS matched,
       count(*) FILTER (WHERE a->>'would_stop_at' IS NOT NULL)   AS would_stop_fired,
       count(*) FILTER (WHERE a->>'window_open_at_stop' IS NOT NULL
                           AND a->>'stop_cause' = 'manual')      AS open_at_manual_stop,
       sum((SELECT count(*) FROM jsonb_array_elements(coalesce(a->'cancellations', '[]'::jsonb)) x
            WHERE x->>'reason' = 'reacquire'))                   AS reacquire_windows,
       count(*) FILTER (WHERE (a->'events_after_would_stop'->>'in_start')::int > 0) AS would_stop_then_reacquired
FROM c
WHERE a->>'trigger_key' IN ('com.google.Chrome.helper', 'com.apple.avconferenced')
GROUP BY 1
ORDER BY 1;

-- 2. Per capture: every capture that has a block, any trigger key
WITH c AS (
  SELECT r.id, r.started_at, r.metadata->'autostop' AS a
  FROM recordings r
  WHERE r.source = 'clipwise-recorder'
    AND jsonb_typeof(r.metadata->'autostop') = 'object'
)
SELECT left(id::text, 8) AS id8, started_at,
       a->>'trigger_key' AS trigger_key,
       a->>'stop_cause'  AS stop_cause,
       a->>'would_stop_at' AS would_stop_at,
       a->'window_open_at_stop'->>'opened_at' AS window_opened_at,
       (a->'window_open_at_stop'->>'stopped_after_ms')::int AS stopped_after_ms,
       (SELECT count(*) FROM jsonb_array_elements(coalesce(a->'cancellations', '[]'::jsonb)) x
         WHERE x->>'reason' = 'reacquire') AS reacquire_windows,
       (a->'events_after_would_stop'->>'in_start')::int AS reacquired_after_would_stop,
       coalesce((a->>'would_stop_at' IS NOT NULL
                   AND coalesce((a->'events_after_would_stop'->>'in_start')::int, 0) = 0)
                OR (a->>'window_open_at_stop' IS NOT NULL AND a->>'stop_cause' = 'manual'), false) AS matched
FROM c
ORDER BY started_at;
