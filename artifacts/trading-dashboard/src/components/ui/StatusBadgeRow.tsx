import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type StatusPill = {
  id: string;
  label: string;
  value: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
  /** Optional legacy testid kept on the pill so older E2E selectors keep matching. */
  legacyTestId?: string;
};

export interface StatusBadgeRowProps {
  pills: StatusPill[];
  /** Detailed status content shown inside the drawer. */
  drawer?: React.ReactNode;
  className?: string;
  testId?: string;
}

const TONE_CLASS: Record<NonNullable<StatusPill["tone"]>, string> = {
  neutral: "bg-muted/60 text-txt-secondary border-border",
  success: "bg-success/10 text-success border-success/25",
  warning: "bg-warning/10 text-warning border-warning/25",
  danger:  "bg-danger/10 text-danger border-danger/25",
};

/**
 * Single compact status row — replaces multiple loud top badges. Tapping
 * the row opens a Sheet with detailed status so nothing is removed, only
 * collapsed (per the UI cleanup brief, section 6).
 */
export function StatusBadgeRow(props: StatusBadgeRowProps) {
  const { pills, drawer, className, testId } = props;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className={cn(
            "w-full flex flex-wrap items-center gap-1.5 rounded-lg border border-border/60 bg-card/40 px-2 py-1.5 text-left hover:bg-muted/40 transition-colors",
            className,
          )}
          data-testid={testId ?? "status-badge-row"}
          aria-label="Open detailed status"
        >
          {pills.map((p) => (
            <Badge
              key={p.id}
              variant="outline"
              className={cn("text-[11px] font-mono", TONE_CLASS[p.tone ?? "neutral"])}
              data-testid={`status-pill-${p.id}`}
              data-legacy-testid={p.legacyTestId}
            >
              <span className="opacity-70 mr-1">{p.label}:</span>
              {p.value}
            </Badge>
          ))}
          <span className="ml-auto text-[10px] text-muted-foreground hidden sm:inline">Tap for details →</span>
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[92vw] sm:w-[420px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>System status</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-3" data-testid="status-drawer-body">
          {drawer ?? (
            <p className="text-sm text-muted-foreground">No additional details.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
