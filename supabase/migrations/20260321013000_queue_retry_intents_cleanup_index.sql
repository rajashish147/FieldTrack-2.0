-- Support bounded cleanup scans for resolved/dead retry intents.
-- Ordered by status + created_at to make retention deletes predictable and cheap.

CREATE INDEX IF NOT EXISTS idx_queue_retry_intents_status_created_at
  ON public.queue_retry_intents (status, created_at);
