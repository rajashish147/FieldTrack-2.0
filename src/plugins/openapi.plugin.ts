import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "../config/env.js";

/**
 * OpenAPI plugin for FieldTrack API.
 *
 * This plugin:
 * - Registers @fastify/swagger to generate OpenAPI 3.0 specifications
 * - Registers @fastify/swagger-ui to expose interactive documentation
 * - Integrates with existing Zod schemas via fastify-type-provider-zod
 * - Documents authentication, pagination, and standard response envelopes
 *
 * Endpoints exposed:
 * - /docs → Swagger UI
 * - /openapi.json → Raw OpenAPI specification
 *
 * Phase 19: API Contract & Documentation Layer
 */

// ─── Standard Response Schemas ────────────────────────────────────────────────

/**
 * Global success response envelope schema.
 * All successful API responses follow this pattern.
 */
export const successResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
  });

/**
 * Global error response envelope schema.
 * All error responses follow this pattern.
 */
export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string().describe("Human-readable error message"),
  requestId: z.string().uuid().describe("Unique request identifier for tracing"),
});

/**
 * Standard pagination query parameters.
 * Used by all list endpoints.
 */
export const paginationQuerySchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("Page number (1-indexed)"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Items per page (max 100)"),
});

// ─── OpenAPI Plugin ───────────────────────────────────────────────────────────

async function openApiPlugin(app: FastifyInstance): Promise<void> {
  // Register Swagger with OpenAPI 3.0 specification
  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "FieldTrack API",
        description:
          "Production backend for employee tracking and analytics. " +
          "This API provides endpoints for attendance tracking, location management, " +
          "expense reporting, and analytics.",
        version: "1.0.0",
        contact: {
          name: "FieldTrack Support",
        },
        license: {
          name: "MIT",
          url: "https://github.com/fieldtrack-tech/fieldtrack-2.0/blob/master/LICENSE",
        },
      },
      servers: [
        // Remote server — only included when API_BASE_URL is configured.
        // Changing the deployment domain requires only updating API_BASE_URL in .env.
        // No domain is ever hardcoded here.
        ...(env.API_BASE_URL
          ? [
              {
                url: env.API_BASE_URL,
                description:
                  env.APP_ENV === "production" ? "Production" : "Remote",
              },
            ]
          : []),
        // Local development server — always included so Swagger UI works
        // out of the box without any env configuration.
        {
          url: `http://localhost:${env.PORT}`,
          description: "Local development",
        },
      ],
      tags: [
        { name: "health", description: "Health check and system status endpoints" },
        { name: "auth", description: "Authentication and identity resolution" },
        { name: "attendance", description: "Attendance tracking and session management" },
        { name: "locations", description: "Location tracking and route calculation" },
        { name: "expenses", description: "Expense reporting and management" },
        { name: "analytics", description: "Business analytics and reporting" },
        { name: "admin", description: "Administrative operations (ADMIN role required)" },
        { name: "webhooks", description: "Webhook endpoint management and delivery logs" },
        { name: "api-keys", description: "API key management and scoped external access" },
        { name: "dashboard", description: "Employee dashboard and personal statistics" },
        { name: "profile", description: "Employee profile and activity status" },
        { name: "deprecated", description: "Deprecated endpoints — use documented alternatives" },
      ],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description:
              "JWT token obtained from authentication service. " +
              "Include in Authorization header: `Bearer <token>`",
          },
          ApiKeyAuth: {
            type: "apiKey",
            in: "header",
            name: "X-API-Key",
            description: "Scoped API key for external integrations",
          },
        },
        schemas: {
          SuccessResponse: {
            type: "object",
            required: ["success", "data"],
            properties: {
              success: { type: "boolean", enum: [true] },
              data: { type: "object", description: "Response payload" },
            },
          },
          ErrorResponse: {
            type: "object",
            required: ["success", "error", "requestId"],
            properties: {
              success: { type: "boolean", enum: [false] },
              error: {
                type: "string",
                description: "Human-readable error message",
                example: "Invalid authentication token",
              },
              requestId: {
                type: "string",
                format: "uuid",
                description: "Unique request identifier for tracing",
                example: "123e4567-e89b-12d3-a456-426614174000",
              },
            },
          },
          PaginationQuery: {
            type: "object",
            properties: {
              page: {
                type: "integer",
                minimum: 1,
                default: 1,
                description: "Page number (1-indexed)",
                example: 1,
              },
              limit: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 20,
                description: "Items per page (max 100)",
                example: 20,
              },
            },
          },
        },
        responses: {
          UnauthorizedError: {
            description: "Authentication token is missing or invalid",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
                example: {
                  success: false,
                  error: "Invalid authentication token",
                  requestId: "123e4567-e89b-12d3-a456-426614174000",
                },
              },
            },
          },
          ForbiddenError: {
            description: "Insufficient permissions for this operation",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
                example: {
                  success: false,
                  error: "Insufficient permissions",
                  requestId: "123e4567-e89b-12d3-a456-426614174000",
                },
              },
            },
          },
          NotFoundError: {
            description: "Resource not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
                example: {
                  success: false,
                  error: "Resource not found",
                  requestId: "123e4567-e89b-12d3-a456-426614174000",
                },
              },
            },
          },
          ValidationError: {
            description: "Request validation failed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
                example: {
                  success: false,
                  error: "Validation error: Invalid format for field 'latitude'",
                  requestId: "123e4567-e89b-12d3-a456-426614174000",
                },
              },
            },
          },
          InternalError: {
            description: "Internal server error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
                example: {
                  success: false,
                  error: "Internal server error",
                  requestId: "123e4567-e89b-12d3-a456-426614174000",
                },
              },
            },
          },
        },
      },
      security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
      externalDocs: {
        url: "https://github.com/fieldtrack-tech/fieldtrack-2.0",
        description: "Find more info here",
      },
    },
    // Transform Zod schemas to JSON Schema for OpenAPI
    transform: jsonSchemaTransform,
  });

  // Register Swagger UI
  await app.register(fastifySwaggerUI, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      displayRequestDuration: true,
      filter: true,
      tryItOutEnabled: true,
    },
    uiHooks: {
      onRequest: (_request, _reply, next) => {
        next();
      },
      preHandler: (_request, _reply, next) => {
        next();
      },
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
    transformSpecification: (swaggerObject) => {
      return swaggerObject;
    },
    transformSpecificationClone: true,
  });

  // Expose raw OpenAPI specification at /openapi.json
  app.get("/openapi.json", async () => {
    return app.swagger();
  });

  app.log.info("OpenAPI documentation enabled at /docs and /openapi.json");
}

/**
 * Export as Fastify plugin with proper encapsulation.
 */
export default fastifyPlugin(openApiPlugin, {
  name: "openapi-plugin",
  fastify: "5.x",
});
