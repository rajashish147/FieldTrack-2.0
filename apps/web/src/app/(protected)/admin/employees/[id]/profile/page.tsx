"use client";

import { useParams } from "next/navigation";
import { useEmployeeProfile } from "@/hooks/queries/useProfile";
import { useAuth } from "@/hooks/useAuth";
import { ErrorBanner } from "@/components/ErrorBanner";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { ProfileView } from "@/components/ProfileView";
import { redirect } from "next/navigation";

export default function AdminEmployeeProfilePage() {
  const { permissions } = useAuth();
  const params = useParams();
  const employeeId = params.id as string;

  if (!permissions.viewAnalytics) {
    redirect("/profile");
  }

  const { data, isLoading, error } = useEmployeeProfile(employeeId);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Employee Profile</h2>
        <p className="text-muted-foreground">Employee identity, performance, and activity status.</p>
      </div>

      {isLoading ? (
        <LoadingSkeleton variant="card" />
      ) : error ? (
        <ErrorBanner error={error} />
      ) : data ? (
        <ProfileView profile={data} />
      ) : null}
    </div>
  );
}
