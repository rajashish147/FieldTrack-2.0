"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api/client";
import { API } from "@/lib/api/endpoints";
import { OrgSummaryData, TopPerformerEntry, SessionTrendEntry, LeaderboardEntry } from "@/types";

export function useOrgSummary(from?: string, to?: string) {
  return useQuery<OrgSummaryData>({
    queryKey: ["orgSummary", from, to],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (from) params["from"] = from;
      if (to) params["to"] = to;
      return apiGet<OrgSummaryData>(API.orgSummary, params);
    },
  });
}

export function useTopPerformers(
  metric: string,
  limit?: number,
  from?: string,
  to?: string
) {
  return useQuery<TopPerformerEntry[]>({
    queryKey: ["topPerformers", metric, limit, from, to],
    queryFn: () => {
      const params: Record<string, string> = { metric };
      if (limit) params["limit"] = String(limit);
      if (from) params["from"] = from;
      if (to) params["to"] = to;
      return apiGet<TopPerformerEntry[]>(API.topPerformers, params);
    },
  });
}

export function useSessionTrend(from?: string, to?: string) {
  return useQuery<SessionTrendEntry[]>({
    queryKey: ["sessionTrend", from, to],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (from) params["from"] = from;
      if (to) params["to"] = to;
      return apiGet<SessionTrendEntry[]>(API.sessionTrend, params);
    },
  });
}

export function useLeaderboard(
  metric: string,
  limit?: number,
  from?: string,
  to?: string
) {
  return useQuery<LeaderboardEntry[]>({
    queryKey: ["leaderboard", metric, limit, from, to],
    queryFn: () => {
      const params: Record<string, string> = { metric };
      if (limit) params["limit"] = String(limit);
      if (from) params["from"] = from;
      if (to) params["to"] = to;
      return apiGet<LeaderboardEntry[]>(API.leaderboard, params);
    },
  });
}
