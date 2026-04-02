import { EventEmitter } from "node:events";

/**
 * Singleton in-memory event bus for Server-Sent Events.
 *
 * Other modules emit events here; the SSE route handler listens and
 * forwards them to connected clients.
 *
 * Events are scoped by organization_id so each client only receives
 * events for its own org.
 *
 * Supported event types:
 *   "session.checkin"   — a new attendance session opened
 *   "session.checkout"  — an attendance session closed
 *   "expense.created"   — a new expense submitted
 *   "expense.status"    — an expense status changed (approved/rejected)
 */
class SseEventBus extends EventEmitter {
  constructor() {
    super();
    // Allow many concurrent SSE clients per org without triggering the
    // default Node.js MaxListenersExceededWarning.
    this.setMaxListeners(500);
  }

  /** Emit an event scoped to a specific organization. */
  emitOrgEvent(
    orgId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.emit(`org:${orgId}`, { type, payload, ts: new Date().toISOString() });
  }
}

export const sseEventBus = new SseEventBus();
