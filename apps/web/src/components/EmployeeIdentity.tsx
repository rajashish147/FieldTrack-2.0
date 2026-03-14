"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { ExternalLink, Clock, Receipt } from "lucide-react";
import { cn } from "@/lib/utils";
import { ActivityStatus } from "@/types";

// ─── Deterministic avatar gradient ───────────────────────────────────────────

const PALETTE = [
  "from-blue-500 to-indigo-600",
  "from-violet-500 to-purple-600",
  "from-emerald-500 to-teal-600",
  "from-rose-500 to-pink-600",
  "from-cyan-500 to-blue-600",
  "from-fuchsia-500 to-violet-600",
  "from-amber-500 to-orange-600",
  "from-green-500 to-emerald-600",
];

export function avatarGradient(name: string): string {
  const seed = name.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return PALETTE[seed % PALETTE.length];
}

export function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((n) => n[0] ?? "")
    .join("")
    .toUpperCase();
}

// ─── Presence dot ─────────────────────────────────────────────────────────────

function PresenceDot({ status }: { status: ActivityStatus }) {
  const base = "absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-background";
  if (status === "ACTIVE") {
    return (
      <span className={cn(base, "flex h-2.5 w-2.5")}>
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
      </span>
    );
  }
  if (status === "RECENT") {
    return <span className={cn(base, "h-2.5 w-2.5 bg-amber-400")} />;
  }
  return <span className={cn(base, "h-2.5 w-2.5 bg-slate-400 dark:bg-slate-500")} />;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface EmployeeIdentityProps {
  employeeId: string;
  name: string;
  employeeCode?: string | null;
  activityStatus?: ActivityStatus;
  /** Marks the logged-in user's own row */
  isCurrentUser?: boolean;
  /** Admins get click navigation + hover quick-actions */
  isAdmin?: boolean;
  size?: "sm" | "md";
  /** Show hover preview card (admin only) */
  showTooltip?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function EmployeeIdentity({
  employeeId,
  name,
  employeeCode,
  activityStatus,
  isCurrentUser,
  isAdmin,
  size = "sm",
  showTooltip = true,
}: EmployeeIdentityProps) {
  const [hovered, setHovered] = useState(false);

  const initials = getInitials(name);
  const gradient = avatarGradient(name);
  const avatarSizeCls = size === "sm" ? "h-8 w-8 text-[10px]" : "h-9 w-9 text-xs";
  const nameSizeCls = size === "sm" ? "text-sm" : "text-base";

  const href =
    isCurrentUser ? "/profile"
    : isAdmin ? `/admin/employees/${employeeId}/profile`
    : undefined;

  const AvatarEl = (
    <div className="relative shrink-0">
      <div
        className={cn(
          "flex items-center justify-center rounded-full",
          "bg-gradient-to-br text-white font-bold shadow-sm",
          avatarSizeCls,
          gradient
        )}
      >
        {initials}
      </div>
      {activityStatus && <PresenceDot status={activityStatus} />}
    </div>
  );

  const TextEl = (
    <div className="min-w-0">
      <p className={cn("font-semibold truncate leading-snug", nameSizeCls)}>
        {name}
        {isCurrentUser && (
          <span className="ml-1.5 text-xs text-primary font-normal">(you)</span>
        )}
      </p>
      {employeeCode && (
        <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">
          #{employeeCode}
        </p>
      )}
    </div>
  );

  // Core identity row — optionally wrapped in a link
  const coreContent = href ? (
    <Link
      href={href}
      className="flex items-center gap-2.5 min-w-0 hover:opacity-90 transition-opacity"
      onClick={(e) => e.stopPropagation()}
    >
      {AvatarEl}
      {TextEl}
    </Link>
  ) : (
    <div className="flex items-center gap-2.5 min-w-0">
      {AvatarEl}
      {TextEl}
    </div>
  );

  // Admin hover card
  if (showTooltip && isAdmin) {
    return (
      <div
        className="relative"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {coreContent}

        <AnimatePresence>
          {hovered && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 4 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className={cn(
                "absolute left-0 top-full z-50 mt-2",
                "w-52 rounded-xl border border-border/60",
                "bg-popover/95 backdrop-blur-sm shadow-xl shadow-black/15",
                "p-3"
              )}
            >
              {/* Header */}
              <div className="flex items-center gap-2.5 pb-2.5 mb-2.5 border-b border-border/50">
                <div
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                    "bg-gradient-to-br text-white text-xs font-bold shadow-sm",
                    gradient
                  )}
                >
                  {initials}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{name}</p>
                  {employeeCode && (
                    <p className="text-xs text-muted-foreground font-mono">
                      #{employeeCode}
                    </p>
                  )}
                </div>
              </div>

              {/* Activity status */}
              {activityStatus && (
                <div className="flex items-center gap-1.5 mb-2.5">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      activityStatus === "ACTIVE"
                        ? "bg-emerald-500"
                        : activityStatus === "RECENT"
                        ? "bg-amber-400"
                        : "bg-slate-400"
                    )}
                  />
                  <span className="text-xs text-muted-foreground">
                    {activityStatus === "ACTIVE"
                      ? "Active Today"
                      : activityStatus === "RECENT"
                      ? "Recently Active"
                      : "Inactive"}
                  </span>
                </div>
              )}

              {/* Quick actions */}
              <div className="space-y-0.5">
                <Link
                  href={`/admin/employees/${employeeId}/profile`}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  View Profile
                </Link>
                <Link
                  href={`/admin/sessions?employeeId=${employeeId}`}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Clock className="h-3 w-3 text-muted-foreground" />
                  View Sessions
                </Link>
                <Link
                  href={`/admin/expenses?employeeId=${employeeId}`}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Receipt className="h-3 w-3 text-muted-foreground" />
                  View Expenses
                </Link>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return coreContent;
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

export function EmployeeIdentitySkeleton({ size = "sm" }: { size?: "sm" | "md" }) {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className={cn(
          "rounded-full bg-muted animate-pulse shrink-0",
          size === "sm" ? "h-8 w-8" : "h-9 w-9"
        )}
      />
      <div className="space-y-1.5 flex-1">
        <div className="h-3.5 w-28 rounded bg-muted animate-pulse" />
        <div className="h-2.5 w-16 rounded bg-muted animate-pulse" />
      </div>
    </div>
  );
}
