import { z } from "zod";

export const API_KEY_SCOPES = [
  "read:employees",
  "read:sessions",
  "write:expenses",
  "admin:all",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);

export const apiKeyPublicSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  scopes: z.array(apiKeyScopeSchema),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  active: z.boolean(),
  request_count: z.number(),
  error_count: z.number(),
  key_preview: z.string(),
});

export type ApiKeyPublic = z.infer<typeof apiKeyPublicSchema>;

export const apiKeyCreateBodySchema = z.object({
  name: z.string().min(3).max(64),
  scopes: z.array(apiKeyScopeSchema).min(1),
});

export type ApiKeyCreateBody = z.infer<typeof apiKeyCreateBodySchema>;

export const apiKeyUpdateBodySchema = z
  .object({
    name: z.string().min(3).max(64).optional(),
    scopes: z.array(apiKeyScopeSchema).min(1).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.scopes !== undefined || v.active !== undefined, {
    message: "At least one field must be provided",
  });

export type ApiKeyUpdateBody = z.infer<typeof apiKeyUpdateBodySchema>;

export interface ApiKeyCreateResult {
  key: string;
  record: ApiKeyPublic;
}

export interface ApiKeyAuthRecord {
  id: string;
  organization_id: string;
  key_hash: string;
  key_salt: string;
  scopes: ApiKeyScope[];
  active: boolean;
}
