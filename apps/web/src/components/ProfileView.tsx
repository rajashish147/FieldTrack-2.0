"use client";

import { EmployeeProfileData, ActivityStatus } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDistance, formatDuration, formatDate } from "@/lib/utils";
import { User, Phone, Hash, Activity, MapPin, Clock, Receipt, CheckCircle } from "lucide-react";

interface ProfileViewProps {
  profile: EmployeeProfileData;
}

function activityBadgeVariant(status: ActivityStatus) {
  if (status === "ACTIVE") return "default";
  if (status === "RECENT") return "secondary";
  return "outline";
}

function activityLabel(status: ActivityStatus) {
  if (status === "ACTIVE") return "Active";
  if (status === "RECENT") return "Recently Active";
  return "Inactive";
}

export function ProfileView({ profile }: ProfileViewProps) {
  return (
    <div className="space-y-6">
      {/* Identity */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Identity
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-sm text-muted-foreground">Name</p>
            <p className="font-medium">{profile.name}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Employee Code</p>
            <p className="font-medium flex items-center gap-1">
              <Hash className="h-3 w-3" />
              {profile.employee_code ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Phone</p>
            <p className="font-medium flex items-center gap-1">
              <Phone className="h-3 w-3" />
              {profile.phone ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Status</p>
            <div className="flex items-center gap-2">
              <Badge variant={profile.is_active ? "default" : "outline"}>
                {profile.is_active ? "Active" : "Inactive"}
              </Badge>
            </div>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Member Since</p>
            <p className="font-medium">{formatDate(profile.created_at)}</p>
          </div>
        </CardContent>
      </Card>

      {/* Activity Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Activity Status
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <Badge variant={activityBadgeVariant(profile.activityStatus)}>
            {activityLabel(profile.activityStatus)}
          </Badge>
          {profile.last_activity_at && (
            <p className="text-sm text-muted-foreground">
              Last active: {formatDate(profile.last_activity_at)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Performance Metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Sessions</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{profile.stats.totalSessions.toLocaleString()}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Distance</CardTitle>
            <MapPin className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatDistance(profile.stats.totalDistanceKm)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Duration</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatDuration(profile.stats.totalDurationSeconds)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Expenses Submitted</CardTitle>
            <Receipt className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{profile.stats.expensesSubmitted.toLocaleString()}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Expenses Approved</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{profile.stats.expensesApproved.toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
