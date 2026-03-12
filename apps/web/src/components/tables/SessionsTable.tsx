"use client";

import { DataTable, type ColumnDef } from "@/components/tables/DataTable";
import { Badge } from "@/components/ui/badge";
import { AttendanceSession, ActivityStatus } from "@/types";
import { formatDate, formatTime, formatDistance, formatDuration } from "@/lib/utils";
import { Clock } from "lucide-react";

interface SessionsTableProps {
  sessions: AttendanceSession[];
  onRowClick?: (id: string) => void;
  isLoading: boolean;
  page?: number;
  hasMore?: boolean;
  onPageChange?: (page: number) => void;
  showEmployee?: boolean;
}

function ActivityBadge({ status }: { status: ActivityStatus | undefined }) {
  if (status === "ACTIVE")
    return <Badge className="bg-green-100 text-green-800 border-transparent">Active</Badge>;
  if (status === "RECENT")
    return <Badge className="bg-blue-100 text-blue-800 border-transparent">Recent</Badge>;
  if (status === "INACTIVE")
    return <Badge className="bg-gray-100 text-gray-600 border-transparent">Inactive</Badge>;
  return <Badge variant="outline">—</Badge>;
}

const baseColumns: ColumnDef<AttendanceSession>[] = [
  {
    key: "checkin_at",
    title: "Date",
    sortable: true,
    render: (s) => formatDate(s.checkin_at),
  },
  {
    key: "checkin_time",
    title: "Check-in",
    render: (s) => formatTime(s.checkin_at),
  },
  {
    key: "checkout_at",
    title: "Check-out",
    render: (s) => (s.checkout_at ? formatTime(s.checkout_at) : "\u2014"),
  },
  {
    key: "total_distance_km",
    title: "Distance",
    sortable: true,
    render: (s) => formatDistance(s.total_distance_km),
  },
  {
    key: "total_duration_seconds",
    title: "Duration",
    sortable: true,
    render: (s) => formatDuration(s.total_duration_seconds),
  },
  {
    key: "activityStatus",
    title: "Status",
    render: (s) => <ActivityBadge status={s.activityStatus} />,
  },
];

const employeeColumn: ColumnDef<AttendanceSession> = {
  key: "employee",
  title: "Employee",
  render: (s) => (
    <div className="flex flex-col">
      <span className="font-medium text-sm">
        {s.employee_name ?? `…${s.employee_id.slice(-4)}`}
      </span>
      {s.employee_code && (
        <span className="text-xs text-muted-foreground">{s.employee_code}</span>
      )}
    </div>
  ),
};

export function SessionsTable({
  sessions,
  onRowClick,
  isLoading,
  page,
  hasMore,
  onPageChange,
  showEmployee = false,
}: SessionsTableProps) {
  const columns = showEmployee
    ? [employeeColumn, ...baseColumns]
    : baseColumns;

  return (
    <DataTable
      columns={columns}
      data={sessions}
      rowKey={(s) => s.id}
      isLoading={isLoading}
      onRowClick={onRowClick ? (s) => onRowClick(s.id) : undefined}
      emptyIcon={Clock}
      emptyTitle="No sessions found"
      emptyDescription="Sessions will appear here once they are recorded."
      page={page}
      hasMore={hasMore}
      onPageChange={onPageChange}
    />
  );
}

