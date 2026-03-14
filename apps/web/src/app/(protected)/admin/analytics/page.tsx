"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/hooks/useAuth";
import {
  useOrgSummary,
  useTopPerformers,
  useSessionTrend,
  useLeaderboard,
} from "@/hooks/queries/useAnalytics";
import { TopPerformersChart } from "@/components/charts/TopPerformersChart";
import { SessionTrendChart } from "@/components/charts/SessionTrendChart";
import { LeaderboardTable } from "@/components/charts/LeaderboardTable";
import { MetricCard } from "@/components/MetricCard";
import { ErrorBanner } from "@/components/ErrorBanner";
import { StaggerList, StaggerItem, FadeUp } from "@/components/motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDistance, formatDuration, formatCurrency } from "@/lib/utils";
import { Activity, MapPin, Clock, Receipt, Users, TrendingUp, Trophy, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type DateRange,
  type PresetKey,
  PRESET_LABELS,
  rangeForPreset,
  loadPersistedPreset,
  loadPersistedCustomRange,
  persistPreset,
  persistCustomRange,
  toInputDate,
  formatRangeLabel,
} from "@/lib/dateRange";
import type { OrgSummaryData } from "@/types";

// --- Date Range Filter Bar ---------------------------------------------------

const PRESETS: PresetKey[] = [
  "today",
  "yesterday",
  "7d",
  "30d",
  "thisMonth",
  "lastMonth",
  "custom",
];

interface DateRangeFilterProps {
  preset: PresetKey;
  customRange: DateRange | null;
  activeRange: DateRange;
  onChange: (preset: PresetKey, customRange?: DateRange) => void;
}

function DateRangeFilter({
  preset,
  customRange,
  activeRange,
  onChange,
}: DateRangeFilterProps) {
  const [showCustom, setShowCustom] = useState(preset === "custom");
  const [localFrom, setLocalFrom] = useState(
    customRange ? customRange.from.slice(0, 10) : toInputDate(new Date())
  );
  const [localTo, setLocalTo] = useState(
    customRange ? customRange.to.slice(0, 10) : toInputDate(new Date())
  );

  function handlePreset(p: PresetKey) {
    if (p === "custom") {
      setShowCustom(true);
      onChange("custom", customRange ?? undefined);
    } else {
      setShowCustom(false);
      onChange(p);
    }
  }

  function handleApply() {
    if (!localFrom || !localTo) return;
    const from = new Date(localFrom);
    from.setHours(0, 0, 0, 0);
    const to = new Date(localTo);
    to.setHours(23, 59, 59, 999);
    if (from > to) return;
    const range: DateRange = { from: from.toISOString(), to: to.toISOString() };
    onChange("custom", range);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => handlePreset(p)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150 select-none",
              preset === p
                ? "bg-primary text-primary-foreground shadow-sm"
                : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            {PRESET_LABELS[p]}
            {p === "custom" && (
              <span className="ml-1 opacity-60">{showCustom ? "▲" : "▼"}</span>
            )}
          </button>
        ))}
      </div>

      <AnimatePresence>
        {showCustom && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Start Date</span>
                <input
                  type="date"
                  value={localFrom}
                  max={localTo}
                  onChange={(e) => setLocalFrom(e.target.value)}
                  className="rounded-lg border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">End Date</span>
                <input
                  type="date"
                  value={localTo}
                  min={localFrom}
                  onChange={(e) => setLocalTo(e.target.value)}
                  className="rounded-lg border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <button
                onClick={handleApply}
                className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 active:scale-95"
              >
                Apply
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Calendar className="h-3.5 w-3.5" />
        {formatRangeLabel(activeRange)}
      </p>
    </div>
  );
}

// --- Analytics Metric Cards --------------------------------------------------

function AnalyticsMetrics({
  summary,
  isLoading,
}: {
  summary?: OrgSummaryData;
  isLoading: boolean;
}) {
  const cards = [
    {
      title: "Sessions",
      value: summary?.totalSessions.toLocaleString() ?? "—",
      numericValue: summary?.totalSessions,
      icon: <Activity className="h-4 w-4" />,
    },
    {
      title: "Distance",
      value: summary ? formatDistance(summary.totalDistanceKm) : "—",
      icon: <MapPin className="h-4 w-4" />,
    },
    {
      title: "Duration",
      value: summary ? formatDuration(summary.totalDurationSeconds) : "—",
      icon: <Clock className="h-4 w-4" />,
    },
    {
      title: "Active Employees",
      value: summary?.activeEmployeesCount.toLocaleString() ?? "—",
      numericValue: summary?.activeEmployeesCount,
      icon: <Users className="h-4 w-4" />,
      highlighted: true,
    },
    {
      title: "Approved Expenses",
      value: summary ? formatCurrency(summary.approvedExpenseAmount) : "—",
      icon: <Receipt className="h-4 w-4" />,
    },
    {
      title: "Expense Requests",
      value: summary?.totalExpenses.toLocaleString() ?? "—",
      numericValue: summary?.totalExpenses,
      icon: <Receipt className="h-4 w-4" />,
    },
  ];

  return (
    <StaggerList className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {cards.map((card) => (
        <StaggerItem key={card.title}>
          <MetricCard
            title={card.title}
            value={card.value}
            numericValue={card.numericValue}
            icon={card.icon}
            highlighted={card.highlighted}
            isLoading={isLoading}
          />
        </StaggerItem>
      ))}
    </StaggerList>
  );
}

