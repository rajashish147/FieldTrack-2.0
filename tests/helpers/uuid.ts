import { randomUUID } from "crypto";

/**
 * Test UUID helpers to prevent Zod v4 UUID validation failures.
 *
 * Use these instead of hardcoded strings like "test-id" or "123" in tests
 * to ensure compatibility with strict UUID validation.
 */

/**
 * Generates a valid random UUID v4 for tests.
 * Use when you need unique IDs across test cases.
 *
 * @example
 * const sessionId = TEST_UUID();
 */
export const TEST_UUID = (): string => randomUUID();

/**
 * Alias for TEST_UUID() for semantic clarity.
 * Use when the context is a generic ID rather than specifically a UUID.
 *
 * @example
 * const id = TEST_ID();
 */
export const TEST_ID = TEST_UUID;

/**
 * Fixed valid UUID v4 for tests that need deterministic IDs.
 * Use when you need the same ID across multiple assertions.
 * Frozen to prevent accidental mutation.
 *
 * @example
 * expect(result.id).toBe(FIXED_TEST_UUID);
 */
export const FIXED_TEST_UUID = Object.freeze(
  "00000000-0000-4000-8000-000000000000",
);

/**
 * Generates multiple unique test UUIDs.
 * Useful for creating test fixtures with multiple related entities.
 *
 * @example
 * const [orgId, userId] = TEST_UUIDS(2);
 */
export const TEST_UUIDS = (count: number): string[] =>
  Array.from({ length: count }, () => randomUUID());

/**
 * Type definition for common test entity IDs.
 * Provides autocomplete and type safety for test fixtures.
 */
export type TestIds = {
  orgId: string;
  userId: string;
  employeeId: string;
  sessionId: string;
  expenseId: string;
  locationId: string;
  attendanceId: string;
};

/**
 * Generates a typed set of common test entity IDs.
 * Useful for creating consistent test fixtures across test suites.
 *
 * @example
 * const ids = TEST_IDS();
 * await createEmployee({
 *   id: ids.employeeId,
 *   organization_id: ids.orgId
 * });
 */
export const TEST_IDS = (): Readonly<TestIds> =>
  Object.freeze({
    orgId: randomUUID(),
    userId: randomUUID(),
    employeeId: randomUUID(),
    sessionId: randomUUID(),
    expenseId: randomUUID(),
    locationId: randomUUID(),
    attendanceId: randomUUID(),
  });

/**
 * Fixed deterministic test fixture IDs for integration tests.
 * Use when you need stable, predictable IDs across test runs.
 * All IDs are frozen to prevent accidental mutation.
 *
 * @example
 * const org = await createOrg({ id: TEST_FIXTURE_IDS.orgId });
 * const user = await createUser({ id: TEST_FIXTURE_IDS.userId, org_id: TEST_FIXTURE_IDS.orgId });
 */
export const TEST_FIXTURE_IDS = Object.freeze({
  orgId: FIXED_TEST_UUID,
  userId: "00000000-0000-4000-8000-000000000001",
  employeeId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  expenseId: "00000000-0000-4000-8000-000000000004",
  locationId: "00000000-0000-4000-8000-000000000005",
  attendanceId: "00000000-0000-4000-8000-000000000006",
});
