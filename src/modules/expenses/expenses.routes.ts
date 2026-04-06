import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole, requireEmployeeHook } from "../../middleware/role-guard.js";
import { expensesController } from "./expenses.controller.js";
import { expensesRepository } from "./expenses.repository.js";
import { handleError, paginated } from "../../utils/response.js";
import {
  createExpenseBodySchema,
  expensePaginationSchema,
  updateExpenseStatusBodySchema,
} from "./expenses.schema.js";

/**
 * Expense routes.
 *
 * EMPLOYEE endpoints:
 *   POST  /expenses                   — create a new expense (rate-limited per user)
 *   GET   /expenses/my                — list own expenses (paginated)
 *   POST  /expenses/receipt-upload-url — get a signed upload URL for a receipt file
 *
 * ADMIN endpoints:
 *   GET   /admin/expenses             — list all org expenses (paginated)
 *   PATCH /admin/expenses/:id         — approve or reject a PENDING expense
 */
export async function expensesRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /expenses/receipt-upload-url
   *
   * Returns a short-lived Supabase Storage signed upload URL so the client can
   * upload a receipt file directly without routing bytes through the API server.
   *
   * Body:  { extension: "jpg" | "jpeg" | "png" | "webp" | "pdf" }
   * Response: { uploadUrl: string, receiptUrl: string }
   *   - uploadUrl:  PUT this URL with the raw file bytes + correct Content-Type
   *   - receiptUrl: the storage path to save as receipt_url on the expense record
   *
   * Must be declared BEFORE /expenses/my to avoid Fastify treating "receipt-upload-url"
   * as a dynamic :id segment.
   */
  app.post(
    "/expenses/receipt-upload-url",
    {
      schema: {
        tags: ["expenses"],
        body: z.object({
          extension: z.enum(["jpg", "jpeg", "png", "webp", "pdf"], {
            error: "extension must be one of: jpg, jpeg, png, webp, pdf",
          }),
          // Optional: when provided, the server validates extension ↔ MIME alignment
          // before issuing a signed URL, giving the client an early rejection rather
          // than letting the upload fail at the storage layer.
          mimeType: z.string().optional(),
        }),
      },
      // EMPLOYEE only — the signed URL path embeds employeeId; ADMIN has no
      // employee record and will be rejected by requireEmployeeHook.
      preValidation: [authenticate, requireRole("EMPLOYEE"), requireEmployeeHook],
    },
    expensesController.getReceiptUploadUrl,
  );

  app.post(
    "/expenses",
    {
      schema: { tags: ["expenses"], body: createExpenseBodySchema },
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60_000,
          keyGenerator: (req: FastifyRequest): string => req.user?.sub ?? req.ip,
        },
      },
      // Employee-only: ADMIN users cannot create expenses. requireEmployeeHook
      // enforces employee context at the route level (not just in service code).
      preValidation: [authenticate, requireEmployeeHook],
    },
    expensesController.create,
  );

  app.get(
    "/expenses/my",
    {
      schema: {
        tags: ["expenses"],
        querystring: expensePaginationSchema,
      },
      // No role restriction — service returns [] when employeeId is absent (admin users)
      preValidation: [authenticate],
    },
    expensesController.getMy,
  );

  app.get(
    "/admin/expenses",
    {
      schema: {
        tags: ["admin"],
        querystring: expensePaginationSchema,
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    expensesController.getOrgAll,
  );

  app.patch<{ Params: { id: string } }>(
    "/admin/expenses/:id",
    {
      schema: { tags: ["admin"], body: updateExpenseStatusBodySchema },
      // preValidation ensures auth/role fires before body validation
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    expensesController.updateStatus,
  );

  /**
   * GET /admin/expenses/summary
   *
   * Returns one aggregated row per employee instead of individual expense records.
   * Drastically reduces payload size for orgs with hundreds of expenses.
   *
   * Each row contains:
   *  - pendingCount / pendingAmount  — actionable backlog
   *  - totalCount  / totalAmount     — lifetime totals
   *  - latestExpenseDate             — for recency sorting
   *
   * Sorted: employees with ≥1 pending expense first, then by latest date DESC.
   */
  app.get(
    "/admin/expenses/summary",
    {
      schema: {
        tags: ["admin"],
        querystring: z.object({
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(1000).default(50),
        }),
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const { page, limit } = request.query as { page: number; limit: number };
        const result = await expensesRepository.findExpenseSummaryByEmployee(
          request,
          page,
          limit,
        );
        reply.status(200).send(paginated(result.data, page, limit, result.total));
      } catch (error) {
        handleError(error, request, reply, "Unexpected error fetching expense summary");
      }
    },
  );
  /**
   * GET /admin/expenses/export
   *
   * Returns all org expenses as a UTF-8 CSV file.
   * The browser receives Content-Disposition: attachment so it saves immediately.
   * Supports optional ?employee_id= filter.
   *
   * Auth: ADMIN only.
   */
  app.get(
    "/admin/expenses/export",
    {
      schema: {
        tags: ["admin"],
        description: "Export all org expenses as CSV (ADMIN only).",
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const query = request.query as Record<string, string | undefined>;
        const employeeId = query.employee_id;

        // Fetch all matching expenses (no pagination for export)
        const result = await expensesRepository.findExpensesByOrg(request, 1, 10_000, employeeId);
        const rows = result.data;

        const HEADERS = [
          "id", "employee_code", "employee_name",
          "amount", "description", "status", "rejection_comment",
          "submitted_at", "reviewed_at",
        ];

        function escapeCsv(val: unknown): string {
          const s = val == null ? "" : String(val);
          if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
            return `"${s.replace(/"/g, "\"\"")}"`;
          }
          return s;
        }

        const lines = [
          HEADERS.join(","),
          ...rows.map((r) =>
            [
              r.id,
              r.employee_code,
              r.employee_name,
              r.amount,
              r.description,
              r.status,
              (r as Record<string, unknown>).rejection_comment,
              r.submitted_at,
              r.reviewed_at,
            ]
              .map(escapeCsv)
              .join(","),
          ),
        ];

        const csv = lines.join("\r\n");
        const filename = `expenses-${new Date().toISOString().substring(0, 10)}.csv`;

        reply
          .status(200)
          .header("Content-Type", "text/csv; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="${filename}"`)
          .send(csv);
      } catch (error) {
        handleError(error, request, reply, "Unexpected error exporting expenses");
      }
    },
  );}
