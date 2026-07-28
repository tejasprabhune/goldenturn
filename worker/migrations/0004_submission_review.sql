-- Submissions carry two independent facts, and one column was doing both badly.
--
-- How far the pipeline has got is not the same question as whether the round
-- should be here at all. A round can be fully ingested and unwanted, or
-- confirmed and still waiting on a GPU. Splitting them lets the onboarding run
-- own one column and the admin own the other, without either overwriting the
-- other's answer.
ALTER TABLE submissions ADD COLUMN review TEXT NOT NULL DEFAULT 'unreviewed';

-- Everything already here has been through the pipeline and been seen.
UPDATE submissions SET review = 'confirmed' WHERE status = 'ingested';

CREATE INDEX IF NOT EXISTS idx_submissions_review ON submissions(review, created_at);
