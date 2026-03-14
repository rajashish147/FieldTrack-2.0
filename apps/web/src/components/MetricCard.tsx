"use client";

import React from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useAnimatedNumber } from "@/hooks/useAnimatedNumber";

interface MetricCardProps {
  title: string;
  value: string | number;
  /** When provided the displayed value animates from 0 → this number. */
  numericValue?: number;
  icon: React.ReactNode;
  description?: string;
  trend?: { value: number; label: string };
  highlighted?: boolean;
  isLoading?: boolean;
  className?: string;
}

export function MetricCard({
  title,
  value,
  numericValue,
  icon,
  description,
  trend,
  highlighted = false,
  isLoading = false,
  className,
}: MetricCardProps) {
  const animated = useAnimatedNumber(numericValue ?? 0);
  const displayValue = numericValue !== undefined ? animated : value;

  if (isLoading) {
    return (
      <Card className={cn("relative overflow-hidden", className)}>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-8 rounded-lg" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-7 w-24 mb-1" />
          <Skeleton className="h-3 w-32" />
        </CardContent>
      </Card>
    );
  }

  return (
    <motion.div
      whileHover={{ y: -3, boxShadow: "0 8px 24px -4px rgba(0,0,0,0.12)" }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className={cn("rounded-xl", className)}
    >
      <Card
        className={cn(
          "relative overflow-hidden border transition-colors h-full",
          highlighted && "ring-2 ring-primary/25 bg-primary/5 dark:bg-primary/10"
        )}
      >
        <CardHeader className="flex flex-row items-center justify-between pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
          <motion.div
            whileHover={{ rotate: [0, -10, 10, 0], scale: 1.1 }}
            transition={{ duration: 0.4 }}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg",
              highlighted
                ? "bg-primary/10 text-primary"
                : "bg-muted/70 text-muted-foreground"
            )}
          >
            {icon}
          </motion.div>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div
            className={cn(
              "text-2xl font-bold tracking-tight tabular-nums",
              highlighted && "text-primary"
            )}
          >
            {displayValue}
          </div>
          {description && (
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          )}
          {trend && (
            <p
              className={cn(
                "mt-1 text-xs font-medium",
                trend.value >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
              )}
            >
              {trend.value >= 0 ? "↑" : "↓"}{" "}
              {Math.abs(trend.value)}% {trend.label}
            </p>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

interface MetricCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  description?: string;
  trend?: { value: number; label: string };
  highlighted?: boolean;
  isLoading?: boolean;
  className?: string;
}
