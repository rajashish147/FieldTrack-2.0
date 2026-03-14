"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api/client";
import { API } from "@/lib/api/endpoints";
import { DashboardSummary, AdminDashboardData, EmployeeMapMarker } from "@/types";

export function useMyDashboard() {
  return useQuery<DashboardSummary>({
    queryKey: ["myDashboard"],
    queryFn: () => apiGet<DashboardSummary>(API.myDashboard),
  });
}

/**
 * Fetches the admin dashboard aggregation — one endpoint replacing 4+ calls.
 * Stale time is 30 s; admin stats are near-real-time, not real-time.
 */
export function useAdminDashboard() {
  return useQuery<AdminDashboardData>({
    queryKey: ["adminDashboard"],
    queryFn: () => apiGet<AdminDashboardData>(API.adminDashboard),
    staleTime: 30_000,
  });
}

/**
 * Fetches latest GPS positions for all employees — used by the map page.
 * Refreshes every 30 s automatically for a near-live view.
 */
export function useAdminMap() {
  return useQuery<EmployeeMapMarker[]>({
    queryKey: ["adminMap"],
    queryFn: () => apiGet<EmployeeMapMarker[]>(API.adminMap),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
