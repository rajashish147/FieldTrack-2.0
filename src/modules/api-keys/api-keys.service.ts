import type { FastifyRequest } from "fastify";
import { BadRequestError, NotFoundError } from "../../utils/errors.js";
import { apiKeysRepository } from "./api-keys.repository.js";
import type { ApiKeyCreateBody, ApiKeyCreateResult, ApiKeyPublic, ApiKeyUpdateBody } from "./api-keys.schema.js";
import { generateRawApiKey, getKeyPrefix, getKeyPreview, hashApiKey } from "./api-keys.security.js";

export const apiKeysService = {
  async createKey(request: FastifyRequest, body: ApiKeyCreateBody): Promise<ApiKeyCreateResult> {
    const raw = generateRawApiKey();
    const { hash: keyHash, salt: keySalt } = hashApiKey(raw);
    const keyPrefix = getKeyPrefix(raw);

    const record = await apiKeysRepository.create(request, body, keyHash, keySalt, keyPrefix);

    return {
      key: raw,
      record: {
        ...record,
        key_preview: getKeyPreview(raw),
      },
    };
  },

  async listKeys(request: FastifyRequest): Promise<ApiKeyPublic[]> {
    return apiKeysRepository.list(request);
  },

  async updateKey(request: FastifyRequest, id: string, body: ApiKeyUpdateBody): Promise<ApiKeyPublic> {
    const existing = await apiKeysRepository.findById(request, id);
    if (!existing) throw new NotFoundError("API key not found");

    if (body.scopes?.includes("admin:all") && body.scopes.length > 1) {
      throw new BadRequestError("admin:all cannot be combined with other scopes");
    }

    return apiKeysRepository.update(request, id, body);
  },

  async deleteKey(request: FastifyRequest, id: string): Promise<void> {
    const existing = await apiKeysRepository.findById(request, id);
    if (!existing) throw new NotFoundError("API key not found");
    await apiKeysRepository.remove(request, id);
  },
};
