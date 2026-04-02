/**
 * event-bus.ts — Centralized domain event bus for FieldTrack 2.0.
 *
 * Provides a type-safe, async-safe event emitter that decouples business
 * logic from downstream integrations (webhooks, audit logs, analytics).
 *
 * Phase 25 foundation: services emit events here; the webhook delivery
 * worker subscribes to this bus and fans out to registered endpoints.
 *
 * Design principles:
 *  - Every emitted event carries a UUID (id) so the delivery system can
 *    enforce at-most-once delivery via the webhook_deliveries unique
 *    constraint (event_id, webhook_id).
 *  - EVENT_SCHEMA_VERSION is the single place to bump when the envelope
 *    shape changes; listeners can gate on version for forward compatibility.
 *  - setImmediate defers listener execution so emission never adds latency
 *    to the calling request's response cycle.
 *  - Listener errors are caught and swallowed to guarantee service isolation.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

// ─── Module-level structured logger ──────────────────────────────────────────
//
// event-bus.ts operates at module scope — there is no Fastify app or request
// context available here.  Writing structured JSON to stderr mirrors the Pino
// format used everywhere else in the application and is consumed by Docker's
// log driver → Promtail → Loki exactly like any other log line.
//
// Filter in Loki:   {component="event-bus"} |= "event listener failed"
// Filter by event:  {component="event-bus"} | json | event="expense.approved"

function busLog(
  level: "error" | "warn",
  msg: string,
  fields: Record<string, unknown>,
): void {
  process.stderr.write(
    JSON.stringify({
      level,
      time:      Date.now(),
      component: "event-bus",
      msg,
      ...fields,
    }) + "\n",
  );
}

// ─── Schema Version ───────────────────────────────────────────────────────────

/**
 * Canonical envelope schema version.
 *
 * Increment this when the EventEnvelope shape itself changes in a
 * backward-incompatible way (field renames, type changes, removals).
 * Adding new optional fields does NOT require a bump.
 *
 * The delivery worker and webhook consumers gate on this value:
 *   if (envelope.version > MAX_SUPPORTED_VERSION) { /* skip or DLQ *\/ }
 */
export const EVENT_SCHEMA_VERSION = 1 as const;

// ─── Event Data Payloads ──────────────────────────────────────────────────────

/**
 * Strongly-typed map of event names → their `data` payloads.
 *
 * Rules for payload design:
 *  1. Include every field a webhook consumer would need without a DB round-trip.
 *  2. Use snake_case to match the database column convention.
 *  3. Mark fields optional only when they are genuinely nullable at the point
 *     of emission (e.g. rejection_comment is optional for non-reject paths).
 *
 * When adding a new event:
 *  a. Add the type entry here.
 *  b. Call emitEvent() from the relevant service.
 *  c. Update the webhooks.events documentation with the new event name.
 */
export type EventDataMap = {
  // ── Attendance ─────────────────────────────────────────────────────────────

  /**
   * Fired immediately after a new attendance session is created (check-in).
   *
   * Contains: who checked in, which session, and when — sufficient for a
   * webhook consumer to display a "John just checked in" notification
   * without querying the API.
   */
  "employee.checked_in": {
    employee_id: string;
    session_id: string;
    /** ISO timestamp of check-in — copied from attendance_sessions.checkin_at */
    checkin_at: string;
  };

  /**
   * Fired immediately after an attendance session is closed (check-out).
   *
   * Contains: who checked out, which session, and both timestamps.
   * total_distance_km is intentionally omitted here — it is not yet computed
   * at checkout time (the distance worker runs asynchronously). Consumers
   * that need distance should poll GET /attendance/:id or subscribe to a
   * future "session.distance_computed" event.
   */
  "employee.checked_out": {
    employee_id: string;
    session_id: string;
    /** ISO timestamp of check-in — preserved for session duration calculation */
    checkin_at: string;
    /** ISO timestamp of check-out — copied from attendance_sessions.checkout_at */
    checkout_at: string;
  };

  // ── Expenses ───────────────────────────────────────────────────────────────

  /**
   * Fired when an employee submits a new expense.
   *
   * Includes description and submitted_at so consumers can render a
   * meaningful notification ("Alice submitted a £45.00 expense: Team lunch")
   * without fetching the expense record.
   */
  "expense.created": {
    expense_id: string;
    employee_id: string;
    amount: number;
    /** Short description provided by the employee */
    description: string;
    /** ISO timestamp — copied from expenses.submitted_at */
    submitted_at: string;
  };

  /**
   * Fired when an admin approves a PENDING expense.
   *
   * Includes reviewer identity and timestamp for audit trail completeness.
   */
  "expense.approved": {
    expense_id: string;
    employee_id: string;
    amount: number;
    description: string;
    approved_by: string;
    /** ISO timestamp — copied from expenses.reviewed_at (non-null after review) */
    reviewed_at: string;
  };

  /**
   * Fired when an admin rejects a PENDING expense.
   *
   * rejection_comment is included when provided; webhook consumers should
   * treat it as optional to stay forward-compatible with any future flows
   * where a comment is not required.
   */
  "expense.rejected": {
    expense_id: string;
    employee_id: string;
    amount: number;
    description: string;
    rejected_by: string;
    /** ISO timestamp — copied from expenses.reviewed_at */
    reviewed_at: string;
    /** Admin-supplied rejection reason; undefined if not provided */
    rejection_comment: string | undefined;
  };

  // ── Employees ──────────────────────────────────────────────────────────────

  /**
   * Fired when an admin creates a new employee record.
   *
   * Contains: the new employee's id, code, and name so subscribers can
   * react to org roster changes without an additional API call.
   */
  "employee.created": {
    employee_id: string;
    employee_code: string;
    name: string;
    /** ISO timestamp — copied from employees.created_at */
    created_at: string;
  };
};

