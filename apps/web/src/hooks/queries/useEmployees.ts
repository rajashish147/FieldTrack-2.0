"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiGetPaginated, apiPost, apiPatch } from "@/lib/api/client";
import { API } from "@/lib/api/endpoints";
import type { PaginatedResponse } from "@/types";

export interface EmployeeRecord {
  id: string;
  organization_id: string;
  user_id: string | null;
  name: string;
  employee_code: string;
  phone: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function useEmployeeList(
  page: number,
  limit: number,
  filters?: { active?: boolean; search?: string },
) {
  return useQuery<PaginatedResponse<EmployeeRecord>>({
    queryKey: ["employees", page, limit, filters],
    queryFn: () => {
      const params: Record<string, string> = {
        page: String(page),
        limit: String(limit),
      };
      if (filters?.active !== undefined) params["active"] = String(filters.active);
      if (filters?.search) params["search"] = filters.search;
      return apiGetPaginated<EmployeeRecord>(API.listEmployees, params);
    },
  });
}

export function useEmployee(id: string | null) {
  return useQuery<EmployeeRecord>({
    queryKey: ["employee", id],
    enabled: id !== null,
    queryFn: () => apiGet<EmployeeRecord>(API.getEmployee(id!)),
  });
}

export function useCreateEmployee() {
  const client = useQueryClient();
  return useMutation<
    EmployeeRecord,
    Error,
    { name: string; employee_code?: string; user_id?: string; phone?: string }
  >({
    mutationFn: (body) => apiPost<EmployeeRecord>(API.createEmployee, body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["employees"] }),
  });
}

export function useUpdateEmployee(id: string) {
  const client = useQueryClient();
  return useMutation<EmployeeRecord, Error, { name?: string; phone?: string | null }>({
    mutationFn: (body) => apiPatch<EmployeeRecord>(API.updateEmployee(id), body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["employees"] });
      void client.invalidateQueries({ queryKey: ["employee", id] });
    },
  });
}

export function useSetEmployeeStatus(id: string) {
  const client = useQueryClient();
  return useMutation<EmployeeRecord, Error, boolean>({
    mutationFn: (isActive) =>
      apiPatch<EmployeeRecord>(API.setEmployeeStatus(id), { is_active: isActive }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["employees"] });
      void client.invalidateQueries({ queryKey: ["employee", id] });
    },
  });
}
