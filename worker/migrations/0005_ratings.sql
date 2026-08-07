-- What people think a round is worth watching.
--
-- Everything else the archive collects about a round is a matter of fact: who
-- read what, where the speech starts, what was said. How good it is, is not,
-- and no amount of transcription produces it. One row per person per round, so
-- rating again replaces rather than stacks, and the average is over people
-- rather than over clicks.
CREATE TABLE IF NOT EXISTS ratings (
  slug        TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stars       INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (slug, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_slug ON ratings(slug);
CREATE INDEX IF NOT EXISTS idx_ratings_user ON ratings(user_id);
