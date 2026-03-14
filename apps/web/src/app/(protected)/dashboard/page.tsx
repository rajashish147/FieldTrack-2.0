"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/useAuth";
import { useOrgSummary, useSessionTrend, useLeaderboard } from "@/hooks/queries/useAnalytics";
import { useMyDashboard } from "@/hooks/queries/useDashboard";
import { useMyProfile } from "@/hooks/queries/useProfile";
import { MetricCard } from "@/components/MetricCard";
import { SessionTrendChart } from "@/components/charts/SessionTrendChart";
import { LeaderboardTable } from "@/components/charts/LeaderboardTable";
import { ErrorBanner } from "@/components/ErrorBanner";
import { StaggerList, StaggerItem, FadeUp } from "@/components/motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDistance, formatDuration, formatCurrency } from "@/lib/utils";
import { Activity, MapPin, Clock, Receipt, Users, TrendingUp, Trophy, Zap } from "lucide-react";
import Link from "next/link";
import type { OrgSummaryData, DashboardSummary, EmployeeProfileData } from "@/types";
import { EmployeeIdentity } from "@/components/EmployeeIdentity";

// ─── Helper ───────────────────────────────────────────────────────────────────

function getFirstName(name: string | undefined | null, email: string | undefined | null) {
  if (name) return name.split(" ")[0];
  if (email) return email.split("@")[0];
  return "there";
}

// ─── Admin Hero Card ──────────────────────────────────────────────────────────

