import type { FastifyRequest } from "fastify";
import { supabaseServiceClient as supabase } from "../../config/supabase.js";
import type {
  ApiKeyAuthRecord,
  ApiKeyCreateBody,
  ApiKeyPublic,
  ApiKeyScope,
  ApiKeyUpdateBody,
} from "./api-keys.schema.js";

interface ApiKeyRow {
  id: string;
  organization_id: string;
  name: string;
  key_hash: string;
  key_salt: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  active: boolean;
  request_count: number;
  error_count: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

function toPublic(row: ApiKeyRow): ApiKeyPublic {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    active: row.active,
    request_count: row.request_count,
    error_count: row.error_count,
    key_preview: `${row.key_prefix}...`,
  };
}

export const apiKeysRepository = {
  async create(
    request: FastifyRequest,
    body: ApiKeyCreateBody,
    keyHash: string,
    keySalt: string,
    keyPrefix: string,
  ): Promise<ApiKeyPublic> {
    const { data, error } = await supabase
      .from("api_keys")
      .insert({
        organization_id: request.organizationId,
        name: body.name,
        key_hash: keyHash,
        key_salt: keySalt,
        key_prefix: keyPrefix,
        scopes: body.scopes,
        active: true,
        created_by: request.user.sub,
      })
      .select("id, organization_id, name, key_hash, key_salt, key_prefix, scopes, active, request_count, error_count, created_at, updated_at, last_used_at")
      .single();

    if (error) throw new Error(`Failed to create API key: ${error.message}`);
    return toPublic(data as ApiKeyRow);
  },

  async list(request: FastifyRequest): Promise<ApiKeyPublic[]> {
    const { data, error } = await supabase
      .from("api_keys")
      .select("id, organization_id, name, key_hash, key_salt, key_prefix, scopes, active, request_count, error_count, created_at, updated_at, last_used_at")
      .eq("organization_id", request.organizationId)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`Failed to list API keys: ${error.message}`);
    return ((data ?? []) as ApiKeyRow[]).map(toPublic);
  },

  async findById(request: FastifyRequest, id: string): Promise<ApiKeyRow | null> {
    const { data, error } = await supabase
      .from("api_keys")
      .select("id, organization_id, name, key_hash, key_salt, key_prefix, scopes, active, request_count, error_count, created_at, updated_at, last_used_at")
      .eq("organization_id", request.organizationId)
      .eq("id", id)
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`Failed to fetch API key: ${error.message}`);
    return (data as ApiKeyRow | null) ?? null;
  },

  async update(request: FastifyRequest, id: string, body: ApiKeyUpdateBody): Promise<ApiKeyPublic> {
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.scopes !== undefined) patch.scopes = body.scopes;
    if (body.active !== undefined) {
      patch.active = body.active;
      patch.revoked_at = body.active ? null : new Date().toISOString();
    }

    const { data, error } = await supabase
      .from("api_keys")
      .update(patch)
      .eq("organization_id", request.organizationId)
      .eq("id", id)
      .select("id, organization_id, name, key_hash, key_salt, key_prefix, scopes, active, request_count, error_count, created_at, updated_at, last_used_at")
      .single();

    if (error) throw new Error(`Failed to update API key: ${error.message}`);
    return toPublic(data as ApiKeyRow);
  },

  async remove(request: FastifyRequest, id: string): Promise<void> {
    const { error } = await supabase
      .from("api_keys")
      .delete()
      .eq("organization_id", request.organizationId)
      .eq("id", id);

    if (error) throw new Error(`Failed to delete API key: ${error.message}`);
  },

  async findActiveByPrefix(keyPrefix: string): Promise<ApiKeyAuthRecord[]> {
    const { data, error } = await supabase
      .from("api_keys")
      .select("id, organization_id, key_hash, key_salt, scopes, active")
      .eq("key_prefix", keyPrefix)
      .eq("active", true)
      .is("revoked_at", null)
      .limit(10);

    if (error) throw new Error(`Failed to resolve API key: ${error.message}`);
    return (data as ApiKeyAuthRecord[] | null) ?? [];
  },

  async markUsed(id: string): Promise<void> {
    const { error } = await supabase.rpc("increment_api_key_usage", { p_key_id: id });
    if (error) throw new Error(`Failed to mark API key usage: ${error.message}`);
  },

  async markError(id: string): Promise<void> {
    const { error } = await supabase.rpc("increment_api_key_error", { p_key_id: id });
    if (error) throw new Error(`Failed to mark API key error: ${error.message}`);
  },
};