export type EventName = keyof EventDataMap;

// ─── Canonical Event Envelope ─────────────────────────────────────────────────

/**
 * The canonical event envelope emitted by every domain event.
 *
 * Field contract:
 *
 *   id            — UUID v4 generated at emission time.
 *                   Used as the idempotency key in webhook_deliveries:
 *                     UNIQUE (event_id, webhook_id)
 *                   The delivery worker can INSERT ... ON CONFLICT DO NOTHING
 *                   to safely re-attempt fanout without duplicate rows.
 *
 *   type          — Event name (e.g. "expense.created").
 *                   Matches the EventDataMap key used for bus routing.
 *
 *   version       — Envelope schema version (currently EVENT_SCHEMA_VERSION = 1).
 *                   Consumers should reject envelopes whose version exceeds
 *                   the highest version they support.
 *
 *   occurred_at   — ISO-8601 timestamp of when emitEvent() was called.
 *                   This is the application-layer event time, not the DB write
 *                   time (which may differ slightly due to async execution).
 *
 *   organization_id — Tenant identifier. Matches the organization_id on all
 *                   related DB rows. The delivery worker uses this to look up
 *                   registered webhooks without an additional join.
 *
 *   data          — Strongly-typed event-specific payload (see EventDataMap).
 *                   Self-contained: webhook consumers should not need to make
 *                   additional API calls to render a useful notification.
 */
export interface EventEnvelope<T extends EventName> {
  /** UUID v4 — unique per emission, used for at-most-once delivery */
  id: string;
  /** Event name — matches the EventDataMap key */
  type: T;
  /** Envelope schema version — gate on this for forward compatibility */
  version: typeof EVENT_SCHEMA_VERSION;
  /** ISO-8601 timestamp of emission */
  occurred_at: string;
  /** Tenant identifier */
  organization_id: string;
  /** Event-specific payload — self-contained, no further DB lookups needed */
  data: EventDataMap[T];
}

// ─── Typed Event Bus ──────────────────────────────────────────────────────────

/**
 * Fully typed wrapper around Node.js EventEmitter.
 *
 * Composition is used instead of inheritance to keep the public surface
 * area minimal and to avoid TypeScript overload compatibility issues that
 * arise when narrowing `(...args: any[])` listener signatures into typed
 * generics on a class that `extends EventEmitter`.
 *
 * The internal `_emitter` holds the raw Node EventEmitter; all public
 * methods cast listener types at the boundary — safe because we only ever
 * emit EventEnvelope<T> for event T, so listeners always receive the
 * correct type at runtime.
 */
class FieldTrackEventBus {
  private readonly _emitter: EventEmitter;

  constructor() {
    this._emitter = new EventEmitter();
    // Raised to 50 so the webhook worker, audit logger, SSE bridge, and test
    // subscribers can all attach without MaxListenersExceededWarning.
    this._emitter.setMaxListeners(50);
  }

