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
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";

const sdk = new NodeSDK({
    resource: new Resource({
        [SEMRESATTRS_SERVICE_NAME]: "fieldtrack-backend",
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
        }),
    ],
});

sdk.start();
