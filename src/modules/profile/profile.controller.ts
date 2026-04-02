import type { FastifyRequest, FastifyReply } from "fastify";
import { profileService } from "./profile.service.js";
import { ok, handleError } from "../../utils/response.js";

export const profileController = {
  /**
   * GET /profile/me
   * Employee's own profile.
   */
  async getMyProfile(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const data = await profileService.getMyProfile(request);
      reply.status(200).send(ok(data));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error in getMyProfile");
    }
  },

  /**
   * GET /admin/employees/:employeeId/profile
   * Admin access to any employee profile in their org.
   */
  async getEmployeeProfile(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const { employeeId } = request.params as { employeeId: string };
      const data = await profileService.getEmployeeProfile(request, employeeId);
      reply.status(200).send(ok(data));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error in getEmployeeProfile");
    }
  },
};
