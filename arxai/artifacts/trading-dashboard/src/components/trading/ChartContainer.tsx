import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "./EmptyState";
import { cn } from "@/lib/utils";
import { BarChart2, type LucideIcon } from "lucide-react";

interface Props {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  loading?: boolean;
  empty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyIcon?: LucideIcon;
  height?: number | string;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function ChartContainer({
  title, description, icon: Icon, loading, empty, emptyTitle, emptyDescription, emptyIcon,
  height = 280, actions, className, children,
}: Props) {
  return (
    <Card className={cn("border-card-border", className)}>
      {(title ?? actions) && (
        <CardHeader className="pb-3 border-b border-border flex flex-row items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2">
              {Icon && <Icon size={14} className="text-primary" />}
              {title}
            </CardTitle>
            {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
          </div>
          {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
        </CardHeader>
      )}
      <CardContent className="p-3">
        <div className="w-full" style={{ height }}>
          {loading ? (
            <Skeleton className="w-full h-full" />
          ) : empty ? (
            <EmptyState
              icon={emptyIcon ?? BarChart2}
              title={emptyTitle ?? "No data"}
              description={emptyDescription ?? "Data will appear here once available."}
              className="h-full"
            />
          ) : (
            children
          )}
        </div>
      </CardContent>
    </Card>
  );
}
