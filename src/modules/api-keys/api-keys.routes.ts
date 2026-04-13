import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireJwtAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/role-guard.js";
import { apiKeysController } from "./api-keys.controller.js";
import { apiKeyCreateBodySchema, apiKeyPublicSchema, apiKeyUpdateBodySchema } from "./api-keys.schema.js";

const apiKeyCreateResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    key: z.string(),
    record: apiKeyPublicSchema,
  }),
});

const apiKeyListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(apiKeyPublicSchema),
});

const apiKeySingleResponseSchema = z.object({
  success: z.literal(true),
  data: apiKeyPublicSchema,
});

export async function apiKeysRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/admin/api-keys",
    {
      schema: {
        tags: ["admin", "api-keys"],
        summary: "Create API key (raw key returned only once)",
        description: "Creates a new scoped API key for this organization. The raw key is returned only once and cannot be retrieved again. JWT authentication required — API keys cannot create other API keys.",
        body: apiKeyCreateBodySchema,
        response: { 201: apiKeyCreateResponseSchema },
        security: [{ BearerAuth: [] }],
      },
      preValidation: [authenticate, requireJwtAuth, requireRole("ADMIN")],
    },
    apiKeysController.create,
  );

  app.get(
    "/admin/api-keys",
    {
      schema: {
        tags: ["admin", "api-keys"],
        summary: "List API keys for organization",
        description: "Returns all API keys for this organization (secrets never included). JWT authentication required.",
        response: { 200: apiKeyListResponseSchema },
        security: [{ BearerAuth: [] }],
      },
      preValidation: [authenticate, requireJwtAuth, requireRole("ADMIN")],
    },
    apiKeysController.list,
  );

  app.patch<{ Params: { id: string } }>(
    "/admin/api-keys/:id",
    {
      schema: {
        tags: ["admin", "api-keys"],
        summary: "Update API key metadata, scopes or active state",
        description: "Updates an existing API key's name, scopes, or active status. JWT authentication required.",
        params: z.object({ id: z.string().uuid() }),
        body: apiKeyUpdateBodySchema,
        response: { 200: apiKeySingleResponseSchema },
        security: [{ BearerAuth: [] }],
      },
      preValidation: [authenticate, requireJwtAuth, requireRole("ADMIN")],
    },
    apiKeysController.update,
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/api-keys/:id",
    {
      schema: {
        tags: ["admin", "api-keys"],
        summary: "Delete API key",
        description: "Permanently deletes an API key. JWT authentication required.",
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null().describe("No content") },
        security: [{ BearerAuth: [] }],
      },
      preValidation: [authenticate, requireJwtAuth, requireRole("ADMIN")],
    },
    apiKeysController.remove,
  );
}
