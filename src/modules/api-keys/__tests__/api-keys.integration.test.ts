import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerZod } from "../../../plugins/zod.plugin.js";
import { apiKeysRoutes } from "../api-keys.routes.js";
import { authenticate } from "../../../middleware/auth.js";
import rateLimitPlugin from "../../../plugins/security/ratelimit.plugin.js";
import { ok } from "../../../utils/response.js";
import { AppError } from "../../../utils/errors.js";

const TEST_ORG_ID = "11111111-1111-4111-8111-111111111111";
const TEST_ADMIN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEST_JWT_SECRET = "test-secret";

interface StoreRow {
  id: string;
  organization_id: string;
  name: string;
  key_hash: string;
  key_salt: string;
  key_prefix: string;
  scopes: Array<"read:employees" | "read:sessions" | "write:expenses" | "admin:all">;
  active: boolean;
  request_count: number;
  error_count: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const keyStore = new Map<string, StoreRow>();

function toPublic(row: StoreRow) {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    active: row.active,
    request_count: row.request_count,
    error_count: row.error_count,
    key_preview: `${row.key_prefix}...`,
  };
}

vi.mock("../api-keys.repository.js", () => ({
  apiKeysRepository: {
    create: vi.fn(async (request: { organizationId: string; user: { sub: string } }, body: { name: string; scopes: StoreRow["scopes"] }, keyHash: string, keySalt: string, keyPrefix: string) => {
      const now = new Date().toISOString();
      const row: StoreRow = {
        id: randomUUID(),
        organization_id: request.organizationId,
        name: body.name,
        key_hash: keyHash,
        key_salt: keySalt,
        key_prefix: keyPrefix,
        scopes: body.scopes,
        active: true,
        request_count: 0,
        error_count: 0,
        created_at: now,
        updated_at: now,
        last_used_at: null,
        revoked_at: null,
      };
      keyStore.set(row.id, row);
      return toPublic(row);
    }),

    list: vi.fn(async (request: { organizationId: string }) =>
      Array.from(keyStore.values())
        .filter((row) => row.organization_id === request.organizationId)
        .map((row) => toPublic(row))),

    findById: vi.fn(async (request: { organizationId: string }, id: string) => {
      const row = keyStore.get(id) ?? null;
      if (!row) return null;
      if (row.organization_id !== request.organizationId) return null;
      return row;
    }),

    update: vi.fn(async (request: { organizationId: string }, id: string, body: { name?: string; scopes?: StoreRow["scopes"]; active?: boolean }) => {
      const row = keyStore.get(id);
      if (!row || row.organization_id !== request.organizationId) {
        throw new Error("not found");
      }
      if (body.name !== undefined) row.name = body.name;
      if (body.scopes !== undefined) row.scopes = body.scopes;
      if (body.active !== undefined) {
        row.active = body.active;
        row.revoked_at = body.active ? null : new Date().toISOString();
      }
      row.updated_at = new Date().toISOString();
      keyStore.set(id, row);
      return toPublic(row);
    }),

    remove: vi.fn(async (request: { organizationId: string }, id: string) => {
      const row = keyStore.get(id);
      if (!row || row.organization_id !== request.organizationId) {
        throw new Error("not found");
      }
      keyStore.delete(id);
    }),

    findActiveByPrefix: vi.fn(async (keyPrefix: string) =>
      Array.from(keyStore.values())
        .filter((x) => x.key_prefix === keyPrefix && x.active && x.revoked_at === null)
        .map((row) => ({
          id: row.id,
          organization_id: row.organization_id,
          key_hash: row.key_hash,
          key_salt: row.key_salt,
          scopes: row.scopes,
          active: row.active,
        }))),

    markUsed: vi.fn(async (id: string) => {
      const row = keyStore.get(id);
      if (!row) return;
      row.request_count += 1;
      row.last_used_at = new Date().toISOString();
      keyStore.set(id, row);
    }),

    markError: vi.fn(async (id: string) => {
      const row = keyStore.get(id);
      if (!row) return;
      row.error_count += 1;
      keyStore.set(id, row);
    }),
  },
}));

