"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { SessionTrendEntry } from "@/types";
import { EmptyState } from "@/components/EmptyState";
import { TrendingUp } from "lucide-react";

interface SessionTrendChartProps {
  data: SessionTrendEntry[];
}

export function SessionTrendChart({ data }: SessionTrendChartProps) {
  if (data.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No trend data"
        description="Session trend data will appear here once daily metrics are recorded."
      />
    );
  }

  const chartData = data.map((entry) => ({
    date: entry.date,
    Sessions: entry.sessions,
    "Distance (km)": Math.round(entry.distance * 100) / 100,
    "Duration (hrs)": Number((entry.duration / 3600).toFixed(1)),
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis dataKey="date" className="text-xs fill-muted-foreground" />
        <YAxis className="text-xs fill-muted-foreground" />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(var(--background))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "6px",
          }}
        />
        <Legend />
        <Line type="monotone" dataKey="Sessions" stroke="hsl(221.2 83.2% 53.3%)" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="Distance (km)" stroke="hsl(142.1 76.2% 36.3%)" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="Duration (hrs)" stroke="hsl(346.8 77.2% 49.8%)" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
