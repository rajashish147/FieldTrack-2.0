import type { FastifyLoggerOptions } from "fastify";
import type { PinoLoggerOptions } from "fastify/types/logger.js";
import { trace, context, isSpanContextValid } from "@opentelemetry/api";
import { createRequire } from "module";

type LoggerConfig = FastifyLoggerOptions & PinoLoggerOptions;
const require = createRequire(import.meta.url);

// Injects the active OpenTelemetry trace_id and span_id into every Pino log
// line. Grafana can then link logs ↔ traces using these fields:
//   Loki → Explore → "Derived fields" → trace_id → Tempo datasource
//
// Returns {} when no active span exists (e.g. background workers, startup),
// so there is zero overhead on untraced code paths.
function otelMixin(): Record<string, string | number> {
    const span = trace.getSpan(context.active());
    if (span === undefined) return {};

    const ctx = span.spanContext();
    if (!isSpanContextValid(ctx)) return {};

    return {
        trace_id: ctx.traceId,
        span_id: ctx.spanId,
        trace_flags: ctx.traceFlags,  // 1 = sampled, 0 = not sampled
    };
}

const developmentLogger: LoggerConfig = {
    level: "debug",
    mixin: otelMixin,
    transport: {
        target: "pino-pretty",
        options: {
            colorize: true,
            translateTime: "HH:MM:ss Z",
            ignore: "pid,hostname",
        },
    },
};

const productionLogger: LoggerConfig = {
    level: "info",
    mixin: otelMixin,
};

const structuredDebugLogger: LoggerConfig = {
    level: "debug",
    mixin: otelMixin,
};

function canUsePrettyTransport(): boolean {
    try {
        require.resolve("pino-pretty");
        return true;
    } catch {
        return false;
    }
}

/**
 * Returns the appropriate Pino logger configuration for the given app environment.
 *
 * Pass env.APP_ENV (not env.NODE_ENV) so logger verbosity is driven by the
 * same canonical environment token used everywhere else in the application.
 *
 * production → structured JSON (machine-readable, ingested by Loki)
 * everything else → pino-pretty with colours (human-readable in dev/staging/test)
 */
export function getLoggerConfig(appEnv: string): LoggerConfig {
    if (appEnv === "production") {
        return productionLogger;
    }

    // In minimal production-like containers (CI parity, distroless runtime),
    // devDependencies are omitted so pino-pretty is unavailable.
    // Fall back to structured JSON instead of crashing at startup.
    if (!canUsePrettyTransport()) {
        return structuredDebugLogger;
    }

    return developmentLogger;
}
