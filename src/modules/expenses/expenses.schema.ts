import { z } from "zod";
import type { Expense, ExpenseStatus } from "../../types/db.js";

// ─── Database Row Type ────────────────────────────────────────────────────────
// Phase 16 — confirmed final schema for expenses.

export const EXPENSE_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type { ExpenseStatus, Expense };

// ─── Request Schemas ──────────────────────────────────────────────────────────

export const createExpenseBodySchema = z.object({
  amount: z
    .number({ error: "amount must be a number" })
    .positive({ message: "amount must be greater than 0" }),
  description: z
    .string()
    .min(3, { message: "description must be at least 3 characters" })
    .max(500, { message: "description must not exceed 500 characters" }),
  receipt_url: z
    .string()
    .url({ message: "receipt_url must be a valid URL" })
    .refine((url) => url.startsWith("https://"), {
      message: "receipt_url must use HTTPS",
    })
    .optional(),
  idempotency_key: z
    .string()
    .min(1, { message: "idempotency_key must not be empty" })
    .max(255, { message: "idempotency_key must not exceed 255 characters" })
    .optional(),
});

export type CreateExpenseBody = z.infer<typeof createExpenseBodySchema>;

export const updateExpenseStatusBodySchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"], {
    error: "status must be APPROVED or REJECTED",
  }),
  rejection_comment: z
    .string()
    .max(1000, { message: "rejection_comment must not exceed 1000 characters" })
    .optional(),
});

export type UpdateExpenseStatusBody = z.infer<
  typeof updateExpenseStatusBodySchema
>;

// TODO (future phase): replace offset pagination with cursor-based pagination
// to support large datasets without heavy DB scans.
export const expensePaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ExpensePaginationQuery = z.infer<typeof expensePaginationSchema>;

// ─── Response Types ───────────────────────────────────────────────────────────

export interface ExpenseResponse {
  success: true;
  data: Expense;
}

export interface ExpenseListResponse {
  success: true;
  data: Expense[];
}
