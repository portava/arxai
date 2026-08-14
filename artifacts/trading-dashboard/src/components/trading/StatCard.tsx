import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { STATUS_COLORS, type StatusTone } from "@/lib/design-tokens";

interface Props {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: LucideIcon;
  tone?: StatusTone;
  loading?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function StatCard({ label, value, hint, icon: Icon, tone, loading, className, ...rest }: Props) {
  const accent = tone ? STATUS_COLORS[tone] : null;
  return (
    <Card className={cn("border-card-border", accent?.border, className)} data-testid={rest["data-testid"]}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
          {Icon && <Icon size={14} className={cn("text-muted-foreground", accent?.text)} />}
        </div>
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <div className={cn("text-2xl font-bold font-mono tabular-nums", accent?.text)}>{value}</div>
        )}
        {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
      </CardContent>
    </Card>
  );
}
