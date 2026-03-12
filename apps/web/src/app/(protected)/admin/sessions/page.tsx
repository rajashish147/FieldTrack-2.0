"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { useOrgSessions } from "@/hooks/queries/useSessions";
import { SessionsTable } from "@/components/tables/SessionsTable";
import { ErrorBanner } from "@/components/ErrorBanner";
import type { ActivityStatus } from "@/types";

const PAGE_LIMIT = 20;

type FilterTab = "all" | ActivityStatus;

const TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "ACTIVE", label: "Active" },
  { key: "RECENT", label: "Recently Active" },
  { key: "INACTIVE", label: "Inactive" },
];

export default function AdminSessionsPage() {
  const { permissions } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!permissions.viewOrgSessions) {
      router.replace("/sessions");
    }
  }, [permissions, router]);

  const [page, setPage] = useState(1);
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const { data, isLoading, error } = useOrgSessions(page, PAGE_LIMIT);

  const allSessions = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const hasMore = page * PAGE_LIMIT < total;

  const sessions = useMemo(() => {
    if (activeTab === "all") return allSessions;
    return allSessions.filter((s) => s.activityStatus === activeTab);
  }, [allSessions, activeTab]);

  if (!permissions.viewOrgSessions) return null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">All Sessions</h2>
        <p className="text-muted-foreground">Organization-wide attendance sessions.</p>
      </div>

      {error && <ErrorBanner error={error} />}

      {/* Filter tabs */}
      <div className="flex gap-1 rounded-lg border bg-muted/40 p-1 w-fit">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => { setActiveTab(tab.key); setPage(1); }}
            className={[
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              activeTab === tab.key
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <SessionsTable
        sessions={sessions}
        isLoading={isLoading}
        page={page}
        hasMore={hasMore}
        onPageChange={setPage}
        showEmployee
      />
    </div>
  );
}
