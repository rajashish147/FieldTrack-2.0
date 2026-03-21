-- Queue retry intents for enqueue failures (Redis outages / transient queue errors)
-- Persisted in Postgres so retries survive process restarts.

CREATE TABLE IF NOT EXISTS public.queue_retry_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name TEXT NOT NULL CHECK (queue_name IN ('distance-engine', 'analytics')),
  job_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dead')),
  retry_count INT NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_queue_retry_intents_queue_job UNIQUE (queue_name, job_key)
);

CREATE INDEX IF NOT EXISTS idx_queue_retry_intents_status_next_retry
  ON public.queue_retry_intents (status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_queue_retry_intents_queue_status
  ON public.queue_retry_intents (queue_name, status);

ALTER TABLE public.queue_retry_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_only_queue_retry_intents" ON public.queue_retry_intents;
CREATE POLICY "service_role_only_queue_retry_intents"
  ON public.queue_retry_intents FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
