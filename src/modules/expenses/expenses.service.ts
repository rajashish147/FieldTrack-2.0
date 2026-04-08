import { randomUUID } from "crypto";
import type { FastifyRequest } from "fastify";
import { expensesRepository } from "./expenses.repository.js";
import { BadRequestError, ExpenseAlreadyReviewed, ForbiddenError, NotFoundError, requireEmployeeContext } from "../../utils/errors.js";
import type {
  Expense,
  CreateExpenseBody,
  UpdateExpenseStatusBody,
} from "./expenses.schema.js";
import type { EnrichedExpense } from "./expenses.repository.js";
import { profileRepository } from "../profile/profile.repository.js";
import { analyticsMetricsRepository } from "../analytics/analytics.metrics.repository.js";
import { invalidateOrgAnalytics } from "../../utils/cache.js";
import { sseEventBus } from "../../utils/sse-emitter.js";
import { emitEvent } from "../../utils/event-bus.js";
import { supabaseServiceClient } from "../../config/supabase.js";
import { enqueueExpenseCreated, enqueueExpenseResolved } from "../../workers/snapshot.queue.js";

/**
 * Expenses service — business rules for expense management.
 *
 * Phase: employeeId resolved once in auth middleware (request.employeeId).
 * The attendanceRepository import has been removed.
 *
 * EMPLOYEE rules:
 *  - Can create an expense (status always starts as PENDING).
 *  - Can view only their own expenses.
 *  - Cannot modify an expense after creation.
 *
 * ADMIN rules:
 *  - Can view all org expenses.
 *  - Can approve or reject a PENDING expense.
 *  - Cannot act on expenses from other organizations (enforced via enforceTenant()).
 */
