"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { useAdminMap } from "@/hooks/queries/useDashboard";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MapPin, RefreshCw } from "lucide-react";
import type { EmployeeMapMarker } from "@/types";

// ─── Dynamic Leaflet import (SSR disabled — Leaflet uses `window`) ────────────

const EmployeeMap = dynamic(() => import("./EmployeeMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-96 items-center justify-center rounded-lg bg-muted text-muted-foreground">
      Loading map…
    </div>
  ),
});

// ─── Status badge helper ──────────────────────────────────────────────────────

const STATUS_VARIANTS: Record<
  EmployeeMapMarker["status"],
  "default" | "secondary" | "outline"
> = {
  ACTIVE: "default",
  RECENT: "secondary",
  INACTIVE: "outline",
};

function statusLabel(status: EmployeeMapMarker["status"]) {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MonitoringMapPage() {
  const { permissions } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!permissions.viewAnalytics) {
      router.replace("/sessions");
    }
  }, [permissions, router]);

  const { data: markers = [], isLoading, error, dataUpdatedAt, refetch } = useAdminMap();

  if (!permissions.viewAnalytics) return null;

  const activeCount = markers.filter((m) => m.status === "ACTIVE").length;
  const recentCount = markers.filter((m) => m.status === "RECENT").length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Live Employee Map</h1>
          <p className="text-sm text-muted-foreground">
            Showing latest GPS position per employee. Refreshes every 30 s.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {dataUpdatedAt
              ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}`
              : null}
          </span>
          <button
            onClick={() => void refetch()}
            className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary badges */}
      <div className="flex gap-2">
        <Badge variant="default">
          <MapPin className="mr-1 h-3 w-3" />
          {activeCount} Active
        </Badge>
        <Badge variant="secondary">{recentCount} Recent</Badge>
        <Badge variant="outline">{markers.length} Total on map</Badge>
      </div>

      {/* Error */}
      {error ? <ErrorBanner error={error as Error} /> : null}

      {/* Map */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Employee Positions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="h-[calc(100vh-22rem)] min-h-80 overflow-hidden rounded-b-lg">
            <EmployeeMap markers={markers} isLoading={isLoading} />
          </div>
        </CardContent>
      </Card>

      {/* Empty state */}
      {!isLoading && markers.length === 0 && !error ? (
        <p className="text-center text-sm text-muted-foreground">
          No employees with GPS data found. Markers appear after employees check in and record a
          location point.
        </p>
      ) : null}
    </div>
  );
}
