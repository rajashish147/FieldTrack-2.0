// ─── Constants ────────────────────────────────────────────────────────────────

export const PAGINATION_DEFAULTS = {
  LIMIT: 50,
  MAX_LIMIT: 100,
} as const;

// ─── Structural type ──────────────────────────────────────────────────────────

interface Rangeable {
  range(from: number, to: number): this;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Applies cursor pagination to any Supabase query builder.
 *
 * - page is clamped to ≥ 1
 * - limit is clamped to [1, MAX_LIMIT]
 * - limit is coerced to number to handle string inputs from query params
 *
 * Usage:
 *   const { data, error } = await applyPagination(
 *     enforceTenant(request, baseQuery),
 *     page,
 *     limit,
 *   );
 */
export function applyPagination<T extends Rangeable>(
  query: T,
  page: number,
  limit: number,
): T {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(
    PAGINATION_DEFAULTS.MAX_LIMIT,
    Number(limit) || PAGINATION_DEFAULTS.LIMIT,
  );
  const offset = (safePage - 1) * safeLimit;
  
  return query.range(offset, offset + safeLimit - 1);
}
