import type { FastifyRequest, FastifyReply } from "fastify";
import { profileService } from "./profile.service.js";
import { ok, handleError } from "../../utils/response.js";
import { employeesRepository } from "../employees/employees.repository.js";

export const profileController = {
  /**
   * GET /profile/me
   * Employee's own profile.
   *
   * Returns 200 {data: null, meta: {hasProfile: false}} for ADMIN users and
   * any auth'd user without a linked employee row.  A missing profile is NOT
   * an authentication or authorisation failure.
   */
  async getMyProfile(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const data = await profileService.getMyProfile(request);

      if (data === null) {
        reply.status(200).send({
          success: true,
          data: null,
          meta: { hasProfile: false },
        });
        return;
      }

      reply.status(200).send(ok(data));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error in getMyProfile");
    }
  },

  /**
   * GET /admin/employees/:employeeId/profile
   * Admin access to any employee profile in their org.
   * Returns comprehensive profile: info + stats + recent sessions + recent expenses.
   */
  async getEmployeeProfile(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const { employeeId } = request.params as { employeeId: string };
      const data = await employeesRepository.getEmployeeProfile(request, employeeId);
      if (!data) {
        reply.status(404).send({ success: false, error: "Employee not found" });
        return;
      }
      reply.status(200).send(ok(data));
    } catch (error) {
      handleError(error, request, reply, "Unexpected error in getEmployeeProfile");
    }
  },
};
