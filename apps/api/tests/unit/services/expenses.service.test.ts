import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  ExpenseAlreadyReviewed,
  ForbiddenError,
  NotFoundError,
} from "../../../src/utils/errors.js";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../../../src/modules/expenses/expenses.repository.js", () => ({
  expensesRepository: {
    createExpense: vi.fn(),
    findExpenseById: vi.fn(),
    findExpensesByUser: vi.fn(),
    findExpensesByOrg: vi.fn(),
    updateExpenseStatus: vi.fn(),
  },
}));

// No attendanceRepository mock needed — expenses.service.ts no longer imports it.

import { expensesService } from "../../../src/modules/expenses/expenses.service.js";
import { expensesRepository } from "../../../src/modules/expenses/expenses.repository.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const ADMIN_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const EMPLOYEE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const EXPENSE_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function makeFakeRequest(
  role: "ADMIN" | "EMPLOYEE" = "ADMIN",
  employeeId?: string,
): FastifyRequest {
  return {
    user: { sub: role === "ADMIN" ? ADMIN_ID : EMPLOYEE_ID, role, organization_id: ORG_ID },
    organizationId: ORG_ID,
    employeeId,
    id: "test-req-id",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as FastifyRequest;
}

const pendingExpense = {
  id: EXPENSE_ID,
  employee_id: EMPLOYEE_ID,
  organization_id: ORG_ID,
  amount: 50.0,
  description: "Team lunch",
  status: "PENDING" as const,
  receipt_url: null,
  reviewed_by: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  employee_code: "EMP001",
  employee_name: "Test Employee",
};

const approvedExpense = {
  ...pendingExpense,
  status: "APPROVED" as const,
  reviewed_by: ADMIN_ID,
};

const rejectedExpense = {
  ...pendingExpense,
  status: "REJECTED" as const,
  reviewed_by: ADMIN_ID,
};

// ─── expensesService.updateExpenseStatus ──────────────────────────────────────

describe("expensesService.updateExpenseStatus()", () => {
  beforeEach(() => {
    vi.mocked(expensesRepository.findExpenseById).mockResolvedValue(
      pendingExpense as never,
    );
    vi.mocked(expensesRepository.updateExpenseStatus).mockResolvedValue(
      approvedExpense as never,
    );
  });

  it("approves a PENDING expense", async () => {
    const result = await expensesService.updateExpenseStatus(
      makeFakeRequest(),
      EXPENSE_ID,
      { status: "APPROVED" },
    );
    expect(result.status).toBe("APPROVED");
  });

  it("rejects a PENDING expense", async () => {
    vi.mocked(expensesRepository.updateExpenseStatus).mockResolvedValue(
      rejectedExpense as never,
    );
    const result = await expensesService.updateExpenseStatus(
      makeFakeRequest(),
      EXPENSE_ID,
      { status: "REJECTED", rejection_comment: "test rejection reason" },
    );
    expect(result.status).toBe("REJECTED");
  });

  it("calls updateExpenseStatus with the correct arguments", async () => {
    await expensesService.updateExpenseStatus(makeFakeRequest(), EXPENSE_ID, {
      status: "APPROVED",
    });
    expect(expensesRepository.updateExpenseStatus).toHaveBeenCalledWith(
      expect.anything(),
      EXPENSE_ID,
      "APPROVED",
      ADMIN_ID,
      undefined,
    );
  });

  it("throws NotFoundError when expense does not exist", async () => {
    vi.mocked(expensesRepository.findExpenseById).mockResolvedValue(null);
    await expect(
      expensesService.updateExpenseStatus(makeFakeRequest(), EXPENSE_ID, {
        status: "APPROVED",
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("throws ExpenseAlreadyReviewed when expense is already APPROVED", async () => {
    vi.mocked(expensesRepository.findExpenseById).mockResolvedValue(
      approvedExpense as never,
    );
    await expect(
      expensesService.updateExpenseStatus(makeFakeRequest(), EXPENSE_ID, {
        status: "REJECTED",
      }),
    ).rejects.toThrow(ExpenseAlreadyReviewed);
  });

  it("throws ExpenseAlreadyReviewed when expense is already REJECTED", async () => {
    vi.mocked(expensesRepository.findExpenseById).mockResolvedValue(
      rejectedExpense as never,
    );
    await expect(
      expensesService.updateExpenseStatus(makeFakeRequest(), EXPENSE_ID, {
        status: "APPROVED",
      }),
    ).rejects.toThrow(ExpenseAlreadyReviewed);
  });

  it("error message for already-reviewed includes the current status", async () => {
    vi.mocked(expensesRepository.findExpenseById).mockResolvedValue(
      approvedExpense as never,
    );
    try {
      await expensesService.updateExpenseStatus(makeFakeRequest(), EXPENSE_ID, {
        status: "REJECTED",
      });
    } catch (e) {
      expect((e as Error).message.toLowerCase()).toContain("approved");
    }
  });

  it("does NOT call updateExpenseStatus when expense is not found", async () => {
    vi.mocked(expensesRepository.findExpenseById).mockResolvedValue(null);
    await expect(
      expensesService.updateExpenseStatus(makeFakeRequest(), EXPENSE_ID, {
        status: "APPROVED",
      }),
    ).rejects.toThrow();
    expect(expensesRepository.updateExpenseStatus).not.toHaveBeenCalled();
  });
});

// ─── expensesService.createExpense ────────────────────────────────────────────

describe("expensesService.createExpense()", () => {
  it("returns the newly created expense", async () => {
    vi.mocked(expensesRepository.createExpense).mockResolvedValue(
      pendingExpense as never,
    );
    // Pass employeeId on the request (normally set by auth middleware)
    const request = makeFakeRequest("EMPLOYEE", EMPLOYEE_ID);
    const result = await expensesService.createExpense(request, {
      amount: 50,
      description: "Team lunch",
    });
    expect(result).toEqual(pendingExpense);
  });

  it("calls createExpense with the authenticated employee id from request", async () => {
    vi.mocked(expensesRepository.createExpense).mockResolvedValue(
      pendingExpense as never,
    );
    const request = makeFakeRequest("EMPLOYEE", EMPLOYEE_ID);
    await expensesService.createExpense(request, {
      amount: 50,
      description: "Team lunch",
    });
    expect(expensesRepository.createExpense).toHaveBeenCalledWith(
      expect.anything(),
      EMPLOYEE_ID,
      expect.objectContaining({ amount: 50, description: "Team lunch" }),
    );
  });

  it("throws ForbiddenError when request.employeeId is undefined", async () => {
    const request = makeFakeRequest("EMPLOYEE", undefined);
    await expect(
      expensesService.createExpense(request, { amount: 50, description: "Test" }),
    ).rejects.toThrow(ForbiddenError);
  });
});
