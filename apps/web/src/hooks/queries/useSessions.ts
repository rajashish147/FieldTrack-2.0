"use client";

import { useQuery, useQueryClient, useInfiniteQuery, keepPreviousData } from "@tanstack/react-query";
import { useEffect } from "react";
import { apiGetPaginated } from "@/lib/api/client";
import { API } from "@/lib/api/endpoints";
import { AttendanceSession, PaginatedResponse } from "@/types";

export function useMySessions(page: number, limit: number) {
  return useQuery<PaginatedResponse<AttendanceSession>>({
    queryKey: ["sessions", page, limit],
    queryFn: () =>
      apiGetPaginated<AttendanceSession>(API.sessions, {
        page: String(page),
        limit: String(limit),
      }),
  });
}

export function useOrgSessions(page: number, limit: number) {
  return useQuery<PaginatedResponse<AttendanceSession>>({
    queryKey: ["orgSessions", page, limit],
    queryFn: () =>
      apiGetPaginated<AttendanceSession>(API.orgSessions, {
        page: String(page),
        limit: String(limit),
      }),
  });
}

/**
 * Fetches ALL org sessions across all pages (limit=50 per page).
 * Auto-fetches subsequent pages until the entire dataset is loaded.
 * Returns a flat array of all sessions for client-side grouping.
 *
 * Backend now reads from employee_latest_sessions (one row per employee),
 * so the dataset converges in 1–2 fetches for most organisations.
 */
export function useAllOrgSessions() {
  const query = useInfiniteQuery<PaginatedResponse<AttendanceSession>, Error, AttendanceSession[], [string], number>({
    queryKey: ["orgSessionsAll"],
    queryFn: ({ pageParam }) =>
      apiGetPaginated<AttendanceSession>(API.adminSessions, {
        page: String(pageParam),
        limit: "50",
      }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => {
      const fetched = allPages.reduce((sum, p) => sum + p.data.length, 0);
      return fetched < lastPage.pagination.total ? allPages.length + 1 : undefined;
    },
    select: (data) => data.pages.flatMap((p) => p.data),
  });

  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  return {
    data: query.data ?? [],
    isLoading: query.isLoading || query.hasNextPage === true,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * Fetches all sessions for a specific employee (history drill-down).
 * Used by the session history sheet in the admin sessions page.
 * Only active when employeeId is non-null.
 */
export function useEmployeeSessionHistory(employeeId: string | null) {
  return useQuery<PaginatedResponse<AttendanceSession>>({
    queryKey: ["orgSessionsEmployee", employeeId],
    queryFn: () =>
      apiGetPaginated<AttendanceSession>(API.orgSessions, {
        employee_id: employeeId!,
        page: "1",
        limit: "100",
      }),
    enabled: !!employeeId,
  });
}

/**
 * Fetches a single session by ID. Checks the React Query sessions cache first;
 * if not found (e.g. direct navigation), falls back to fetching from the API.
 */
export function useMySession(id: string) {
  const queryClient = useQueryClient();
  return useQuery<AttendanceSession | undefined>({
    queryKey: ["session", id],
    queryFn: async () => {
      const allPages = queryClient.getQueriesData<PaginatedResponse<AttendanceSession>>({
        queryKey: ["sessions"],
      });
      for (const [, page] of allPages) {
        const found = page?.data?.find((s) => s.id === id);
        if (found) return found;
      }
      const result = await apiGetPaginated<AttendanceSession>(API.sessions, {
        page: "1",
        limit: "100",
      });
      return result.data.find((s) => s.id === id);
    },
    staleTime: 30_000,
  });
}
