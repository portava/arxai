import * as React from "react";
import { AlertTriangle, Info, CheckCircle2, AlertCircle, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type CompactAlertTone = "info" | "success" | "warning" | "danger";

export interface CompactAlertProps {
  tone?: CompactAlertTone;
  title: React.ReactNode;
  /** Short one-liner. For longer text use the `details` slot. */
  description?: React.ReactNode;
  /** Expandable details so long warnings don't dominate the page. */
  details?: React.ReactNode;
  rightSlot?: React.ReactNode;
  className?: string;
  testId?: string;
}

const TONE_CLASS: Record<CompactAlertTone, string> = {
  info:    "border-blue-500/40 bg-blue-500/10 text-blue-300",
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  danger:  "border-rose-500/40 bg-rose-500/10 text-rose-300",
};

const TONE_ICON: Record<CompactAlertTone, React.ComponentType<{ className?: string }>> = {
  info:    Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger:  AlertCircle,
};

/**
 * Compact status row — replaces large duplicated warning blocks in normal
 * user flow. Long explanations live under "Details" so warnings don't
 * dominate every page (per the UI cleanup brief, section 7).
 */
export function CompactAlert(props: CompactAlertProps) {
  const { tone = "info", title, description, details, rightSlot, className, testId } = props;
  const Icon = TONE_ICON[tone];
  const [open, setOpen] = React.useState(false);
  return (
    <div
      className={cn("rounded-md border px-3 py-2 text-xs", TONE_CLASS[tone], className)}
      data-testid={testId}
    >
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium leading-tight">{title}</div>
          {description && <div className="opacity-80 truncate">{description}</div>}
        </div>
        {rightSlot}
        {details && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] opacity-80 hover:opacity-100"
            aria-expanded={open}
            data-testid={testId ? `${testId}-details-toggle` : undefined}
          >
            Details
            <ChevronDown className={cn("h-3 w-3 transition-transform", open ? "rotate-0" : "-rotate-90")} />
          </button>
        )}
      </div>
      {open && details && (
        <div className="mt-2 text-[11px] opacity-90" data-testid={testId ? `${testId}-details-body` : undefined}>
          {details}
        </div>
      )}
    </div>
  );
}
