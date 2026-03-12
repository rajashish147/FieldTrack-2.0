"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGetPaginated, apiPost } from "@/lib/api/client";
import { API } from "@/lib/api/endpoints";
import { AdminSession, PaginatedResponse } from "@/types";

export function useMonitoringHistory(page: number, limit: number) {
  return useQuery<PaginatedResponse<AdminSession>>({
    queryKey: ["monitoringHistory", page, limit],
    queryFn: () =>
      apiGetPaginated<AdminSession>(API.monitoringHistory, {
        page: String(page),
        limit: String(limit),
      }),
  });
}

export function useStartMonitoring() {
  const client = useQueryClient();
  return useMutation<AdminSession, Error, void>({
    mutationFn: () => apiPost<AdminSession>(API.startMonitoring, {}),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["monitoringHistory"] });
    },
  });
}

export function useStopMonitoring() {
  const client = useQueryClient();
  return useMutation<AdminSession, Error, void>({
    mutationFn: () => apiPost<AdminSession>(API.stopMonitoring, {}),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["monitoringHistory"] });
    },
  });
}
