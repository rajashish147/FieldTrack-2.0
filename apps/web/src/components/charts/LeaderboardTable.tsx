"use client";

import { motion } from "framer-motion";
import { LeaderboardEntry } from "@/types";
import { EmptyState } from "@/components/EmptyState";
import { Trophy } from "lucide-react";
import { formatDistance, formatDuration, formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { EmployeeIdentity } from "@/components/EmployeeIdentity";

interface LeaderboardTableProps {
  data: LeaderboardEntry[];
  metric: string;
  highlightEmployeeId?: string;
  /** Enables click navigation + hover quick-actions on employee identity */
  isAdmin?: boolean;
}

// Top-3 row tints — subtle overlay that works in both themes
const TOP3_TINTS: Record<number, string> = {
  1: "bg-amber-400/[0.07] dark:bg-amber-300/[0.07]",
  2: "bg-slate-400/[0.06] dark:bg-slate-300/[0.06]",
  3: "bg-orange-400/[0.06] dark:bg-orange-300/[0.06]",
};

// Progress bar fill colours
const PROGRESS_COLORS: Record<string, string> = {
  distance: "bg-blue-500",
  sessions: "bg-violet-500",
  duration: "bg-emerald-500",
  expenses: "bg-amber-500",
};

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <span className="text-2xl leading-none select-none">🥇</span>;
  if (rank === 2) return <span className="text-2xl leading-none select-none">🥈</span>;
  if (rank === 3) return <span className="text-2xl leading-none select-none">🥉</span>;
  return (
    <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-muted-foreground ring-1 ring-border/40">
      {rank}
    </span>
  );
}

function formatMetricValue(entry: LeaderboardEntry, metric: string): string {
  if (metric === "distance") return formatDistance(entry.distance);
  if (metric === "sessions") return String(entry.sessions);
  if (metric === "duration") return formatDuration(entry.duration);
  if (metric === "expenses") return formatCurrency(entry.expenses ?? 0);
  return "—";
}

function metricLabel(metric: string): string {
  if (metric === "distance") return "Distance";
  if (metric === "sessions") return "Sessions";
  if (metric === "duration") return "Duration";
  if (metric === "expenses") return "Expenses";
  return metric;
}

function rawMetricValue(entry: LeaderboardEntry, metric: string): number {
  if (metric === "distance") return entry.distance;
  if (metric === "sessions") return entry.sessions;
  if (metric === "duration") return entry.duration;
  if (metric === "expenses") return entry.expenses ?? 0;
  return 0;
}

export function LeaderboardTable({ data, metric, highlightEmployeeId, isAdmin }: LeaderboardTableProps) {
  if (data.length === 0) {
    return (
      <EmptyState
        icon={Trophy}
        title="No leaderboard data"
        description="Leaderboard will appear here once employee metrics are computed."
      />
    );
  }

  const maxValue = Math.max(...data.map((e) => rawMetricValue(e, metric)));
  const progressColor = PROGRESS_COLORS[metric] ?? "bg-primary";

  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/60 text-left text-muted-foreground bg-muted/30">
            <th className="px-4 py-3 font-medium w-14">#</th>
            <th className="px-4 py-3 font-medium">Employee</th>
            <th className="px-4 py-3 font-medium text-right text-foreground">
              {metricLabel(metric)}
            </th>
            <th className="px-4 py-3 font-medium text-right hidden sm:table-cell">
              {metric !== "distance" ? "Distance" : "Sessions"}
            </th>
            <th className="px-4 py-3 font-medium text-right hidden md:table-cell">
              {metric !== "duration" ? "Duration" : "Distance"}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {data.map((entry, idx) => {
            const isTop3 = entry.rank <= 3;
            const isHighlighted = entry.employeeId === highlightEmployeeId;
            const pct = maxValue > 0 ? (rawMetricValue(entry, metric) / maxValue) * 100 : 0;

            return (
              <motion.tr
                key={entry.employeeId}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, delay: idx * 0.04, ease: "easeOut" }}
                className={cn(
                  "transition-all duration-200 cursor-default",
                  "hover:bg-muted/60 dark:hover:bg-slate-800/70",
                  isTop3 && TOP3_TINTS[entry.rank],
                  isHighlighted && "ring-1 ring-inset ring-primary/40 bg-primary/[0.05] dark:bg-primary/[0.08]"
                )}
              >
                {/* Rank */}
                <td className="px-4 py-3 w-14">
                  <div className="flex items-center justify-center">
                    <RankBadge rank={entry.rank} />
                  </div>
                </td>

                {/* Employee identity + progress bar */}
                <td className="px-4 py-3">
                  <EmployeeIdentity
                    employeeId={entry.employeeId}
                    name={entry.employeeName}
                    employeeCode={entry.employeeCode}
                    isAdmin={isAdmin}
                    isCurrentUser={isHighlighted && !isAdmin}
                    showTooltip={isAdmin}
                    size="sm"
                  />
                  {/* Animated progress bar */}
                  <div className="mt-1.5 h-1 w-full max-w-[160px] rounded-full bg-muted overflow-hidden">
                    <motion.div
                      className={cn("h-full rounded-full", progressColor)}
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.6, delay: idx * 0.04 + 0.15, ease: "easeOut" }}
                    />
                  </div>
                </td>

                {/* Primary metric */}
                <td className="px-4 py-3 text-right font-semibold tabular-nums">
                  {formatMetricValue(entry, metric)}
                </td>

                {/* Secondary metric */}
                <td className="px-4 py-3 text-right text-muted-foreground hidden sm:table-cell tabular-nums">
                  {metric !== "distance" ? formatDistance(entry.distance) : entry.sessions}
                </td>

                {/* Tertiary metric */}
                <td className="px-4 py-3 text-right text-muted-foreground hidden md:table-cell tabular-nums">
                  {metric !== "duration" ? formatDuration(entry.duration) : formatDistance(entry.distance)}
                </td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
