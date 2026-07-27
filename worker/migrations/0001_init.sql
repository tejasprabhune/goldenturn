-- Accounts. Reading is anonymous; proposing and voting require one of these.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  rep           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One row per proposed correction, to a transcript segment or a speech boundary.
CREATE TABLE IF NOT EXISTS proposals (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('transcript', 'boundary')),
  anchor      TEXT NOT NULL,           -- segment id, or speech label for boundaries
  start_s     REAL,
  end_s       REAL,
  original    TEXT NOT NULL,
  proposed    TEXT NOT NULL,
  note        TEXT,
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  score       INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'accepted', 'rejected', 'superseded'))
);
CREATE INDEX IF NOT EXISTS idx_proposals_slug ON proposals(slug, status);
CREATE INDEX IF NOT EXISTS idx_proposals_user ON proposals(user_id);

-- One vote per user per proposal; the unique constraint enforces that.
CREATE TABLE IF NOT EXISTS votes (
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value       INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, user_id)
);

-- Accepted corrections, applied over the machine transcript at read time.
CREATE TABLE IF NOT EXISTS revisions (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  anchor      TEXT NOT NULL,
  value       TEXT NOT NULL,
  proposal_id TEXT REFERENCES proposals(id),
  applied_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_slug ON revisions(slug, kind);

CREATE TABLE IF NOT EXISTS favorites (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,           -- 'recording' | 'curriculum'
  ref         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, ref)
);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  at_s        REAL NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_user_slug ON notes(user_id, slug);

CREATE TABLE IF NOT EXISTS user_tags (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  tag         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, slug, tag)
);
CREATE INDEX IF NOT EXISTS idx_user_tags ON user_tags(user_id, tag);

-- Append-only telemetry for edits, votes and acceptance rates.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  user_id     TEXT,
  slug        TEXT,
  payload     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, created_at);
