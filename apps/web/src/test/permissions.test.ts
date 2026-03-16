import { describe, it, expect } from "vitest";
import { derivePermissions } from "@/lib/permissions";

describe("derivePermissions", () => {
  it("ADMIN gets all permissions", () => {
    const perms = derivePermissions("ADMIN");
    expect(perms.viewAnalytics).toBe(true);
    expect(perms.viewOrgSessions).toBe(true);
    expect(perms.manageExpenses).toBe(true);
  });

  it("EMPLOYEE gets limited permissions", () => {
    const perms = derivePermissions("EMPLOYEE");
    expect(perms.viewSessions).toBe(true);
    expect(perms.viewExpenses).toBe(true);
    expect(perms.viewAnalytics).toBe(false);
    expect(perms.viewOrgSessions).toBe(false);
    expect(perms.manageExpenses).toBe(false);
  });
});
