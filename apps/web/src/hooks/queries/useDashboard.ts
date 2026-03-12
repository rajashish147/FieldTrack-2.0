"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api/client";
import { API } from "@/lib/api/endpoints";
import { DashboardSummary } from "@/types";

export function useMyDashboard() {
  return useQuery<DashboardSummary>({
    queryKey: ["myDashboard"],
    queryFn: () => apiGet<DashboardSummary>(API.myDashboard),
  });
}
