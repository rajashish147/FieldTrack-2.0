"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  LayoutDashboard,
  Clock,
  Receipt,
  BarChart3,
  Users,
  ClipboardList,
  Activity,
  UserCircle,
  Trophy,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile } from "@/hooks/queries/useProfile";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

// ─── Single animated nav row ──────────────────────────────────────────────────

function NavItemRow({ item, isActive }: { item: NavItem; isActive: boolean }) {
  return (
    <motion.div
      className="relative"
      whileHover={{ x: isActive ? 0 : 3 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
    >
      {/* Animated highlight pill — shared layoutId so it glides between items */}
      {isActive && (
        <motion.div
          layoutId="active-nav-bg"
          className="absolute inset-0 rounded-lg bg-primary/10 dark:bg-primary/15"
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
        />
      )}
      <Link
        href={item.href}
        className={cn(
          "relative z-10 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150",
          isActive
            ? "text-primary"
            : "text-muted-foreground hover:bg-accent hover:text-foreground"
        )}
      >
        <span className={cn("shrink-0", isActive ? "text-primary" : "")}>
          {item.icon}
        </span>
        {item.label}
      </Link>
    </motion.div>
  );
}

// ─── SidebarNav ───────────────────────────────────────────────────────────────

export function SidebarNav() {
  const pathname = usePathname();
  const { permissions } = useAuth();

  const commonItems: NavItem[] = [
    { href: "/dashboard", label: "Dashboard", icon: <LayoutDashboard className="h-4 w-4" /> },
    { href: "/leaderboard", label: "Leaderboard", icon: <Trophy className="h-4 w-4" /> },
    { href: "/sessions", label: "Sessions", icon: <Clock className="h-4 w-4" /> },
    { href: "/expenses", label: "Expenses", icon: <Receipt className="h-4 w-4" /> },
    { href: "/profile", label: "Profile", icon: <UserCircle className="h-4 w-4" /> },
  ];

  const adminItems: NavItem[] = [
    ...(permissions.viewOrgSessions
      ? [{ href: "/admin/sessions", label: "All Sessions", icon: <ClipboardList className="h-4 w-4" /> }]
      : []),
    ...(permissions.manageExpenses
      ? [{ href: "/admin/expenses", label: "Manage Expenses", icon: <Users className="h-4 w-4" /> }]
      : []),
    ...(permissions.viewAnalytics
      ? [
          { href: "/admin/analytics", label: "Analytics", icon: <BarChart3 className="h-4 w-4" /> },
          { href: "/admin/monitoring", label: "Monitoring", icon: <Activity className="h-4 w-4" /> },
        ]
      : []),
  ];

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  return (
    <nav className="flex flex-col gap-0.5 p-3">
      {commonItems.map((item) => (
        <NavItemRow key={item.href} item={item} isActive={isActive(item.href)} />
      ))}

      {adminItems.length > 0 && (
        <div className="mt-4">
          <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
            Administration
          </p>
          {adminItems.map((item) => (
            <NavItemRow key={item.href} item={item} isActive={isActive(item.href)} />
          ))}
        </div>
      )}
    </nav>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export function Sidebar() {
  const { user, role } = useAuth();
  const { data: profile } = useMyProfile();

  const displayName = profile?.name ?? user?.email?.split("@")[0] ?? "Account";
  const initials = displayName
    .split(" ")
    .slice(0, 2)
    .map((n: string) => n[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <aside className="hidden md:flex md:flex-col md:w-64 border-r border-border/60 bg-sidebar">
      {/* Logo */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-5 border-b border-border/60">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-violet-600 text-white shadow-sm">
          <Zap className="h-4 w-4" />
        </div>
        <span className="text-base font-bold tracking-tight">FieldTrack</span>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto py-2">
        <SidebarNav />
      </div>

      {/* Bottom mini profile */}
      <div className="shrink-0 border-t border-border/60 p-3">
        <div className="flex items-center gap-2.5 rounded-lg p-2.5 hover:bg-accent transition-colors cursor-default select-none">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-bold text-primary">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-none">{displayName.split(" ")[0]}</p>
            <p
              className={cn(
                "mt-0.5 text-[10px] font-semibold uppercase tracking-wide",
                role === "ADMIN" ? "text-amber-600 dark:text-amber-400" : "text-primary"
              )}
            >
              {role ?? "EMPLOYEE"}
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}
