-- What the pipeline knows that belongs to no one round.
--
-- The Worker asks GitHub to start the ingest run every fifteen minutes, and
-- GitHub answers 204 whether or not anything runs: a disabled workflow takes
-- the request and ignores it. Remembering when a request was first accepted
-- with no run reported since is how "the run is not starting" is told apart
-- from "the run is not due". The same table remembers when a site build was
-- last asked for, so that a burst of submissions asks for one, not one each.
--
--   dispatch_accepted_at        the last request GitHub accepted
--   dispatch_unanswered_since   the first accepted request since a run last
--                               reported in
--   rebuild_requested_at        the last site build asked for
CREATE TABLE IF NOT EXISTS pipeline_state (
  key    TEXT PRIMARY KEY,
  value  INTEGER
);

-- A round restarted from a stage wants a page built after the restart: the
-- one already deployed shows what the restart cleared. Null for a round never
-- restarted.
ALTER TABLE submissions ADD COLUMN page_after INTEGER;
