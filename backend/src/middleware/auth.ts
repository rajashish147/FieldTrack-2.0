import type { FastifyRequest, FastifyReply } from "fastify";
import { UnauthorizedError } from "../utils/errors.js";

export async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    try {
        await request.jwtVerify();
    } catch (_error) {
        const err = new UnauthorizedError("Invalid or missing authentication token");
        reply.status(err.statusCode).send({ error: err.message });
    }
}