function AdminHeroCard({
  summary,
  isLoading,
}: {
  summary?: OrgSummaryData;
  isLoading: boolean;
}) {
  const { user } = useAuth();
  const { data: profile } = useMyProfile();
  const firstName = getFirstName(profile?.name, user?.email);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-primary/90 to-violet-600 p-6 text-white shadow-lg shadow-primary/20"
    >
      {/* Decorative circles */}
      <div className="pointer-events-none absolute -right-12 -top-12 h-56 w-56 rounded-full bg-white/5" />
      <div className="pointer-events-none absolute right-24 -bottom-8 h-36 w-36 rounded-full bg-white/5" />

      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        {/* Left: greeting */}
        <div>
          <span className="inline-block rounded-full bg-white/15 px-3 py-0.5 text-xs font-semibold tracking-wider">
            ADMIN
          </span>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">
            Welcome back, {firstName} 👋
          </h2>
          <p className="mt-1 text-sm text-white/70">
            Here&apos;s what&apos;s happening with your field team.
          </p>
        </div>

        {/* Right: key stats */}
        <div className="flex shrink-0 items-center gap-6">
          {isLoading ? (
            <div className="flex gap-6">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 w-20 animate-pulse rounded-lg bg-white/10" />
              ))}
            </div>
          ) : (
            <>
              <div className="text-center">
                <p className="text-3xl font-extrabold tabular-nums">
                  {(summary?.activeEmployeesCount ?? 0)}
                </p>
                <p className="mt-0.5 text-xs font-medium text-white/60">Active now</p>
              </div>
              <div className="h-10 w-px bg-white/20" />
              <div className="text-center">
                <p className="text-3xl font-extrabold tabular-nums">
                  {(summary?.totalSessions ?? 0).toLocaleString()}
                </p>
                <p className="mt-0.5 text-xs font-medium text-white/60">Sessions</p>
              </div>
              <div className="h-10 w-px bg-white/20" />
              <div className="text-center">
                <p className="text-2xl font-extrabold">
                  {summary ? formatDistance(summary.totalDistanceKm) : "—"}
                </p>
                <p className="mt-0.5 text-xs font-medium text-white/60">Distance</p>
              </div>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Org metrics grid ─────────────────────────────────────────────────────────

function OrgSummarySection({ summary, isLoading }: { summary?: OrgSummaryData; isLoading: boolean }) {
  const cards = [
    {
      title: "Total Sessions",
      value: summary?.totalSessions.toLocaleString() ?? "—",
      numericValue: summary?.totalSessions,
      icon: <Activity className="h-4 w-4" />,
    },
    {
      title: "Total Distance",
      value: summary ? formatDistance(summary.totalDistanceKm) : "—",
      icon: <MapPin className="h-4 w-4" />,
    },
    {
      title: "Total Duration",
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
  ];

  return (
    <StaggerList className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
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

// ─── Activity status card ─────────────────────────────────────────────────────

function ActivityStatusCard({ summary }: { summary?: OrgSummaryData }) {
  if (!summary) {
    return (
      <Card className="h-full">
        <CardContent className="flex items-center justify-center p-6 min-h-[180px]">
          <div className="w-full space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-emerald-500" />
          Live Activity
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pb-5">
        {/* Active count with pulse */}
        <div className="flex items-center justify-between rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3.5">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </span>
            <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Active employees</span>
          </div>
          <span className="text-2xl font-extrabold tabular-nums text-emerald-700 dark:text-emerald-400">
            {summary.activeEmployeesCount}
          </span>
        </div>

        {/* Expense breakdown */}
        <div className="space-y-2.5 pt-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total expenses</span>
            <span className="font-semibold tabular-nums">{summary.totalExpenses.toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Approved</span>
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">
              {formatCurrency(summary.approvedExpenseAmount)}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Rejected</span>
            <span className="font-semibold text-rose-600 dark:text-rose-400">
              {formatCurrency(summary.rejectedExpenseAmount)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Admin leaderboard section ────────────────────────────────────────────────

type LeaderboardMetric = "distance" | "sessions" | "duration" | "expenses";

function AdminLeaderboardSection() {
  const [metric, setMetric] = useState<LeaderboardMetric>("distance");
  const { data, isLoading, error } = useLeaderboard(metric, 10);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="flex items-center gap-2">
          <Trophy className="h-5 w-5 text-amber-500" />
          Employee Leaderboard
        </CardTitle>
        <Tabs value={metric} onValueChange={(v) => setMetric(v as LeaderboardMetric)}>
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
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <LeaderboardTable data={data ?? []} metric={metric} isAdmin />
        )}
        <div className="mt-4 text-right">
          <Link href="/leaderboard" className="text-xs text-primary hover:underline">
            View full leaderboard →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Team Activity Widget ─────────────────────────────────────────────────────

function TeamActivityWidget() {
  const { data, isLoading } = useLeaderboard("sessions", 7);

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Zap className="h-4 w-4 text-primary" />
          Top Performers
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-4">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2.5 animate-pulse">
                <div className="h-8 w-8 rounded-full bg-muted shrink-0" />
                <div className="space-y-1.5 flex-1">
                  <div className="h-3 w-24 rounded bg-muted" />
                  <div className="h-2.5 w-14 rounded bg-muted" />
                </div>
                <div className="h-3 w-10 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2.5">
            {(data ?? []).map((entry, idx) => (
              <div
                key={entry.employeeId}
                className="flex items-center justify-between gap-2 rounded-lg hover:bg-accent/50 transition-colors px-1 py-0.5"
              >
                <EmployeeIdentity
                  employeeId={entry.employeeId}
                  name={entry.employeeName}
                  employeeCode={entry.employeeCode}
                  isAdmin
                  showTooltip={false}
                  size="sm"
                />
                <span className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
                  {entry.sessions}s
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Admin dashboard ──────────────────────────────────────────────────────────

function AdminDashboard() {
  const summary = useOrgSummary();
  const sessionTrend = useSessionTrend();

  return (
    <div className="space-y-5">
      {summary.error && <ErrorBanner error={summary.error} />}

      {/* Hero banner */}
      <AdminHeroCard summary={summary.data} isLoading={summary.isLoading} />

      {/* Metrics row */}
      <OrgSummarySection summary={summary.data} isLoading={summary.isLoading} />

      {/* Trend chart + Activity status */}
      <FadeUp delay={0.15}>
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card className="h-full">
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
          </div>
          <div className="flex flex-col gap-5">
            <ActivityStatusCard summary={summary.data} />
            <TeamActivityWidget />
          </div>
        </div>
      </FadeUp>

      {/* Leaderboard */}
      <FadeUp delay={0.25}>
        <AdminLeaderboardSection />
      </FadeUp>
    </div>
  );
}

// ─── Employee Hero Card ───────────────────────────────────────────────────────

function EmployeeHeroCard({
  profile,
  dashboard,
  rank,
  isLoading,
}: {
  profile?: EmployeeProfileData;
  dashboard?: DashboardSummary;
  rank?: number;
  isLoading: boolean;
}) {
  const initials = profile?.name
    ? profile.name
        .split(" ")
        .slice(0, 2)
        .map((n) => n[0])
        .join("")
        .toUpperCase()
    : "?";

  const statusLabel =
    profile?.activityStatus === "ACTIVE"
      ? "Active"
      : profile?.activityStatus === "RECENT"
      ? "Recently Active"
      : "Inactive";

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-cyan-500 p-6 text-white shadow-lg shadow-primary/20"
    >
      <div className="pointer-events-none absolute -right-10 -top-10 h-48 w-48 rounded-full bg-white/5" />

      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          {/* Avatar */}
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/20 text-xl font-bold shadow-inner">
            {isLoading ? "…" : initials}
          </div>
          <div>
            <span className="inline-block rounded-full bg-white/15 px-2.5 py-0.5 text-[10px] font-semibold tracking-wider">
              EMPLOYEE
            </span>
            <h2 className="mt-1 text-xl font-bold leading-tight">
              {isLoading ? (
                <span className="inline-block h-5 w-32 animate-pulse rounded bg-white/20" />
              ) : (
                profile?.name ?? "—"
              )}
            </h2>
            {/* Inline status indicator */}
            <div className="mt-1 flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                {profile?.activityStatus === "ACTIVE" && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                )}
                <span className="relative inline-flex h-2 w-2 rounded-full bg-white/70" />
              </span>
              <span className="text-xs text-white/80">{statusLabel}</span>
            </div>
          </div>
        </div>

        {/* Rank badge */}
        {rank != null && (
          <div className="flex shrink-0 items-center gap-2 rounded-xl bg-white/15 px-4 py-2.5 backdrop-blur">
            <Trophy className="h-5 w-5 text-amber-300" />
            <div>
              <p className="text-[10px] text-white/60 font-medium">Distance Rank</p>
              <p className="text-2xl font-extrabold leading-none">#{rank}</p>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Employee dashboard ────────────────────────────────────────────────────────

function EmployeeDashboard() {
  const { data: dashboard, isLoading: dashLoading, error: dashError } = useMyDashboard();
  const { data: profile, isLoading: profileLoading } = useMyProfile();
  const { data: leaderboard, isLoading: lbLoading } = useLeaderboard("distance", 10);

  const myRank = profile
    ? leaderboard?.find((e) => e.employeeId === profile.id)?.rank
    : undefined;

  const isLoading = dashLoading || profileLoading;

  if (dashError) return <ErrorBanner error={dashError} />;

  const stats = dashboard
    ? [
        {
          title: "Sessions This Week",
          value: dashboard.sessionsThisWeek.toLocaleString(),
          numericValue: dashboard.sessionsThisWeek,
          icon: <Activity className="h-4 w-4" />,
        },
        {
          title: "Distance This Week",
          value: formatDistance(dashboard.distanceThisWeek),
          icon: <MapPin className="h-4 w-4" />,
        },
        {
          title: "Hours Worked",
          value: `${dashboard.hoursThisWeek.toFixed(1)} hrs`,
          icon: <Clock className="h-4 w-4" />,
        },
        {
          title: "Expenses Submitted",
          value: dashboard.expensesSubmitted.toLocaleString(),
          numericValue: dashboard.expensesSubmitted,
          icon: <Receipt className="h-4 w-4" />,
        },
        {
          title: "Expenses Approved",
          value: dashboard.expensesApproved.toLocaleString(),
          numericValue: dashboard.expensesApproved,
          icon: <Receipt className="h-4 w-4" />,
          highlighted: true,
        },
      ]
    : [];

  return (
    <div className="space-y-5">
      {/* Hero card */}
      <EmployeeHeroCard
        profile={profile}
        dashboard={dashboard}
        rank={myRank}
        isLoading={isLoading}
      />

      {/* Weekly stats */}
      <StaggerList className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {stats.map((s) => (
          <StaggerItem key={s.title}>
            <MetricCard
              title={s.title}
              value={s.value}
              numericValue={s.numericValue}
              icon={s.icon}
              highlighted={s.highlighted}
              isLoading={isLoading}
            />
          </StaggerItem>
        ))}
      </StaggerList>

      {/* Leaderboard preview */}
      <FadeUp delay={0.2}>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Trophy className="h-4 w-4 text-amber-500" />
              Distance Leaderboard
            </CardTitle>
            <Link href="/leaderboard" className="text-xs text-primary hover:underline">
              Full leaderboard →
            </Link>
          </CardHeader>
          <CardContent>
            {lbLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (
              <LeaderboardTable
                data={(leaderboard ?? []).slice(0, 5)}
                metric="distance"
                highlightEmployeeId={profile?.id}
              />
            )}
          </CardContent>
        </Card>
      </FadeUp>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { permissions } = useAuth();
  return permissions.viewAnalytics ? <AdminDashboard /> : <EmployeeDashboard />;
}