export const expensesService = {
  /**
   * Create a new expense for the authenticated employee.
   * Status is always PENDING on creation — no override allowed.
   */
  async createExpense(
    request: FastifyRequest,
    body: CreateExpenseBody,
  ): Promise<Expense> {
    // M6: ADMIN users manage the org — they must not submit expenses as employees.
    if (request.user.role === "ADMIN") {
      throw new ForbiddenError("Admin users cannot create expenses.");
    }
    requireEmployeeContext(request);
    const employeeId = request.employeeId;

    const expense = await expensesRepository.createExpense(
      request,
      employeeId,
      body,
    );

    // Update last_activity_at (fire-and-forget)
    profileRepository.updateLastActivity(request, employeeId).catch(() => {});

    // UPSERT employee_daily_metrics + invalidate analytics cache (fire-and-forget)
    const today = new Date().toISOString().substring(0, 10);
    analyticsMetricsRepository
      .upsertEmployeeDailyExpenseMetrics({
        organizationId: request.organizationId,
        employeeId,
        date: today,
        amountDelta: expense.amount,
      })
      .then(() => invalidateOrgAnalytics(request.organizationId))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.warn(
          { expenseId: expense.id, employeeId, error: msg },
          "Failed to update daily analytics after expense creation",
        );
      });

    request.log.info(
      {
        event: "expense_created",
        expenseId: expense.id,
        userId: request.user.sub,
        employeeId,
        organizationId: request.organizationId,
        amount: expense.amount,
      },
      "Expense created",
    );

    sseEventBus.emitOrgEvent(request.organizationId, "expense.created", {
      expenseId: expense.id,
      employeeId,
      amount: expense.amount,
    });

    emitEvent("expense.created", {
      organization_id: request.organizationId,
      data: {
        expense_id:   expense.id,
        employee_id:  employeeId,
        amount:       expense.amount,
        description:  expense.description,
        submitted_at: expense.submitted_at,
      },
    });

    // feat-1: insert into pending_expenses snapshot (fire-and-forget)
    enqueueExpenseCreated({
      employeeId,
      organizationId: request.organizationId,
      expenseId: expense.id,
      amount: Number(expense.amount),
      submittedAt: expense.submitted_at,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      request.log.warn({ expenseId: expense.id, error: msg }, "feat-1: failed to enqueue EXPENSE_CREATED snapshot job (non-fatal)");
    });

    return expense;
  },

  /**
   * Retrieve a paginated list of the authenticated employee's own expenses.
   */
  async getMyExpenses(
    request: FastifyRequest,
    page: number,
    limit: number,
  ): Promise<{ data: EnrichedExpense[]; total: number }> {
    const employeeId = request.employeeId;
    if (!employeeId) return { data: [], total: 0 };

    return expensesRepository.findExpensesByUser(request, employeeId, page, limit);
  },

  /**
   * Retrieve a paginated list of all expenses in the organization.
   * Caller must hold ADMIN role — enforced at the route level.
   * Optionally scoped to a single employee for the admin expense detail panel.
   */
  async getOrgExpenses(
    request: FastifyRequest,
    page: number,
    limit: number,
    employeeId?: string,
    status?: string,
  ): Promise<{ data: EnrichedExpense[]; total: number }> {
    return expensesRepository.findExpensesByOrg(request, page, limit, employeeId, status);
  },

  /**
   * Update the status of an expense (APPROVED or REJECTED).
   * Only PENDING expenses may be actioned — guards against double-processing.
   * Caller must hold ADMIN role — enforced at the route level.
   */
  async updateExpenseStatus(
    request: FastifyRequest,
    expenseId: string,
    body: UpdateExpenseStatusBody,
  ): Promise<Expense> {
    // 1. Fetch the expense — orgTable() scopes the query to the request org at DB level.
    //    Defence-in-depth: also verify the returned row belongs to this org in case the
    //    repository is mocked or the row slips through a future refactor.
    const expense = await expensesRepository.findExpenseById(
      request,
      expenseId,
    );

    if (!expense) {
      throw new NotFoundError("Expense not found");
    }

    if (expense.organization_id !== request.organizationId) {
      throw new ForbiddenError("Access denied");
    }

    // 2. Only PENDING expenses may be transitioned.
    if (expense.status !== "PENDING") {
      throw new ExpenseAlreadyReviewed(expense.status);
    }

    // 3. Validate: rejection_comment is required when status is REJECTED.
    if (body.status === "REJECTED" && !body.rejection_comment) {
      throw new BadRequestError("rejection_comment is required when rejecting an expense");
    }

    // 4. Apply the new status, recording the reviewer identity.
    const updated = await expensesRepository.updateExpenseStatus(
      request,
      expenseId,
      body.status,
      request.user.sub,
      body.rejection_comment,
    );

    // 5. Structured log with event tag for observability.
    const event =
      body.status === "APPROVED" ? "expense_approved" : "expense_rejected";

    request.log.info(
      {
        event,
        expenseId: updated.id,
        employeeId: updated.employee_id,
        adminId: request.user.sub,
        organizationId: request.organizationId,
        amount: updated.amount,
        status: updated.status,
      },
      body.status === "APPROVED" ? "Expense approved" : "Expense rejected",
    );

    sseEventBus.emitOrgEvent(request.organizationId, "expense.status", {
      expenseId: updated.id,
      employeeId: updated.employee_id,
      status: updated.status,
    });

    if (body.status === "APPROVED") {
      emitEvent("expense.approved", {
        organization_id: request.organizationId,
        data: {
          expense_id:  updated.id,
          employee_id: updated.employee_id,
          amount:      updated.amount,
          description: updated.description,
          approved_by: request.user.sub,
          reviewed_at: updated.reviewed_at ?? new Date().toISOString(),
        },
      });
    } else if (body.status === "REJECTED") {
      // Phase 25: emit expense.rejected so webhook subscribers receive
      // rejection events on the same code path as approvals.
      emitEvent("expense.rejected", {
        organization_id: request.organizationId,
        data: {
          expense_id:        updated.id,
          employee_id:       updated.employee_id,
          amount:            updated.amount,
          description:       updated.description,
          rejected_by:       request.user.sub,
          reviewed_at:       updated.reviewed_at ?? new Date().toISOString(),
          rejection_comment: body.rejection_comment,
        },
      });
    }

    // feat-1: remove from pending_expenses snapshot; update metrics on approval (fire-and-forget)
    enqueueExpenseResolved({
      employeeId: updated.employee_id,
      organizationId: request.organizationId,
      expenseId: updated.id,
      amount: Number(updated.amount),
      resolution: body.status === "APPROVED" ? "EXPENSE_APPROVED" : "EXPENSE_REJECTED",
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      request.log.warn({ expenseId: updated.id, error: msg }, "feat-1: failed to enqueue EXPENSE_RESOLVED snapshot job (non-fatal)");
    });

    return updated;
  },

  /**
   * Generate a short-lived signed upload URL for a receipt file.
   *
   * The caller uploads the file directly to Supabase Storage — the API
   * never handles the file bytes, keeping it stateless and avoiding
   * memory pressure on the server.
   *
   * Storage path: receipts/{organization_id}/{employee_id}/{uuid}.{ext}
   * The org-prefix is enforced by the storage RLS INSERT policy so even if
   * a client crafts a different path the upload will be rejected.
   *
   * Returns:
   *  uploadUrl  — the signed PUT URL (valid for 5 minutes)
   *  receiptUrl — the permanent path the client should store in receipt_url
   *               after a successful upload
   */
  async generateReceiptUploadUrl(
    request: FastifyRequest,
    extension: string,
    mimeType?: string,
  ): Promise<{ uploadUrl: string; receiptUrl: string }> {
    requireEmployeeContext(request);
    const employeeId = request.employeeId!;

    const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "pdf"] as const;
    const ext = extension.toLowerCase().replace(/^\./, "");
    if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new BadRequestError(
        `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`,
      );
    }

    // If the caller declares a MIME type, validate it against the extension.
    // This prevents content-type spoofing before a signed URL is issued.
    // The storage bucket also enforces allowed_mime_types server-side, but
    // early rejection here gives the client a clearer error message.
    const EXTENSION_TO_MIME: Record<string, string> = {
      jpg:  "image/jpeg",
      jpeg: "image/jpeg",
      png:  "image/png",
      webp: "image/webp",
      pdf:  "application/pdf",
    };
    const ALLOWED_MIME_TYPES = Object.values(EXTENSION_TO_MIME);
    if (mimeType !== undefined) {
      if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        throw new BadRequestError(
          `Unsupported MIME type '${mimeType}'. Allowed: ${[...new Set(ALLOWED_MIME_TYPES)].join(", ")}`,
        );
      }
      const expectedMime = EXTENSION_TO_MIME[ext];
      if (mimeType !== expectedMime) {
        throw new BadRequestError(
          `MIME type '${mimeType}' does not match extension '${ext}' (expected '${expectedMime}')`,
        );
      }
    }

    const filename = `${randomUUID()}.${ext}`;
    const storagePath = `${request.organizationId}/${employeeId}/${filename}`;

    const { data, error } = await supabaseServiceClient.storage
      .from("receipts")
      .createSignedUploadUrl(storagePath, { upsert: false });

    if (error || !data) {
      request.log.error(
        { error, organizationId: request.organizationId, employeeId },
        "Failed to generate receipt upload URL",
      );
      throw new BadRequestError("Could not generate upload URL. Please try again.");
    }

    return {
      uploadUrl: data.signedUrl,
      receiptUrl: data.path,
    };
  },
};
