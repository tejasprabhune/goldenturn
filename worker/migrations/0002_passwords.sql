-- Accounts gain a password. Stored as PBKDF2-SHA256 with a per-user salt,
-- serialised as iterations:salt:hash, all base64.
ALTER TABLE users ADD COLUMN password_hash TEXT;
