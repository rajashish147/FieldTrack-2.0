import { supabase } from "@/lib/supabase";
import { env } from "@/lib/env";
import { ApiError, ApiResponse, PaginatedResponse } from "@/types";

async function getAuthHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (session?.access_token) {
    headers["Authorization"] = `Bearer ${session.access_token}`;
  }

  return headers;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    await supabase.auth.signOut();
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new ApiError("Unauthorized. Please log in again.", 401);
  }

  const json = (await response.json()) as ApiResponse<T>;

  if (!json.success) {
    throw new ApiError(json.error, response.status, json.requestId);
  }

  return json.data;
}

async function handlePaginatedResponse<T>(
  response: Response
): Promise<PaginatedResponse<T>> {
  if (response.status === 401) {
    await supabase.auth.signOut();
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new ApiError("Unauthorized. Please log in again.", 401);
  }

  const json = (await response.json()) as Record<string, unknown>;

  if (!json["success"]) {
    const error = (json["error"] as string) ?? "Unknown error";
    const requestId = (json["requestId"] as string) ?? "";
    throw new ApiError(error, response.status, requestId);
  }

  const data = json["data"] as T[];
  const rawPagination = json["pagination"] as
    | { page: number; limit: number; total: number }
    | undefined;

  return {
    success: true,
    data,
    pagination: rawPagination ?? {
      page: 1,
      limit: data.length,
      total: data.length,
    },
  };
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, string>
): Promise<T> {
  const headers = await getAuthHeaders();
  const qs = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params)}` : "";
  const response = await fetch(`${env.NEXT_PUBLIC_API_URL}${path}${qs}`, {
    method: "GET",
    headers,
  });

  return handleResponse<T>(response);
}

export async function apiGetPaginated<T>(
  path: string,
  params?: Record<string, string>
): Promise<PaginatedResponse<T>> {
  const headers = await getAuthHeaders();
  const qs = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params)}` : "";
  const response = await fetch(`${env.NEXT_PUBLIC_API_URL}${path}${qs}`, {
    method: "GET",
    headers,
  });

  return handlePaginatedResponse<T>(response);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers = await getAuthHeaders();

  const response = await fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return handleResponse<T>(response);
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const headers = await getAuthHeaders();

  const response = await fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });

  return handleResponse<T>(response);
}