// --- Leaderboard section -----------------------------------------------------

type LbMetric = "distance" | "sessions" | "duration" | "expenses";

function AnalyticsLeaderboard({ from, to }: { from?: string; to?: string }) {
  const [metric, setMetric] = useState<LbMetric>("distance");
  const { data, isLoading, error } = useLeaderboard(metric, 10, from, to);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="flex items-center gap-2">
          <Trophy className="h-5 w-5 text-amber-500" />
          Employee Leaderboard
        </CardTitle>
        <Tabs value={metric} onValueChange={(v) => setMetric(v as LbMetric)}>
          <TabsList className="h-8">
            <TabsTrigger value="distance" className="text-xs px-2">Distance</TabsTrigger>
            <TabsTrigger value="sessions" className="text-xs px-2">Sessions</TabsTrigger>
            <TabsTrigger value="duration" className="text-xs px-2">Duration</TabsTrigger>
            <TabsTrigger value="expenses" className="text-xs px-2">Expenses</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        {error && <ErrorBanner error={error} />}
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <LeaderboardTable data={data ?? []} metric={metric} isAdmin />
        )}
      </CardContent>
    </Card>
  );
}

// --- Animated range transition wrapper ---------------------------------------

function RangeContent({
  rangeKey,
  children,
}: {
  rangeKey: string;
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={rangeKey}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

// --- Page --------------------------------------------------------------------

export default function AnalyticsPage() {
  const { permissions } = useAuth();
  const router = useRouter();

  if (!permissions.viewAnalytics) {
    router.replace("/sessions");
    return null;
  }

  // Lazy-init from localStorage — no flicker, no useEffect needed
  const [preset, setPreset] = useState<PresetKey>(() => loadPersistedPreset());
  const [customRange, setCustomRange] = useState<DateRange | null>(
    () => loadPersistedCustomRange()
  );

  const activeRange = useMemo<DateRange>(() => {
    if (preset === "custom" && customRange) return customRange;
    if (preset === "custom") return rangeForPreset("7d");
    return rangeForPreset(preset);
  }, [preset, customRange]);

  const { from, to } = activeRange;
  const rangeKey = `${from}::${to}`;

  function handleFilterChange(newPreset: PresetKey, newCustom?: DateRange) {
    setPreset(newPreset);
    persistPreset(newPreset);
    if (newCustom) {
      setCustomRange(newCustom);
      persistCustomRange(newCustom);
    }
  }

  const summary = useOrgSummary(from, to);
  const sessionTrend = useSessionTrend(from, to);
  const topByDistance = useTopPerformers("distance", 10, from, to);
  const topBySessions = useTopPerformers("sessions", 10, from, to);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight">Analytics</h2>
        <p className="text-sm text-muted-foreground">
          Historical performance insights — select a date range to explore trends.
        </p>
      </div>

      {/* Date range filter */}
      <div className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
        <DateRangeFilter
          preset={preset}
          customRange={customRange}
          activeRange={activeRange}
          onChange={handleFilterChange}
        />
      </div>

      {/* Animated content — remounts with fade on range change */}
      <RangeContent rangeKey={rangeKey}>
        <div className="space-y-6">
          {summary.error && <ErrorBanner error={summary.error} />}

          {/* Summary cards */}
          <AnalyticsMetrics summary={summary.data} isLoading={summary.isLoading} />

          {/* Session trend chart */}
          <FadeUp delay={0.05}>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-primary" />
                  Session Trend
                </CardTitle>
              </CardHeader>
              <CardContent>
                {sessionTrend.isLoading ? (
                  <Skeleton className="h-[280px] w-full" />
                ) : sessionTrend.error ? (
                  <ErrorBanner error={sessionTrend.error} />
                ) : (
                  <SessionTrendChart data={sessionTrend.data ?? []} />
                )}
              </CardContent>
            </Card>
          </FadeUp>

          {/* Top performers */}
          <FadeUp delay={0.1}>
            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Top by Distance</CardTitle>
                </CardHeader>
                <CardContent>
                  {topByDistance.isLoading ? (
                    <Skeleton className="h-[220px] w-full" />
                  ) : topByDistance.error ? (
                    <ErrorBanner error={topByDistance.error} />
                  ) : (
                    <TopPerformersChart data={topByDistance.data ?? []} metric="distance" />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Top by Sessions</CardTitle>
                </CardHeader>
                <CardContent>
                  {topBySessions.isLoading ? (
                    <Skeleton className="h-[220px] w-full" />
                  ) : topBySessions.error ? (
                    <ErrorBanner error={topBySessions.error} />
                  ) : (
                    <TopPerformersChart data={topBySessions.data ?? []} metric="sessions" />
                  )}
                </CardContent>
              </Card>
            </div>
          </FadeUp>

          {/* Leaderboard */}
          <FadeUp delay={0.15}>
            <AnalyticsLeaderboard from={from} to={to} />
          </FadeUp>
        </div>
      </RangeContent>
    </div>
  );
}
