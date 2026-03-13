"use client";

import { LeaderboardEntry } from "@/types";
import { EmptyState } from "@/components/EmptyState";
import { Trophy } from "lucide-react";
import { formatDistance, formatDuration } from "@/lib/utils";

interface LeaderboardTableProps {
  data: LeaderboardEntry[];
  metric: string;
}

export function LeaderboardTable({ data, metric }: LeaderboardTableProps) {
  if (data.length === 0) {
    return (
      <EmptyState
        icon={Trophy}
        title="No leaderboard data"
        description="Leaderboard will appear here once employee metrics are computed."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="pb-2 pr-4 font-medium">#</th>
            <th className="pb-2 pr-4 font-medium">Employee</th>
            <th className="pb-2 pr-4 font-medium">Code</th>
            <th className="pb-2 pr-4 font-medium text-right">Distance</th>
            <th className="pb-2 pr-4 font-medium text-right">Sessions</th>
            <th className={`pb-2 font-medium text-right ${metric === "expenses" ? "pr-4" : ""}`}>Duration</th>
            {metric === "expenses" && (
              <th className="pb-2 font-medium text-right">Expenses</th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.map((entry) => (
            <tr key={entry.employeeId} className="border-b last:border-0">
              <td className="py-2 pr-4 font-semibold">{entry.rank}</td>
              <td className="py-2 pr-4">{entry.employeeName}</td>
              <td className="py-2 pr-4 text-muted-foreground">{entry.employeeCode ?? "—"}</td>
              <td className={`py-2 pr-4 text-right ${metric === "distance" ? "font-semibold" : ""}`}>
                {formatDistance(entry.distance)}
              </td>
              <td className={`py-2 pr-4 text-right ${metric === "sessions" ? "font-semibold" : ""}`}>
                {entry.sessions}
              </td>
              <td className={`py-2 text-right ${metric === "duration" ? "font-semibold" : ""} ${metric === "expenses" ? "pr-4" : ""}`}>
                {formatDuration(entry.duration)}
              </td>
              {metric === "expenses" && (
                <td className="py-2 text-right font-semibold">
                  {entry.expenses ?? 0}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
