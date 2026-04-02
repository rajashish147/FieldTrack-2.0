/**
 * metrics.ts — In-memory metrics registry for FieldTrack 2.0.
 *
 * Tracks key operational counters and gauges for the single-instance deployment.
 * No external dependencies. Thread-safe within Node.js single-threaded model.
 *
 * Exposed via GET /internal/metrics as structured JSON.
 */

// ─── Public Snapshot Shape ────────────────────────────────────────────────────

export interface MetricsSnapshot {
  uptimeSeconds: number;
  queueDepth: number;
  totalRecalculations: number;
  totalLocationsInserted: number;
  avgRecalculationMs: number;
}

// ─── Registry Implementation ──────────────────────────────────────────────────

/**
 * Rolling window size for average recalculation time.
 * Keeps memory bounded — oldest sample is evicted when window is full.
 */
const ROLLING_WINDOW_SIZE = 100;

class MetricsRegistry {
  private readonly startedAt: number = Date.now();

  // Counters — monotonically increasing
  private _totalLocationsInserted: number = 0;
  private _totalRecalculations: number = 0;

  // Rolling window for average recalculation latency
  private readonly _recalcTimeSamples: number[] = [];

  // ─── Mutation API ───────────────────────────────────────────────────────────

  /**
   * Increment the total locations inserted counter.
   * Pass the actual inserted count (not payload size) to exclude suppressed duplicates.
   */
  incrementLocationsInserted(count: number): void {
    this._totalLocationsInserted += count;
  }

  /**
   * Increment the total distance recalculations counter.
   * Call once per successfully completed recalculation job.
   */
  incrementRecalculations(): void {
    this._totalRecalculations++;
  }

  /**
   * Record a single recalculation duration sample (milliseconds).
   * Evicts the oldest sample once the rolling window is full.
   */
  recordRecalculationTime(ms: number): void {
    this._recalcTimeSamples.push(ms);
    if (this._recalcTimeSamples.length > ROLLING_WINDOW_SIZE) {
      this._recalcTimeSamples.shift();
    }
  }

  // ─── Read API ───────────────────────────────────────────────────────────────

  /**
   * Produce a point-in-time snapshot of all metrics.
   *
   * @param queueDepth  Current worker queue depth — injected by caller so
   *                    the registry stays decoupled from the queue module.
   */
  snapshot(queueDepth: number): MetricsSnapshot {
    const avg =
      this._recalcTimeSamples.length === 0
        ? 0
        : Math.round(
            this._recalcTimeSamples.reduce((sum, t) => sum + t, 0) /
              this._recalcTimeSamples.length,
          );

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      queueDepth,
      totalRecalculations: this._totalRecalculations,
      totalLocationsInserted: this._totalLocationsInserted,
      avgRecalculationMs: avg,
    };
  }
}

// ─── Singleton Export ─────────────────────────────────────────────────────────

/**
 * Process-level singleton.
 * Import this directly wherever counters need to be incremented or read.
 */
export const metrics = new MetricsRegistry();
