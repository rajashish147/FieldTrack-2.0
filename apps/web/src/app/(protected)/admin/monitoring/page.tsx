"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import {
  useMonitoringHistory,
  useStartMonitoring,
  useStopMonitoring,
} from "@/hooks/queries/useMonitoring";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { formatDate, formatTime, formatDuration } from "@/lib/utils";
import { Play, Square, Activity } from "lucide-react";
import type { AdminSession } from "@/types";

const PAGE_LIMIT = 20;

function formatSessionDuration(session: AdminSession): string {
  if (!session.ended_at) return "Ongoing";
  const startMs = new Date(session.started_at).getTime();
  const endMs = new Date(session.ended_at).getTime();
  const seconds = Math.round((endMs - startMs) / 1000);
  return formatDuration(seconds);
}

export default function AdminMonitoringPage() {
  const { permissions } = useAuth();
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    if (!permissions.viewAnalytics) {
      router.replace("/sessions");
    }
  }, [permissions, router]);

  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useMonitoringHistory(page, PAGE_LIMIT);
  const startMonitoring = useStartMonitoring();
  const stopMonitoring = useStopMonitoring();

  const sessions = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const hasMore = page * PAGE_LIMIT < total;

  const activeSession = sessions.find((s) => !s.ended_at);

  if (!permissions.viewAnalytics) return null;

  function handleStart() {
    startMonitoring.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Monitoring started", description: "Location monitoring is now active." });
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Failed to start", description: err.message });
      },
    });
  }

  function handleStop() {
    stopMonitoring.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Monitoring stopped", description: "Location monitoring has been stopped." });
      },
      onError: (err) => {
        const msg = err.message.includes("404") ? "No active session to stop." : err.message;
        toast({ variant: "destructive", title: "Failed to stop", description: msg });
      },
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Monitoring</h2>
        <p className="text-muted-foreground">Control and review location monitoring sessions.</p>
      </div>

      {/* Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Monitoring Controls
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          {activeSession ? (
            <Badge variant="default" className="bg-green-600 hover:bg-green-700">
              Active since {formatTime(activeSession.started_at)}
            </Badge>
          ) : (
            <Badge variant="outline">Inactive</Badge>
          )}
          <Button
            onClick={handleStart}
            disabled={startMonitoring.isPending || !!activeSession}
            className="gap-2"
          >
            <Play className="h-4 w-4" />
            {startMonitoring.isPending ? "Starting..." : "Start Monitoring"}
          </Button>
          <Button
            variant="destructive"
            onClick={handleStop}
            disabled={stopMonitoring.isPending || !activeSession}
            className="gap-2"
          >
            <Square className="h-4 w-4" />
            {stopMonitoring.isPending ? "Stopping..." : "Stop Monitoring"}
          </Button>
        </CardContent>
      </Card>

      {/* History */}
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Session History</h3>

        {error && <ErrorBanner error={error} />}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No monitoring sessions yet.</p>
        ) : (
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Start Time</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">End Time</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Duration</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <div>{formatDate(session.started_at)}</div>
                      <div className="text-xs text-muted-foreground">{formatTime(session.started_at)}</div>
                    </td>
                    <td className="px-4 py-3">
                      {session.ended_at ? (
                        <>
                          <div>{formatDate(session.ended_at)}</div>
                          <div className="text-xs text-muted-foreground">{formatTime(session.ended_at)}</div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{formatSessionDuration(session)}</td>
                    <td className="px-4 py-3">
                      {session.ended_at ? (
                        <Badge variant="outline">Ended</Badge>
                      ) : (
                        <Badge variant="default" className="bg-green-600 hover:bg-green-700">Active</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(sessions.length > 0) && (
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">Page {page}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
