import type { FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

/**
 * Register Zod validator and serializer compilers on a Fastify instance.
 *
 * Must be called before any routes are registered on the instance so that
 * Fastify uses the Zod compiler instead of the default AJV compiler.
 *
 * This is the single source of truth for Zod integration.  Both the
 * production server (app.ts) and the test server (test-server.ts) call this
 * function so that compiler behaviour is identical in every environment.
 */
export function registerZod(app: FastifyInstance): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
}