async function buildApiKeyTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerZod(app);

  await app.register(fastifyJwt, {
    secret: TEST_JWT_SECRET,
  });

  await app.register(rateLimitPlugin);

  app.addHook("onResponse", async (request, reply) => {
    if (request.authType === "api_key" && request.apiKeyId && reply.statusCode >= 400) {
      const { apiKeysRepository } = await import("../api-keys.repository.js");
      void apiKeysRepository.markError(request.apiKeyId);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({
        success: false,
        error: error.message,
        requestId: request.id,
      });
      return;
    }

    const handled = error as { statusCode?: number; message?: string };
    const builtinStatus = handled.statusCode;
    if (builtinStatus !== undefined && builtinStatus >= 400 && builtinStatus < 500) {
      void reply.status(builtinStatus).send({
        success: false,
        error: handled.message ?? "Request failed",
        requestId: request.id,
      });
      return;
    }

    void reply.status(500).send({
      success: false,
      error: "Internal server error",
      requestId: request.id,
    });
  });

  await app.register(apiKeysRoutes);

  app.get("/admin/employees/probe", { preValidation: [authenticate] }, async () => ok({ route: "employees" }));
  app.post("/expenses", { preValidation: [authenticate] }, async () => ok({ route: "expenses" }));
  app.get("/admin/system-health/probe", { preValidation: [authenticate] }, async () => ok({ route: "system-health" }));

  await app.ready();
  return app;
}

function signAdminToken(app: FastifyInstance): string {
  const signer = app.jwt as unknown as { sign: (payload: Record<string, unknown>) => string };
  return signer.sign({ sub: TEST_ADMIN_ID, role: "ADMIN", org_id: TEST_ORG_ID });
}

async function createKey(app: FastifyInstance, adminToken: string, name: string, scopes: StoreRow["scopes"]) {
  const res = await app.inject({
    method: "POST",
    url: "/admin/api-keys",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, scopes }),
  });

  expect(res.statusCode).toBe(201);
  return res.json<{ success: true; data: { key: string; record: { id: string } } }>().data;
}

