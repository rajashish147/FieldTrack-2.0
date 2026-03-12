import { describe, it, expect, vi } from "vitest";
import { enforceTenant } from "../../../src/utils/tenant.js";
import { tenantQuery } from "../../../src/utils/tenantQuery.js";
import type { TenantContext } from "../../../src/utils/tenant.js";

// ─── Shared mock query builder ────────────────────────────────────────────────

function makeMockQuery(orgId?: string) {
  const calls: Array<{ column: string; value: string }> = [];
  return {
    eq(column: string, value: string) {
      calls.push({ column, value });
      return this;
    },
    getCalls: () => calls,
  };
}

const ORG_ID = "11111111-1111-1111-1111-111111111111";

// ─── enforceTenant ────────────────────────────────────────────────────────────

describe("enforceTenant()", () => {
  it("calls .eq('organization_id', orgId) on the query", () => {
    const q = makeMockQuery();
    const ctx: TenantContext = { organizationId: ORG_ID };
    enforceTenant(ctx, q);
    expect(q.getCalls()[0]).toEqual({ column: "organization_id", value: ORG_ID });
  });

  it("returns the same query object (fluent chain)", () => {
    const q = makeMockQuery();
    const ctx: TenantContext = { organizationId: ORG_ID };
    const result = enforceTenant(ctx, q);
    expect(result).toBe(q);
  });

  it("accepts a minimal TenantContext (not a full FastifyRequest)", () => {
    const ctx: TenantContext = { organizationId: ORG_ID };
    const q = makeMockQuery();
    expect(() => enforceTenant(ctx, q)).not.toThrow();
  });

  it("accepts a FastifyRequest-shaped object with organizationId", () => {
    const fakeRequest = {
      organizationId: ORG_ID,
      user: { sub: "user-id", role: "EMPLOYEE", organization_id: ORG_ID },
    } as never;
    const q = makeMockQuery();
    expect(() => enforceTenant(fakeRequest, q)).not.toThrow();
    expect(q.getCalls()[0]?.value).toBe(ORG_ID);
  });

  it("throws when organizationId is missing from context", () => {
    const ctx = { organizationId: "" } as TenantContext;
    const q = makeMockQuery();
    expect(() => enforceTenant(ctx, q)).toThrow(
      "Tenant enforcement failed: organizationId missing from context",
    );
  });

  it("throws when organizationId is undefined", () => {
    const ctx = { organizationId: undefined } as unknown as TenantContext;
    const q = makeMockQuery();
    expect(() => enforceTenant(ctx, q)).toThrow();
  });

  it("error message is descriptive", () => {
    const ctx = { organizationId: "" } as TenantContext;
    expect(() => enforceTenant(ctx, makeMockQuery())).toThrow(
      /organizationId missing/,
    );
  });
});

// ─── tenantQuery ──────────────────────────────────────────────────────────────

describe("tenantQuery()", () => {
  it("calls .eq('organization_id', orgId) on the query", () => {
    const q = makeMockQuery();
    const ctx: TenantContext = { organizationId: ORG_ID };
    tenantQuery(ctx, q);
    expect(q.getCalls()[0]).toEqual({ column: "organization_id", value: ORG_ID });
  });

  it("returns the same query object (fluent chain)", () => {
    const q = makeMockQuery();
    const result = tenantQuery({ organizationId: ORG_ID }, q);
    expect(result).toBe(q);
  });

  it("throws when organizationId is empty", () => {
    const ctx = { organizationId: "" } as TenantContext;
    expect(() => tenantQuery(ctx, makeMockQuery())).toThrow(
      "Tenant enforcement failed: organizationId missing from context",
    );
  });

  it("throws when organizationId is undefined", () => {
    const ctx = { organizationId: undefined } as unknown as TenantContext;
    expect(() => tenantQuery(ctx, makeMockQuery())).toThrow();
  });

  it("is functionally equivalent to enforceTenant for the same context", () => {
    const ctx: TenantContext = { organizationId: ORG_ID };
    const q1 = makeMockQuery();
    const q2 = makeMockQuery();
    enforceTenant(ctx, q1);
    tenantQuery(ctx, q2);
    expect(q1.getCalls()).toEqual(q2.getCalls());
  });
});
