// ── ARX EmptyState ──────────────────────────────────────────────────────────
// The one blessed empty-state pattern (DESIGN_SPEC.md §5): a muted icon in a
// soft well, a kind one-line title saying what will appear here, one sentence
// of guidance on how to get there, and at most one action. Never render a
// bare "No data" — use this instead.
//
// Usage:
//   <EmptyState
//     icon={Search}
//     title="No scans yet"
//     description="Run your first market scan and ranked opportunities will appear here."
//     action={<Button onClick={...}>Scan markets</Button>}
//   />
import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** A single, already-styled action (usually one <Button>). */
  action?: React.ReactNode;
  /** Tighter vertical padding for small cards / table bodies. */
  compact?: boolean;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-6" : "gap-3 px-6 py-10",
        className,
      )}
      {...props}
    >
      {Icon && (
        <div
          className={cn(
            "flex items-center justify-center rounded-full bg-muted/50 text-muted-foreground",
            compact ? "h-9 w-9" : "h-12 w-12",
          )}
          aria-hidden="true"
        >
          <Icon className={compact ? "h-4 w-4" : "h-5 w-5"} />
        </div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}
