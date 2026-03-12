"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OrgSummaryData } from "@/types";
import { formatDistance, formatDuration, formatCurrency } from "@/lib/utils";
import { Activity, MapPin, Clock, Users, DollarSign, TrendingUp } from "lucide-react";

interface SummaryCardsProps {
  summary: OrgSummaryData;
}

interface StatCardProps {
  title: string;
  value: string;
  icon: React.ReactNode;
  description?: string;
}

function StatCard({ title, value, icon, description }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className="text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function SummaryCards({ summary }: SummaryCardsProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <StatCard
        title="Total Sessions"
        value={summary.totalSessions.toLocaleString()}
        icon={<Activity className="h-4 w-4" />}
      />
      <StatCard
        title="Total Distance"
        value={formatDistance(summary.totalDistanceKm)}
        icon={<MapPin className="h-4 w-4" />}
      />
      <StatCard
        title="Total Duration"
        value={formatDuration(summary.totalDurationSeconds)}
        icon={<Clock className="h-4 w-4" />}
      />
      <StatCard
        title="Active Employees"
        value={summary.activeEmployeesCount.toLocaleString()}
        icon={<Users className="h-4 w-4" />}
      />
      <StatCard
        title="Approved Expenses"
        value={formatCurrency(summary.approvedExpenseAmount)}
        icon={<DollarSign className="h-4 w-4" />}
      />
      <StatCard
        title="Total Expenses"
        value={summary.totalExpenses.toLocaleString()}
        icon={<TrendingUp className="h-4 w-4" />}
        description={`${formatCurrency(summary.rejectedExpenseAmount)} rejected`}
      />
    </div>
  );
}
