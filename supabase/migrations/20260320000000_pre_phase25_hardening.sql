-- ============================================================
-- FieldTrack 2.0 — Pre-Phase 25 Hardening Migration
--
-- Addresses three gaps found during the pre-Phase 25 audit:
--
--   1. org_dashboard_snapshot RLS policy was created with USING
--      only (no WITH CHECK).  For a FOR ALL policy, USING governs
--      SELECT/DELETE visibility but INSERT/UPDATE rows bypass the
--      DB-level tenant check without WITH CHECK.  The backend uses
--      the service role (which bypasses RLS entirely) so this has
--      never caused a data breach, but it violates the defence-in-
--      depth pattern applied to every other table in the schema
--      (see 20260318000001_rls_add_with_check.sql).
--
--   2. webhook_deliveries was created without a composite index on
--      (organization_id, delivered_at DESC).  The delivery history
--      pagination query — "list deliveries for org, newest first" —
--      would require a sequential scan without this index.
--
--   3. webhooks.events is a TEXT[] column used for event-type fanout:
--      the delivery worker queries "find webhooks for org that
--      subscribe to this event".  A GIN index on the array column
--      makes the containment operator (@>) an O(log N) index scan
--      instead of a full sequential scan.
--
-- All changes are additive and backward-compatible.
-- No existing data is modified.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1.  org_dashboard_snapshot — add WITH CHECK to RLS policy
-- ────────────────────────────────────────────────────────────
--
-- Drop and recreate with the same USING expression mirrored in
-- WITH CHECK, matching the pattern used for all other tables in
-- 20260318000001_rls_add_with_check.sql.
--
-- The service role used by the backend bypasses RLS, so this
-- change has no runtime impact on the API.  It closes the gap
-- at the database level so that any future direct-client access
-- (e.g., a Supabase Edge Function, a dashboard, or a test that
-- uses the anon key) cannot insert or update rows belonging to
-- a different organisation.

DROP POLICY IF EXISTS "org_isolation_org_dashboard_snapshot"
  ON public.org_dashboard_snapshot;

CREATE POLICY "org_isolation_org_dashboard_snapshot"
  ON public.org_dashboard_snapshot FOR ALL
  USING (
    organization_id = (
      SELECT users.organization_id
        FROM public.users
       WHERE users.id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT users.organization_id
        FROM public.users
       WHERE users.id = auth.uid()
    )
  );

COMMENT ON POLICY "org_isolation_org_dashboard_snapshot"
  ON public.org_dashboard_snapshot IS
  'Org isolation — USING + WITH CHECK.  Mirrors the pattern from '
  '20260318000001_rls_add_with_check.sql applied to all other tables.';


-- ────────────────────────────────────────────────────────────
-- 2.  webhook_deliveries — composite index for pagination
-- ────────────────────────────────────────────────────────────
--
-- The most common query pattern for the delivery history panel:
--
--   SELECT * FROM webhook_deliveries
--    WHERE organization_id = $org_id
--    ORDER BY delivered_at DESC
--    LIMIT $limit OFFSET $offset;
--
-- Without this index Postgres must do a sequential scan over all
-- deliveries and then sort.  With the index, the planner can
-- satisfy both the WHERE and the ORDER BY via a single index scan
-- in the correct direction.
--
-- DESC on delivered_at matches the ORDER BY direction so the
-- index can be read forwards without a sort step.

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_org_delivered_at
  ON public.webhook_deliveries (organization_id, delivered_at DESC);

COMMENT ON INDEX public.idx_webhook_deliveries_org_delivered_at IS
  'Composite index for delivery history pagination queries: '
  'WHERE organization_id = ? ORDER BY delivered_at DESC LIMIT ?';


-- ────────────────────────────────────────────────────────────
-- 3.  webhooks.events — GIN index for array containment
-- ────────────────────────────────────────────────────────────
--
-- The Phase 25 delivery worker must execute a fanout query on
-- every emitted event to find registered webhooks:
--
--   SELECT id, url, secret
--     FROM webhooks
--    WHERE organization_id = $org_id
--      AND is_active = TRUE
--      AND (
--            events = '{}'                        -- subscribed to ALL events
--         OR events @> ARRAY[$event_name::text]   -- subscribed to this event
--          );
--
-- The @> (array containment) operator requires a GIN index to
-- avoid a sequential scan.  Without it, every emitted domain
-- event would scan the entire webhooks table.
--
-- The partial WHERE clause on is_active = TRUE in the existing
-- idx_webhooks_org_active index filters the candidate set but
-- cannot speed up the @> predicate itself — GIN is required.

CREATE INDEX IF NOT EXISTS idx_webhooks_events_gin
  ON public.webhooks USING gin (events);

COMMENT ON INDEX public.idx_webhooks_events_gin IS
  'GIN index on webhooks.events TEXT[] for fast event-type fanout '
  'queries using the @> array containment operator.';


-- ────────────────────────────────────────────────────────────
-- 4.  webhook_deliveries — index supporting webhook-scoped queries
-- ────────────────────────────────────────────────────────────
--
-- Secondary access pattern: "list all deliveries for a specific
-- webhook, ordered by attempt number" — used in the webhook
-- management UI to show retry history per webhook registration.
--
--   SELECT * FROM webhook_deliveries
--    WHERE webhook_id = $id
--    ORDER BY delivered_at DESC;
--
-- idx_webhook_deliveries_webhook_id already covers webhook_id
-- (created in 20260319000000_create_webhooks.sql), but adding
-- delivered_at to the index makes the ORDER BY free.

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_delivered_at
  ON public.webhook_deliveries (webhook_id, delivered_at DESC);

COMMENT ON INDEX public.idx_webhook_deliveries_webhook_delivered_at IS
  'Covers per-webhook delivery history queries ordered by time.  '
  'Complements idx_webhook_deliveries_webhook_id for sorted pagination.';


-- ────────────────────────────────────────────────────────────
-- Summary
-- ────────────────────────────────────────────────────────────
--
-- Policies changed : 1  (org_dashboard_snapshot WITH CHECK added)
-- Indexes added    : 3  (org+time, gin(events), webhook+time)
-- Tables modified  : 0  (schema unchanged)
-- Data modified    : 0
-- ────────────────────────────────────────────────────────────
