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
  TooltipProps,
} from "recharts";
import { SessionTrendEntry } from "@/types";
import { EmptyState } from "@/components/EmptyState";
import { TrendingUp } from "lucide-react";

interface SessionTrendChartProps {
  data: SessionTrendEntry[];
}

function CustomTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-lg border bg-background p-3 shadow-md text-sm">
      <p className="mb-2 font-semibold text-foreground">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: p.color }}
          />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium">{p.value}</span>
        </div>
      ))}
    </div>
  );
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
    date: new Date(entry.date).toLocaleDateString("en-IN", {
      month: "short",
      day: "numeric",
    }),
    Sessions: entry.sessions,
    "Distance (km)": Math.round(entry.distance * 10) / 10,
    "Duration (hrs)": Number((entry.duration / 3600).toFixed(1)),
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          width={45}
          tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ stroke: "hsl(var(--muted-foreground))", strokeWidth: 1, strokeDasharray: "4 4" }} />
        <Legend
          wrapperStyle={{ fontSize: 12, paddingTop: 12, color: "hsl(var(--muted-foreground))" }}
          iconType="circle"
          iconSize={8}
        />
        <Line
          type="monotone"
          dataKey="Sessions"
          stroke="hsl(221.2 83.2% 53.3%)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 0 }}
          animationDuration={800}
        />
        <Line
          type="monotone"
          dataKey="Distance (km)"
          stroke="hsl(142.1 70.6% 45.3%)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 0 }}
          animationDuration={900}
        />
        <Line
          type="monotone"
          dataKey="Duration (hrs)"
          stroke="hsl(346.8 77.2% 49.8%)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 0 }}
          animationDuration={1000}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
