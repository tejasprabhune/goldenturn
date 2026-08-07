-- Settings that follow a person between browsers.
--
-- Which debate formats and levels someone wants to see is a standing answer,
-- not a per-visit one, and localStorage forgets it the moment they open the
-- site on their phone. Held as JSON because these are preferences, and a new
-- one should not cost a migration.
ALTER TABLE users ADD COLUMN prefs TEXT;
