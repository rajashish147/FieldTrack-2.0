import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authenticate } from "../middleware/auth.js";
import { requireRole } from "../middleware/role-guard.js";
import { sseEventBus } from "../utils/sse-emitter.js";

/**
 * Per-org SSE connection counter.
 * Prevents file-descriptor exhaustion when a client opens many connections.
 * Keyed by orgId; decremented on disconnect.
 */
const orgConnectionCount = new Map<string, number>();
const MAX_SSE_CONNECTIONS_PER_ORG = 20;

/**
 * GET /admin/events
 *
 * Server-Sent Events stream scoped to the authenticated admin's organization.
 *
 * Pushed event types:
 *   session.checkin  — a new attendance session opened
 *   session.checkout — an attendance session closed
 *   expense.created  — a new expense submitted
 *   expense.status   — an expense approved or rejected
 *
 * The endpoint sends a heartbeat comment (``: ping`) every 30 s to
 * keep the connection alive through proxies and load balancers.
 *
 * Auth: ADMIN only.
 * Nginx: requires `proxy_buffering off` — already configured in fieldtrack.conf.
 * Limit: max 20 concurrent connections per org (M4 — FD exhaustion protection).
 */
export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/admin/events",
    {
      schema: {
        tags: ["admin"],
        description: "Server-Sent Events stream for real-time org activity (ADMIN only).",
        // No response schema — SSE uses raw `text/event-stream`, not JSON.
      },
      preValidation: [authenticate, requireRole("ADMIN")],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const orgId = request.organizationId;

      // M4: enforce per-org connection limit to prevent FD exhaustion.
      const currentCount = orgConnectionCount.get(orgId) ?? 0;
      if (currentCount >= MAX_SSE_CONNECTIONS_PER_ORG) {
        request.log.warn(
          { orgId, currentCount, limit: MAX_SSE_CONNECTIONS_PER_ORG },
          "SSE connection limit reached for org — rejecting new connection",
        );
        reply.status(429).send({
          success: false,
          error: `SSE connection limit reached (max ${MAX_SSE_CONNECTIONS_PER_ORG} per organization).`,
        });
        return;
      }
      orgConnectionCount.set(orgId, currentCount + 1);

      // SSE headers
      void reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Helper — write a formatted SSE message to the raw socket
      function sendEvent(type: string, data: unknown): void {
        void reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }

      function sendComment(text: string): void {
        void reply.raw.write(`: ${text}\n\n`);
      }

      // Send initial connection confirmation
      sendEvent("connected", { orgId });

      // Heartbeat — keeps the connection alive through proxies
      const heartbeat = setInterval(() => {
        if (!reply.raw.writableEnded) {
          sendComment("ping");
        }
      }, 30_000);

      // Org-scoped event handler
      function onOrgEvent(event: { type: string; payload: Record<string, unknown>; ts: string }) {
        if (!reply.raw.writableEnded) {
          sendEvent(event.type, event);
        }
      }

      const channelKey = `org:${orgId}`;
      sseEventBus.on(channelKey, onOrgEvent);

      // Cleanup when client disconnects
      request.raw.on("close", () => {
        clearInterval(heartbeat);
        sseEventBus.off(channelKey, onOrgEvent);
        // M4: decrement the per-org connection counter.
        const count = orgConnectionCount.get(orgId) ?? 1;
        if (count <= 1) {
          orgConnectionCount.delete(orgId);
        } else {
          orgConnectionCount.set(orgId, count - 1);
        }
      });

      // Keep the Fastify handler alive — SSE is a long-lived connection
      await new Promise<void>((resolve) => {
        request.raw.on("close", resolve);
      });
    },
  );
}
