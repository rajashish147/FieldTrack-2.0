import { expect } from "vitest";

export function expectEmployeeRoleError(body: { error: string }) {
  expect(body.error).toMatch(/requires employee role/i);
}
