import { z } from "zod";

export const employeeProfileQuerySchema = z.object({
  from: z
    .string()
    .datetime({ offset: true, message: "from must be a valid ISO-8601 date" })
    .optional(),
  to: z
    .string()
    .datetime({ offset: true, message: "to must be a valid ISO-8601 date" })
    .optional(),
});

export type EmployeeProfileQuery = z.infer<typeof employeeProfileQuerySchema>;

export type { EmployeeProfileData } from "../../types/shared.js";
