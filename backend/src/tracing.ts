// FieldTrack 2.0 — OpenTelemetry tracing bootstrap
//
// This file MUST be imported as the very first import in server.ts so that
// the SDK can wrap all subsequently-loaded modules (Fastify, HTTP, BullMQ).
//
// Traces are shipped via OTLP HTTP to Grafana Tempo on the shared Docker
// network. View them in: Grafana → Explore → Tempo → Search traces
// Filter by service.name = "fieldtrack-backend"

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { Resource } from "@opentelemetry/resources";
import {
    SEMRESATTRS_SERVICE_NAME,
    SEMRESATTRS_SERVICE_VERSION,
    SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from "@opentelemetry/semantic-conventions";
import {
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";

const sdk = new NodeSDK({
    resource: new Resource({
        [SEMRESATTRS_SERVICE_NAME]: "fieldtrack-backend",
        // SERVICE_VERSION surfaces in the Grafana service graph and trace detail
        // panel, making it easy to correlate incidents to specific deployments.
        [SEMRESATTRS_SERVICE_VERSION]: "2.0",
        // DEPLOYMENT_ENVIRONMENT lets you filter traces by environment in Grafana
        // (e.g. deployment.environment = production vs staging) — essential once
        // both environments share the same Tempo instance.
        [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: process.env["NODE_ENV"] ?? "development",
    }),

    // Sample 20% of root traces. ParentBasedSampler ensures that if a parent
    // span was already sampled (e.g. by an upstream gateway), this service
    // respects that decision rather than re-rolling the dice.
    sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(0.2),
    }),

    traceExporter: new OTLPTraceExporter({
        // "tempo" resolves via Docker service name on fieldtrack_network
        url: "http://tempo:4318/v1/traces",
    }),
    instrumentations: [
        getNodeAutoInstrumentations({
            // Disable noisy fs instrumentation; keep HTTP + Fastify auto-tracing
            "@opentelemetry/instrumentation-fs": { enabled: false },

            // HTTP instrumentation creates the root server span for every
            // inbound request and client span for every outbound fetch.
            // Automatically sets http.method, http.url, http.status_code,
            // net.peer.ip, and propagates W3C traceparent headers upstream.
            "@opentelemetry/instrumentation-http": { enabled: true },

            // Fastify instrumentation wraps each route handler in a child span
            // named after the matched route pattern (e.g. GET /users/:id).
            // This is what makes the Grafana service graph route-aware.
            "@opentelemetry/instrumentation-fastify": { enabled: true },

            // DNS instrumentation adds spans for DNS lookups, useful for
            // diagnosing slow cold-start database or Redis connections.
            "@opentelemetry/instrumentation-dns": { enabled: true },

            // Undici/fetch instrumentation traces all outbound HTTP calls
            // (Supabase REST, webhooks) as child spans with full URL context.
            "@opentelemetry/instrumentation-undici": { enabled: true },

            // BullMQ bundles ioredis internally. Enabling this produces spans
            // for every Redis command so the Grafana service graph shows the
            // fieldtrack-backend → redis dependency edge.
            "@opentelemetry/instrumentation-ioredis": { enabled: true },
        }),
    ],
});

sdk.start();
