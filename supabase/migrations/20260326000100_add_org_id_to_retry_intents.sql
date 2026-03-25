-- ============================================================================
-- Migration: add organization_id to queue_retry_intents (C1 security fix)
--
-- Problem: GET /admin/retry-intents queries the table without an org filter.
--          The service-role client bypasses RLS, so every ADMIN user sees
--          retry intents owned by ALL organizations. This is a cross-tenant
--          data leak.
--
-- Fix strategy:
--   1. Add a nullable organization_id FK column.
--   2. Back-fill existing rows from the payload JSONB field (where present).
--   3. Add a covering index for the common (org, status) query pattern.
--   4. The application code (retry-intents.routes.ts + retry-intents.ts)
--      is updated separately to:
--        - Write organization_id on insert/upsert.
--        - Filter by organization_id on the admin read endpoint.
-- ============================================================================

BEGIN;

-- 1. Add column — nullable so existing rows are not rejected.
--    Once backfill + app deploy is complete you may add NOT NULL + DEFAULT.
ALTER TABLE public.queue_retry_intents
  ADD COLUMN IF NOT EXISTS organization_id UUID
    REFERENCES public.organizations(id) ON DELETE CASCADE;

-- 2. Backfill from payload JSONB.
--    The worker stores payload->>'organizationId' (camelCase) per the
--    RetryIntentPayload interface in src/workers/retry-intents.ts.
UPDATE public.queue_retry_intents
SET    organization_id = (payload->>'organizationId')::uuid
WHERE  organization_id IS NULL
  AND  payload->>'organizationId' IS NOT NULL
  AND  (payload->>'organizationId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- 3. Index for the admin endpoint access pattern:
--      WHERE organization_id = $1 [AND status = $2]
--      ORDER BY updated_at DESC
CREATE INDEX IF NOT EXISTS idx_queue_retry_intents_org_status
  ON public.queue_retry_intents (organization_id, status, updated_at DESC)
  WHERE organization_id IS NOT NULL;

COMMIT;

-- ============================================================================
-- FOLLOW-UP (after app deploy + verification):
--   ALTER TABLE public.queue_retry_intents
--     ALTER COLUMN organization_id SET NOT NULL;
--
--   Rows where organization_id is still NULL after backfill are pre-migration
--   orphan records that predate Phase 26. They can be deleted or left as-is
--   (they will not appear in the filtered admin view).
-- ============================================================================
