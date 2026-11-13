-- Who is an admin becomes a fact about the account, not about its address.
--
-- Admin rights used to follow the email: whoever held a session for an address
-- on the ADMIN_EMAIL list was an admin. Sign-up does not verify email, so the
-- list, which is in a public repo, was a list of accounts anyone could become
-- by registering first. A flag on the row can only be set by something that
-- can write the row.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- The accounts that are admins today keep being admins: the two addresses on
-- the list, where the account already has a password. One with no password is
-- left alone on purpose, because a passwordless account is nobody's yet, and
-- flagging it would hand admin to the first person to sign in to it. Those,
-- and addresses with no account at all, are settled by POST /admin/bootstrap.
UPDATE users SET is_admin = 1
 WHERE lower(trim(email)) IN ('prabhune@berkeley.edu', 'admincli@goldenturn.org')
   AND password_hash IS NOT NULL AND password_hash != '';

-- The prep area is open to chosen accounts only. Off for everyone until an
-- admin says otherwise.
ALTER TABLE users ADD COLUMN prep_access INTEGER NOT NULL DEFAULT 0;

-- When an account, and each of its sessions, last made a signed-in request.
-- Null until it next does: nothing recorded this before, and a guess would
-- read as a fact.
ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;

-- "What has this account done" is asked per user on the admin page, and the
-- only index on events leads with kind.
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at);
