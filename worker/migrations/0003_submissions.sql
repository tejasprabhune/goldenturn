-- Rounds submitted through the site.
--
-- A submission is not finished when it reaches Algolia: it still needs its
-- audio pulled into R2, a transcript and speech timings before the round page
-- is worth opening. This table is what the ingest run reads to know what is
-- outstanding, and what the admin page reads to show the backlog.
CREATE TABLE IF NOT EXISTS submissions (
  object_id   TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  link        TEXT NOT NULL,
  year        TEXT,
  tournament  TEXT,
  user_id     TEXT REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'ingested', 'failed')),
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, created_at);
