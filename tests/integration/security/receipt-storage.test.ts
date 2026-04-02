/**
 * Receipt storage security integration tests.
 *
 * Verifies that the POST /expenses/receipt-upload-url endpoint:
 *   - Requires authentication (401 without JWT)
 *   - Requires employee context (403 for admin-only tokens)
 *   - Validates allowed file extensions (400 for unsupported types)
 *   - Validates MIME type / extension consistency when mimeType is provided
 *   - Scopes storage paths strictly to the authenticated tenant and employee
 *
 * All external I/O is mocked — no live database or network required.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

// ─── Module mocks (hoisted before any imports) ────────────────────────────────

vi.mock("../../../src/config/redis.js", () => ({
  redisClient: { on: vi.fn(), quit: vi.fn(), disconnect: vi.fn() },
}));

vi.mock("../../../src/workers/distance.queue.js", () => ({
  enqueueDistanceJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/workers/analytics.queue.js", () => ({
  enqueueAnalyticsJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/modules/expenses/expenses.repository.js", () => ({
  expensesRepository: {
    createExpense: vi.fn(),
    findExpenseById: vi.fn(),
    findExpensesByUser: vi.fn(),
    findExpensesByOrg: vi.fn(),
    updateExpenseStatus: vi.fn(),
    findExpenseSummaryByEmployee: vi.fn(),
  },
}));

vi.mock("../../../src/config/supabase.js", () => ({
  supabaseServiceClient: {
    from: vi.fn().mockReturnThis(),
    storage: {
      from: vi.fn().mockReturnThis(),
      createSignedUploadUrl: vi.fn(),
    },
  },
  supabaseAnonClient: {
    from: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../../src/auth/jwtVerifier.js", () => ({
  verifySupabaseToken: vi.fn().mockImplementation(async (token: string) => {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT structure");
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  }),
}));

import {
  buildTestApp,
  signEmployeeToken,
  signAdminToken,
  TEST_ORG_ID,
  TEST_ORG_ID_B,
  TEST_EMPLOYEE_ID,
  TEST_ADMIN_ID,
} from "../../setup/test-server.js";
import { supabaseServiceClient } from "../../../src/config/supabase.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const ORG_A_EMPLOYEE_ID = TEST_EMPLOYEE_ID;
const ORG_B_EMPLOYEE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const UPLOAD_URL = "https://storage.supabase.co/object/sign/receipts/path";
const STORAGE_PATH = `${TEST_ORG_ID}/${ORG_A_EMPLOYEE_ID}/some-uuid.jpg`;

// ─────────────────────────────────────────────────────────────────────────────

describe("Receipt Storage Security", () => {
  let app: FastifyInstance;
  let employeeToken: string;
  let adminToken: string;
  let employeeTokenOrgB: string;

  beforeAll(async () => {
    app = await buildTestApp();
    employeeToken     = signEmployeeToken(app, ORG_A_EMPLOYEE_ID, TEST_ORG_ID);
    adminToken        = signAdminToken(app, TEST_ADMIN_ID, TEST_ORG_ID);
    employeeTokenOrgB = signEmployeeToken(app, ORG_B_EMPLOYEE_ID, TEST_ORG_ID_B);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockStorageSuccess(storagePath = STORAGE_PATH): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseServiceClient.storage.from as any).mockReturnValue({
      createSignedUploadUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: UPLOAD_URL, path: storagePath },
        error: null,
      }),
    });
  }

  // ── Authentication ─────────────────────────────────────────────────────────

  it("returns 401 without a JWT", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/expenses/receipt-upload-url",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when caller has no employee context (ADMIN-only token)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/expenses/receipt-upload-url",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ extension: "jpg" }),
    });
    // requireEmployeeContext() throws ForbiddenError when employee_id is absent from token
    expect(res.statusCode).toBe(403);
  });

  // ── Extension validation ───────────────────────────────────────────────────

  it("returns 400 for an unsupported file extension", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/expenses/receipt-upload-url",
      headers: {
        authorization: `Bearer ${employeeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ extension: "exe" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when extension field is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/expenses/receipt-upload-url",
      headers: {
        authorization: `Bearer ${employeeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts all allowed extensions", async () => {
    const allowed = ["jpg", "jpeg", "png", "webp", "pdf"] as const;

    for (const ext of allowed) {
      mockStorageSuccess();

      const res = await app.inject({
        method: "POST",
        url: "/expenses/receipt-upload-url",
        headers: {
          authorization: `Bearer ${employeeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ extension: ext }),
      });

      expect(res.statusCode, `Expected 200 for extension: ${ext}`).toBe(200);
    }
  });

  // ── MIME type validation ───────────────────────────────────────────────────

  it("returns 400 when mimeType does not match the declared extension", async () => {
    // Declaring extension=jpg but sending mimeType=application/pdf is a spoofable
    // mismatch and must be rejected before a signed URL is generated.
    const res = await app.inject({
      method: "POST",
      url: "/expenses/receipt-upload-url",
      headers: {
        authorization: `Bearer ${employeeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ extension: "jpg", mimeType: "application/pdf" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when mimeType is not an allowed type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/expenses/receipt-upload-url",
      headers: {
        authorization: `Bearer ${employeeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ extension: "jpg", mimeType: "text/html" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 when mimeType correctly matches the extension", async () => {
    mockStorageSuccess();

    const res = await app.inject({
      method: "POST",
      url: "/expenses/receipt-upload-url",
      headers: {
        authorization: `Bearer ${employeeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ extension: "jpg", mimeType: "image/jpeg" }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      success: boolean;
      data: { uploadUrl: string; receiptUrl: string };
    };
    expect(body.success).toBe(true);
    expect(typeof body.data.uploadUrl).toBe("string");
    expect(typeof body.data.receiptUrl).toBe("string");
  });

  it("returns 200 with uploadUrl and receiptUrl when request is valid", async () => {
    mockStorageSuccess();

    const res = await app.inject({
      method: "POST",
      url: "/expenses/receipt-upload-url",
      headers: {
        authorization: `Bearer ${employeeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ extension: "jpg" }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      success: boolean;
      data: { uploadUrl: string; receiptUrl: string };
    };
    expect(body.success).toBe(true);
    expect(typeof body.data.uploadUrl).toBe("string");
    expect(typeof body.data.receiptUrl).toBe("string");
  });

  // ── Tenant-scoped storage paths ────────────────────────────────────────────

  it("storage path is scoped to the employee's own organization", async () => {
    let capturedPath: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseServiceClient.storage.from as any).mockReturnValue({
      createSignedUploadUrl: vi.fn().mockImplementation((path: string) => {
        capturedPath = path;
        return Promise.resolve({ data: { signedUrl: UPLOAD_URL, path }, error: null });
      }),
    });

    await app.inject({
      method: "POST",
      url: "/expenses/receipt-upload-url",
      headers: {
        authorization: `Bearer ${employeeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ extension: "png" }),
    });

    expect(capturedPath).toBeDefined();
    // Path must start with the employee's own org ID
    expect(capturedPath!.startsWith(TEST_ORG_ID)).toBe(true);
    // Path must NOT start with Org B's ID
    expect(capturedPath!.startsWith(TEST_ORG_ID_B)).toBe(false);
    // Second path segment must be the employee's own ID
    expect(capturedPath!.split("/")[1]).toBe(ORG_A_EMPLOYEE_ID);
  });

  it("Org B employee upload path is scoped to Org B, not Org A", async () => {
    let capturedPath: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseServiceClient.storage.from as any).mockReturnValue({
      createSignedUploadUrl: vi.fn().mockImplementation((path: string) => {
        capturedPath = path;
        return Promise.resolve({ data: { signedUrl: UPLOAD_URL, path }, error: null });
      }),
    });

    await app.inject({
      method: "POST",
      url: "/expenses/receipt-upload-url",
      headers: {
        authorization: `Bearer ${employeeTokenOrgB}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ extension: "pdf" }),
    });

    expect(capturedPath).toBeDefined();
    expect(capturedPath!.startsWith(TEST_ORG_ID_B)).toBe(true);
    expect(capturedPath!.startsWith(TEST_ORG_ID)).toBe(false);
    expect(capturedPath!.split("/")[1]).toBe(ORG_B_EMPLOYEE_ID);
  });
});
