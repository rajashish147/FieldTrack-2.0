import { supabase } from "@/lib/supabase";
import { env } from "@/lib/env";
import { ApiError, ApiResponse, PaginatedResponse } from "@/types";

// Cache session token to avoid repeated fetches
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

async function getAuthHeaders(): Promise<Record<string, string>> {
  const now = Date.now();
  
  // Use cached token if still valid (with 30s buffer)
  if (cachedToken && tokenExpiry > now + 30000) {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${cachedToken}`,
    };
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (session?.access_token) {
    headers["Authorization"] = `Bearer ${session.access_token}`;
    cachedToken = session.access_token;
    // JWT exp is in seconds, convert to milliseconds
    tokenExpiry = (session.expires_at ?? 0) * 1000;
  } else {
    cachedToken = null;
    tokenExpiry = 0;
  }

  return headers;
}

async function handleAuthFailure(): Promise<void> {
  // Clear cached token
  cachedToken = null;
  tokenExpiry = 0;
  
  // Sign out and redirect
  await supabase.auth.signOut();
  
  if (typeof window !== "undefined") {
    // Clear all query cache on auth failure
    window.location.href = "/login";
  }
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = 10000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError("Request timeout", 408);
    }
    throw error;
  }
}

async function retryableFetch(
  url: string,
  options: RequestInit,
  maxRetries: number = 2
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchWithTimeout(url, options);
    } catch (error) {
      lastError = error as Error;
      
      // Only retry GET requests
      if (options.method && options.method !== "GET") {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === maxRetries) {
        throw error;
      }

      // Exponential backoff: 500ms, 1000ms
      const backoffMs = 500 * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError;
}

async function parseJsonOrThrow(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return response.text().then((text) => {
      console.error("[FieldTrack API] Non-JSON response", {
        url: response.url,
        status: response.status,
        contentType,
        preview: text.slice(0, 400),
      });
      throw new ApiError(
        `API Error: Expected JSON but received "${contentType}" (HTTP ${response.status}). ` +
        `Check NEXT_PUBLIC_API_BASE_URL or proxy config.`,
        response.status
      );
    });
  }
  return response.json();
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    await handleAuthFailure();
    throw new ApiError("Unauthorized. Please log in again.", 401);
  }

  // For any non-2xx response whose body is NOT JSON (e.g. an HTML 502 from a
  // load balancer or CDN), surface a clean error immediately instead of
  // letting parseJsonOrThrow emit the confusing “Expected JSON” message.
  // JSON error bodies (e.g. 400/422 with { success: false, error: "..." })
  // fall through and are handled by the json.success check below.
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const text = await response.text();
      console.error("[FieldTrack API] Non-JSON error response", {
        url: response.url,
        status: response.status,
        preview: text.slice(0, 200),
      });
      throw new ApiError(`HTTP ${response.status} error from API`, response.status);
    }
  }

  const json = (await parseJsonOrThrow(response)) as ApiResponse<T>;

  if (!json.success) {
    throw new ApiError(json.error, response.status, json.requestId);
  }

  return json.data;
}

async function handlePaginatedResponse<T>(
  response: Response
): Promise<PaginatedResponse<T>> {
  if (response.status === 401) {
    await handleAuthFailure();
    throw new ApiError("Unauthorized. Please log in again.", 401);
  }

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const text = await response.text();
      console.error("[FieldTrack API] Non-JSON error response", {
        url: response.url,
        status: response.status,
        preview: text.slice(0, 200),
      });
      throw new ApiError(`HTTP ${response.status} error from API`, response.status);
    }
  }

  const json = (await parseJsonOrThrow(response)) as Record<string, unknown>;

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
  if (!env.NEXT_PUBLIC_API_BASE_URL) {
    throw new ApiError(
      "NEXT_PUBLIC_API_BASE_URL is not set. Set it to the backend API URL (e.g. https://api.getfieldtrack.app) in your Vercel project settings.",
      500
    );
  }
  const headers = await getAuthHeaders();
  const qs = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params)}` : "";
  const response = await retryableFetch(`${env.NEXT_PUBLIC_API_BASE_URL}${path}${qs}`, {
    method: "GET",
    headers,
  });

  return handleResponse<T>(response);
}

export async function apiGetPaginated<T>(
  path: string,
  params?: Record<string, string>
): Promise<PaginatedResponse<T>> {
  if (!env.NEXT_PUBLIC_API_BASE_URL) {
    throw new ApiError(
      "NEXT_PUBLIC_API_BASE_URL is not set. Set it to the backend API URL (e.g. https://api.getfieldtrack.app) in your Vercel project settings.",
      500
    );
  }
  const headers = await getAuthHeaders();
  const qs = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params)}` : "";
  const response = await retryableFetch(`${env.NEXT_PUBLIC_API_BASE_URL}${path}${qs}`, {
    method: "GET",
    headers,
  });

  return handlePaginatedResponse<T>(response);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  if (!env.NEXT_PUBLIC_API_BASE_URL) {
    throw new ApiError(
      "NEXT_PUBLIC_API_BASE_URL is not set. Set it to the backend API URL (e.g. https://api.getfieldtrack.app) in your Vercel project settings.",
      500
    );
  }
  const headers = await getAuthHeaders();

  const response = await fetchWithTimeout(`${env.NEXT_PUBLIC_API_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return handleResponse<T>(response);
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  if (!env.NEXT_PUBLIC_API_BASE_URL) {
    throw new ApiError(
      "NEXT_PUBLIC_API_BASE_URL is not set. Set it to the backend API URL (e.g. https://api.getfieldtrack.app) in your Vercel project settings.",
      500
    );
  }
  const headers = await getAuthHeaders();

  const response = await fetchWithTimeout(`${env.NEXT_PUBLIC_API_BASE_URL}${path}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });

  return handleResponse<T>(response);
}
