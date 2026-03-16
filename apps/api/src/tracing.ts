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
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AlwaysOnSampler } from "@opentelemetry/sdk-trace-base";
import { env } from "./config/env.js";

const sdk = new NodeSDK({
    resource: resourceFromAttributes({
        // Use stable string literals to avoid breakage when
        // @opentelemetry/semantic-conventions renames constants.
        "service.name": "fieldtrack-backend",
        "service.version": "2.0",
        "deployment.environment": process.env["NODE_ENV"] ?? "development",
    }),

    // Export every trace. For a single-instance production app this is fine;
    // revisit with ParentBasedSampler + TraceIdRatioBasedSampler if ingestion
    // costs become a concern at higher traffic volumes.
    sampler: new AlwaysOnSampler(),

    traceExporter: new OTLPTraceExporter({
        // "tempo" resolves via Docker service name on fieldtrack_network
        url: `${env.TEMPO_ENDPOINT ?? "http://tempo:4318"}/v1/traces`,
    }),
    instrumentations: [
        getNodeAutoInstrumentations({
            // Disable noisy fs instrumentation; keep HTTP + Fastify auto-tracing
            "@opentelemetry/instrumentation-fs": { enabled: false },
            "@opentelemetry/instrumentation-http": { enabled: true },
            "@opentelemetry/instrumentation-fastify": { enabled: true },
            "@opentelemetry/instrumentation-dns": { enabled: true },
            "@opentelemetry/instrumentation-undici": { enabled: true },
            "@opentelemetry/instrumentation-ioredis": { enabled: true },
        }),
    ],
});

sdk.start();