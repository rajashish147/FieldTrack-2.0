"use client";

import { useAuth } from "@/hooks/useAuth";
import { useOrgSummary, useTopPerformers } from "@/hooks/queries/useAnalytics";
import { useMyDashboard } from "@/hooks/queries/useDashboard";
import { SummaryCards } from "@/components/charts/SummaryCards";
import { TopPerformersChart } from "@/components/charts/TopPerformersChart";
import { ErrorBanner } from "@/components/ErrorBanner";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDistance } from "@/lib/utils";
import { Activity, MapPin, Clock, Receipt, CheckCircle } from "lucide-react";

function EmployeeDashboard() {
  const { data, isLoading, error } = useMyDashboard();

  if (isLoading) return <LoadingSkeleton variant="card" />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;

  const stats = [
    { title: "Sessions This Week", value: data.sessionsThisWeek.toLocaleString("en-IN"), icon: <Activity className="h-4 w-4" /> },
    { title: "Distance This Week", value: formatDistance(data.distanceThisWeek), icon: <MapPin className="h-4 w-4" /> },
    { title: "Hours Worked", value: `${data.hoursThisWeek.toFixed(1)} hrs`, icon: <Clock className="h-4 w-4" /> },
    { title: "Expenses Submitted", value: data.expensesSubmitted.toLocaleString("en-IN"), icon: <Receipt className="h-4 w-4" /> },
    { title: "Expenses Approved", value: data.expensesApproved.toLocaleString("en-IN"), icon: <CheckCircle className="h-4 w-4" /> },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {stats.map((s) => (
        <Card key={s.title}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{s.title}</CardTitle>
            <div className="text-muted-foreground">{s.icon}</div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{s.value}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function AdminDashboard() {
  const summary = useOrgSummary();
  const topByDistance = useTopPerformers("distance", 10);

  return (
    <>
      {summary.error && <ErrorBanner error={summary.error} />}

      {summary.isLoading ? (
        <LoadingSkeleton variant="card" />
      ) : summary.data ? (
        <SummaryCards summary={summary.data} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Top Performers by Distance</CardTitle>
        </CardHeader>
        <CardContent>
          {topByDistance.isLoading ? (
            <LoadingSkeleton variant="card" />
          ) : topByDistance.error ? (
            <ErrorBanner error={topByDistance.error} />
          ) : (
            <TopPerformersChart data={topByDistance.data ?? []} metric="distance" />
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default function DashboardPage() {
  const { permissions } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
        <p className="text-muted-foreground">
          {permissions.viewAnalytics
            ? "Organization overview and key metrics."
            : "Your personal activity summary."}
        </p>
      </div>

      {permissions.viewAnalytics ? <AdminDashboard /> : <EmployeeDashboard />}
    </div>
  );
}