async function waitForUsageRow(
  app: FastifyInstance,
  adminToken: string,
  keyId: string,
): Promise<{ request_count: number; error_count: number } | undefined> {
  for (let i = 0; i < 10; i += 1) {
    const listRes = await app.inject({
      method: "GET",
      url: "/admin/api-keys",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const row = listRes
      .json<{ success: true; data: Array<{ id: string; request_count: number; error_count: number }> }>()
      .data.find((r) => r.id === keyId);

    if ((row?.request_count ?? 0) >= 1 && (row?.error_count ?? 0) >= 1) {
      return row;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const finalRes = await app.inject({
    method: "GET",
    url: "/admin/api-keys",
    headers: { authorization: `Bearer ${adminToken}` },
  });

  return finalRes
    .json<{ success: true; data: Array<{ id: string; request_count: number; error_count: number }> }>()
    .data.find((r) => r.id === keyId);
}

describe("API Keys integration", () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildApiKeyTestApp();
    adminToken = signAdminToken(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    keyStore.clear();
    vi.clearAllMocks();
  });

  it("API key lifecycle: create -> list -> disable -> delete", async () => {
    const created = await createKey(app, adminToken, "Lifecycle key", ["read:employees"]);

    const list1 = await app.inject({
      method: "GET",
      url: "/admin/api-keys",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list1.statusCode).toBe(200);
    const rows1 = list1.json<{ success: true; data: Array<{ id: string; key_preview: string }> }>().data;
    expect(rows1.find((r) => r.id === created.record.id)).toBeTruthy();
    expect(rows1[0].key_preview).toMatch(/^ft_live_[a-f0-9]{8}\.\.\.$/i);

    const disable = await app.inject({
      method: "PATCH",
      url: `/admin/api-keys/${created.record.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ active: false }),
    });
    expect(disable.statusCode).toBe(200);

    const del = await app.inject({
      method: "DELETE",
      url: `/admin/api-keys/${created.record.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(204);
  });

  it("Authentication: valid key success, invalid key 401, missing key falls back to JWT", async () => {
    const created = await createKey(app, adminToken, "Auth key", ["read:employees"]);

    const valid = await app.inject({
      method: "GET",
      url: "/admin/employees/probe",
      headers: { "x-api-key": created.key },
    });
    expect(valid.statusCode).toBe(200);

    const invalid = await app.inject({
      method: "GET",
      url: "/admin/employees/probe",
      headers: { "x-api-key": "ft_live_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    });
    expect(invalid.statusCode).toBe(401);

    const jwtFallback = await app.inject({
      method: "GET",
      url: "/admin/employees/probe",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(jwtFallback.statusCode).toBe(200);
  });

  it("Scope enforcement: read key cannot write, write key cannot access admin, admin key has full access", async () => {
    const readKey = await createKey(app, adminToken, "Read key", ["read:employees"]);
    const readOk = await app.inject({ method: "GET", url: "/admin/employees/probe", headers: { "x-api-key": readKey.key } });
    expect(readOk.statusCode).toBe(200);
    const readCantWrite = await app.inject({ method: "POST", url: "/expenses", headers: { "x-api-key": readKey.key } });
    expect(readCantWrite.statusCode).toBe(403);

    const writeKey = await createKey(app, adminToken, "Write key", ["write:expenses"]);
    const writeOk = await app.inject({ method: "POST", url: "/expenses", headers: { "x-api-key": writeKey.key } });
    expect(writeOk.statusCode).toBe(200);
    const writeCantAdmin = await app.inject({ method: "GET", url: "/admin/system-health/probe", headers: { "x-api-key": writeKey.key } });
    expect(writeCantAdmin.statusCode).toBe(403);

    const adminKey = await createKey(app, adminToken, "Admin key", ["admin:all"]);
    const adminRead = await app.inject({ method: "GET", url: "/admin/system-health/probe", headers: { "x-api-key": adminKey.key } });
    expect(adminRead.statusCode).toBe(200);
    const adminWrite = await app.inject({ method: "POST", url: "/expenses", headers: { "x-api-key": adminKey.key } });
    expect(adminWrite.statusCode).toBe(200);
  });

  it("Rate limiting: exceeding per-key limit returns 429", async () => {
    const adminKey = await createKey(app, adminToken, "Burst key", ["admin:all"]);

    let hit429 = false;
    for (let i = 0; i < 620; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/admin/system-health/probe",
        headers: { "x-api-key": adminKey.key },
      });
      if (res.statusCode === 429) {
        hit429 = true;
        break;
      }
    }

    expect(hit429).toBe(true);
  }, 60_000);

  it("Usage tracking: request_count and error_count increment", async () => {
    const readKey = await createKey(app, adminToken, "Usage key", ["read:employees"]);

    const successRes = await app.inject({
      method: "GET",
      url: "/admin/employees/probe",
      headers: { "x-api-key": readKey.key },
    });
    expect(successRes.statusCode).toBe(200);

    const errorRes = await app.inject({
      method: "POST",
      url: "/expenses",
      headers: { "x-api-key": readKey.key },
    });
    expect(errorRes.statusCode).toBe(403);

    const row = await waitForUsageRow(app, adminToken, readKey.record.id);

    expect(row).toBeTruthy();
    expect((row?.request_count ?? 0) >= 1).toBe(true);
    expect((row?.error_count ?? 0) >= 1).toBe(true);
  });

  it("Revocation: disabled key is rejected immediately", async () => {
    const created = await createKey(app, adminToken, "Revoked key", ["admin:all"]);

    const disable = await app.inject({
      method: "PATCH",
      url: `/admin/api-keys/${created.record.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ active: false }),
    });
    expect(disable.statusCode).toBe(200);

    const denied = await app.inject({
      method: "GET",
      url: "/admin/system-health/probe",
      headers: { "x-api-key": created.key },
    });
    expect(denied.statusCode).toBe(401);
  });
});
