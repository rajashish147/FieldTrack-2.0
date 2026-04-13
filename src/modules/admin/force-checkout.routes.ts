import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { ok, handleError } from "../../utils/response.js";
import { attendanceRepository } from "../attendance/attendance.repository.js";
import { enqueueDistanceJob } from "../../workers/distance.queue.js";
import { enqueueAnalyticsJob } from "../../workers/analytics.queue.js";
import { enqueueCheckOut } from "../../workers/snapshot.queue.js";
import { sseEventBus } from "../../utils/sse-emitter.js";
import { NotFoundError, BadRequestError } from "../../utils/errors.js";

const bodySchema = z.object({
  employee_id: z.string().uuid(),
});

/**
 * POST /admin/force-checkout
 *
 * Forcibly closes the active session for a given employee.
 * Mirrors the logic executed by attendanceService.checkOut but called by an ADMIN,
 * so the ADMIN-forbidden guard is bypassed and the target employee_id comes from the body.
 *
 * Auth: ADMIN only.
 */
export async function adminForceCheckoutRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/admin/force-checkout",
    {
      schema: {
        tags: ["admin"],
        summary: "Force-close the active session for an employee",
        description: "Forcibly closes the active session for a given employee. Mirrors check-out logic but called by ADMIN. Fires distance + analytics jobs and emits SSE event.",
        body: z.object({
          employee_id: z.string().uuid().describe("UUID of the employee whose active session to close"),
        }),
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.object({
              id: z.string().uuid(),
              employee_id: z.string().uuid(),
              organization_id: z.string().uuid(),
              checkin_at: z.string(),
              checkout_at: z.string().nullable(),
              total_distance_km: z.number().nullable(),
              duration_seconds: z.number().nullable(),
            }).describe("The closed session record"),
          }),
        },
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request, reply) => {
      try {
        const { employee_id: employeeId } = bodySchema.parse(request.body);

        const openSession = await attendanceRepository.findOpenSession(request, employeeId);
        if (!openSession) {
          throw new NotFoundError(`No active session found for employee ${employeeId}`);
        }

        if (openSession.organization_id !== request.organizationId) {
          throw new BadRequestError("Employee does not belong to this organisation");
        }

        const closedSession = await attendanceRepository.closeSession(request, openSession.id);

        // Keep snapshot table in sync — fire-and-forget
        attendanceRepository
          .upsertLatestSession(request.organizationId, employeeId, closedSession)
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            request.log.warn(
              { sessionId: closedSession.id, error: msg },
              "admin-force-checkout: failed to upsert latest session snapshot (non-fatal)",
            );
          });

        // Enqueue snapshot update
        enqueueCheckOut({
          employeeId,
          organizationId: request.organizationId,
          sessionId: closedSession.id,
          checkoutAt: closedSession.checkout_at ?? new Date().toISOString(),
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          request.log.warn(
            { sessionId: closedSession.id, error: msg },
            "admin-force-checkout: failed to enqueue CHECK_OUT snapshot job (non-fatal)",
          );
        });

        // Emit SSE so the admin dashboard map updates in real time
        sseEventBus.emitOrgEvent(request.organizationId, "session.checkout", {
          sessionId: closedSession.id,
          employeeId,
          session: closedSession,
        });

        // Enqueue distance computation for the closed session
        try {
          await enqueueDistanceJob(closedSession.id);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          request.log.warn(
            { sessionId: closedSession.id, error: msg },
            "admin-force-checkout: failed to enqueue distance job (non-fatal)",
          );
        }

        // Enqueue analytics snapshot refresh
        try {
          await enqueueAnalyticsJob(closedSession.id, request.organizationId, employeeId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          request.log.warn(
            { sessionId: closedSession.id, error: msg },
            "admin-force-checkout: failed to enqueue analytics job (non-fatal)",
          );
        }

        request.log.info(
          {
            adminUserId: request.user.sub,
            employeeId,
            sessionId: closedSession.id,
            organizationId: request.organizationId,
          },
          "Admin force-checkout: session closed",
        );

        reply.status(200).send(ok(closedSession));
      } catch (error) {
        handleError(error, request, reply, "Unexpected error during force checkout");
      }
    },
  );
}
