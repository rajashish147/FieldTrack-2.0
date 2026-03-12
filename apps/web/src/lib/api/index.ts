// Re-export everything so existing imports of "@/lib/api" continue to resolve.
export { apiGet, apiGetPaginated, apiPatch, apiPost } from "@/lib/api/client";
export { API } from "@/lib/api/endpoints";