  emit<T extends EventName>(event: T, envelope: EventEnvelope<T>): boolean {
    return this._emitter.emit(event, envelope);
  }

  on<T extends EventName>(
    event: T,
    listener: (envelope: EventEnvelope<T>) => void,
  ): this {
    this._emitter.on(event, listener as unknown as (...a: unknown[]) => void);
    return this;
  }

  off<T extends EventName>(
    event: T,
    listener: (envelope: EventEnvelope<T>) => void,
  ): this {
    this._emitter.off(event, listener as unknown as (...a: unknown[]) => void);
    return this;
  }

  once<T extends EventName>(
    event: T,
    listener: (envelope: EventEnvelope<T>) => void,
  ): this {
    this._emitter.once(event, listener as unknown as (...a: unknown[]) => void);
    return this;
  }
}

/**
 * Process-level singleton event bus.
 *
 * Services call emitEvent() to publish; workers and integration layers
 * subscribe via eventBus.on() / eventBus.once().
 *
 * @example — Publishing (service layer)
 *   emitEvent("employee.checked_in", {
 *     organization_id: request.organizationId,
 *     data: { employee_id: employeeId, session_id: session.id, checkin_at: session.checkin_at },
 *   });
 *
 * @example — Subscribing (webhook delivery worker)
 *   eventBus.on("expense.created", async (envelope) => {
 *     // envelope.id     — idempotency key for webhook_deliveries
 *     // envelope.type   — "expense.created"
 *     // envelope.version — 1
 *     await fanOutToWebhooks(envelope);
 *   });
 */
export const eventBus = new FieldTrackEventBus();

// ─── Public Emit API ──────────────────────────────────────────────────────────

/**
 * Emit a typed domain event in a non-blocking, idempotency-safe manner.
 *
 * The caller supplies `organization_id` and the event-specific `data`.
 * The envelope fields `id`, `type`, `version`, and `occurred_at` are
 * generated automatically:
 *
 *   id          — crypto.randomUUID() — unique per call, used as the
 *                 idempotency key in webhook_deliveries (event_id column).
 *   type        — the eventName argument
 *   version     — EVENT_SCHEMA_VERSION (currently 1)
 *   occurred_at — new Date().toISOString()
 *
 * Execution is deferred via setImmediate so that slow or throwing listeners
 * never affect the latency or reliability of the calling HTTP handler.
 *
 * Listener errors are silently swallowed at this layer — each listener is
 * responsible for its own error handling and retry logic.  This is intentional:
 * a misbehaving webhook subscriber must never crash the request lifecycle.
 *
 * @param eventName  — key of EventDataMap
 * @param payload    — { organization_id, data } matching EventDataMap[eventName]
 *
 * @example
 *   emitEvent("expense.approved", {
 *     organization_id: request.organizationId,
 *     data: {
 *       expense_id:  updated.id,
 *       employee_id: updated.employee_id,
 *       amount:      updated.amount,
 *       description: updated.description,
 *       approved_by: request.user.sub,
 *       reviewed_at: updated.reviewed_at ?? new Date().toISOString(),
 *     },
 *   });
 */
export function emitEvent<T extends EventName>(
  eventName: T,
  payload: { organization_id: string; data: EventDataMap[T] },
): void {
  const envelope: EventEnvelope<T> = {
    id:              randomUUID(),
    type:            eventName,
    version:         EVENT_SCHEMA_VERSION,
    occurred_at:     new Date().toISOString(),
    organization_id: payload.organization_id,
    data:            payload.data,
  };

  setImmediate(() => {
    try {
      eventBus.emit(eventName, envelope);
    } catch (err) {
      // A listener threw synchronously — log it but do NOT rethrow.
      //
      // Node's EventEmitter calls listeners sequentially; if one throws,
      // subsequent listeners for the same event are skipped.  The webhook
      // delivery worker is expected to wrap its own listener in try/catch so
      // this catch should rarely fire in production.  When it does, the
      // structured log below makes the failure visible in Loki without any
      // impact on request latency or reliability.
      const error = err instanceof Error ? err : new Error(String(err));
      busLog("error", "event listener failed", {
        event:           envelope.type,
        event_id:        envelope.id,
        organization_id: envelope.organization_id,
        err: {
          message: error.message,
          name:    error.name,
          stack:   error.stack,
        },
      });
    }
  });
}
