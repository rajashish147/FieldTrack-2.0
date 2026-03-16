"use client";

import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { apiGetPaginated, apiPatch, apiPost } from "@/lib/api/client";
import { API } from "@/lib/api/endpoints";
import { Expense, PaginatedResponse, ExpenseStatus, EmployeeExpenseSummary } from "@/types";

export interface CreateExpenseBody {
  amount: number;
  description: string;
  receipt_url?: string;
}

export function useMyExpenses(page: number, limit: number) {
  return useQuery<PaginatedResponse<Expense>>({
    queryKey: ["expenses", page, limit],
    queryFn: () =>
      apiGetPaginated<Expense>(API.expenses, {
        page: String(page),
        limit: String(limit),
      }),
  });
}

export function useOrgExpenses(page: number, limit: number) {
  return useQuery<PaginatedResponse<Expense>>({
    queryKey: ["orgExpenses", page, limit],
    queryFn: () =>
      apiGetPaginated<Expense>(API.orgExpenses, {
        page: String(page),
        limit: String(limit),
      }),
  });
}

/**
 * Fetches org expenses for a specific employee — used in the admin expense
 * review sheet so individual expense rows load on-demand instead of bulk-fetching.
 */
export function useEmployeeOrgExpenses(employeeId: string | null, page = 1, limit = 50) {
  return useQuery<PaginatedResponse<Expense>>({
    queryKey: ["orgExpenses", "employee", employeeId, page, limit],
    queryFn: () =>
      apiGetPaginated<Expense>(API.orgExpenses, {
        employee_id: employeeId!,
        page: String(page),
        limit: String(limit),
      }),
    enabled: !!employeeId,
  });
}

/**
 * Fetches ALL org expenses across all pages (limit=100 per page).
 * Auto-fetches subsequent pages until the entire dataset is loaded.
 * Returns a flat array of all expenses for client-side grouping.
 */
export function useAllOrgExpenses() {
  const query = useInfiniteQuery<PaginatedResponse<Expense>, Error, Expense[], [string], number>({
    queryKey: ["orgExpensesAll"],
    queryFn: ({ pageParam }) =>
      apiGetPaginated<Expense>(API.orgExpenses, {
        page: String(pageParam),
        limit: "1000",
      }),
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
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useCreateExpense() {
  const client = useQueryClient();

  return useMutation<Expense, Error, CreateExpenseBody>({
    mutationFn: (body) => apiPost<Expense>(API.createExpense, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}

export function useUpdateExpenseStatus() {
  const client = useQueryClient();

  return useMutation<Expense, Error, { id: string; status: ExpenseStatus }>({
    mutationFn: ({ id, status }) =>
      apiPatch<Expense>(API.expenseStatus(id), { status }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["orgExpenses"] });
      void client.invalidateQueries({ queryKey: ["orgExpensesAll"] });
      void client.invalidateQueries({ queryKey: ["expensesSummary"] });
    },
  });
}

/**
 * Fetches expense totals grouped by employee — one row per employee.
 * Replaces client-side grouping in useAllOrgExpenses for admin views.
 *
 * staleTime=30s to avoid over-fetching; admin expense summaries are not
 * real-time sensitive (auditors review PENDING in batches).
 */
export function useExpenseSummaryByEmployee(page: number, limit: number) {
  return useQuery<PaginatedResponse<EmployeeExpenseSummary>>({
    queryKey: ["expensesSummary", page, limit],
    queryFn: () =>
      apiGetPaginated<EmployeeExpenseSummary>(API.expensesSummary, {
        page: String(page),
        limit: String(limit),
      }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

