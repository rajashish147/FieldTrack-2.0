"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api/client";
import { API } from "@/lib/api/endpoints";
import { EmployeeProfileData } from "@/types";

export function useMyProfile() {
  return useQuery<EmployeeProfileData>({
    queryKey: ["myProfile"],
    queryFn: () => apiGet<EmployeeProfileData>(API.myProfile),
  });
}

export function useEmployeeProfile(employeeId: string) {
  return useQuery<EmployeeProfileData>({
    queryKey: ["employeeProfile", employeeId],
    queryFn: () =>
      apiGet<EmployeeProfileData>(API.employeeProfile(employeeId)),
    enabled: !!employeeId,
  });
}
