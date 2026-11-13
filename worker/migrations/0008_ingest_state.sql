-- What the ingest run did, as it did it.
--
-- A submission's status says pending, ingested or failed, which is one fact
-- about one step. Everything after the audio (the transcript, the speech
-- labels, the page) was only visible as files turning up in the bucket, and
-- nothing at all said whether the run was still running: it stopped for
-- seventeen days and the only sign was rounds that never got pages. The run
-- now reports each step it starts and each one that fails, and reports in
-- once per run, so "waiting" and "nobody is coming" can be told apart.
--
-- Keyed by slug as well as by submission, because the later steps discover
-- their work from the bucket and know a round only by the name its files are
-- filed under.
CREATE TABLE IF NOT EXISTS ingest_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id   TEXT,
  slug        TEXT,
  stage       TEXT NOT NULL,   -- run | audio | transcript | speeches | index |
                               -- page, or dispatch: the API failing to start
                               -- a run
  state       TEXT NOT NULL,   -- queued | started | done | failed | skipped
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_events_slug ON ingest_events(slug, id);
CREATE INDEX IF NOT EXISTS idx_ingest_events_stage ON ingest_events(stage, created_at);

-- How many times the run has reported an outcome for this round.
ALTER TABLE submissions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

-- Whether the round has a page is a fact about the built site, which only the
-- site can answer. These remember the answer so a waiting page that asks every
-- few seconds costs one request to the site a minute rather than one each.
--   page_checked_at  when the site was last asked
--   page_seen_at     when the page found there was built; null if none was
--   page_at          set once a page built after the audio arrived has been
--                    seen, which is the page with a player, and not asked again
ALTER TABLE submissions ADD COLUMN page_checked_at INTEGER;
ALTER TABLE submissions ADD COLUMN page_seen_at INTEGER;
ALTER TABLE submissions ADD COLUMN page_at INTEGER;

-- What the submitter typed that the row did not already hold: format, level,
-- resolution, both strategies, the decision and the tags, as JSON. Search has
-- all of it until the round is removed, and a removed round is the one
-- somebody comes back to submit again, with a form that could be filled in
-- for them. Null for the submissions made before this.
ALTER TABLE submissions ADD COLUMN details TEXT;
