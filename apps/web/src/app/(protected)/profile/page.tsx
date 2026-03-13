"use client";

import { useMyProfile } from "@/hooks/queries/useProfile";
import { ErrorBanner } from "@/components/ErrorBanner";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { ProfileView } from "@/components/ProfileView";

export default function MyProfilePage() {
  const { data, isLoading, error } = useMyProfile();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">My Profile</h2>
        <p className="text-muted-foreground">Your identity, activity status, and performance metrics.</p>
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
