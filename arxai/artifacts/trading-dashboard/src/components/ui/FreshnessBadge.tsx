// FreshnessBadge — compact, honest data-freshness indicator.
//
// Renders a small chip that communicates the staleness of live broker data
// so users are never misled into thinking stale numbers are current.
// Used by Dashboard (AccountSnapshotCard), Open Trades, and Ruby panel.
//
// RULES
//   - "Live" means ≤5s since the last broker snapshot.
//   - "Fresh" means ≤30s — still reliable.
//   - "Delayed" means ≤2m — broker snapshot is behind but still shown.
//   - "Stale" means >2m — last known value, clearly labelled.
//   - "Unavailable" — user is not in live mode or data cannot be fetched.
//   - Estimated values (mark-to-market computed) always show the ~tilde.
//   - Never hides a stale indicator; never lies about freshness.

import { cn } from "@/lib/utils";
import type { Freshness } from "@/hooks/useLiveAccountSnapshot";

interface FreshnessBadgeProps {
  freshness: Freshness;
  lastUpdatedMs?: number | null;
  isEstimate?: boolean;
  className?: string;
  /** Compact mode — just the dot + label, no "updated Xs ago" suffix. */
  compact?: boolean;
}

function ageLabel(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  const ageS = Math.floor((Date.now() - ms) / 1000);
  if (ageS < 5) return null; // "live" — no suffix needed
  if (ageS < 60) return `${ageS}s ago`;
  const m = Math.floor(ageS / 60);
  return `${m}m ago`;
}

const CONFIG: Record<
  Freshness,
  { dot: string; label: string; chip: string; dotPulse?: boolean }
> = {
  live: {
    dot: "bg-success",
    label: "Live",
    chip: "border-success/30 bg-success/10 text-success",
    dotPulse: true,
  },
  fresh: {
    dot: "bg-success",
    label: "Fresh",
    chip: "border-success/20 bg-success/[0.07] text-success/90",
  },
  delayed: {
    dot: "bg-warning",
    label: "Delayed",
    chip: "border-warning/30 bg-warning/10 text-warning",
  },
  stale: {
    dot: "bg-warning",
    label: "Stale",
    chip: "border-warning/30 bg-warning/[0.07] text-warning/80",
  },
  unavailable: {
    dot: "bg-txt-muted",
    label: "Unavailable",
    chip: "border-border bg-surface/60 text-txt-muted",
  },
};

export function FreshnessBadge({
  freshness,
  lastUpdatedMs,
  isEstimate,
  className,
  compact = false,
}: FreshnessBadgeProps) {
  const cfg = CONFIG[freshness];
  const age = compact ? null : ageLabel(lastUpdatedMs);
  const estimateMark = isEstimate ? "~" : "";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none",
        cfg.chip,
        className,
      )}
      title={
        freshness === "unavailable"
          ? "Broker data not available for this account mode."
          : freshness === "stale"
            ? "Last known value — broker snapshot is overdue."
            : freshness === "delayed"
              ? "Broker snapshot is a bit behind."
              : "Data is up to date."
      }
      aria-label={`Data freshness: ${cfg.label}`}
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
          cfg.dot,
          cfg.dotPulse && "animate-pulse",
        )}
        aria-hidden
      />
      <span>
        {estimateMark}{cfg.label}
        {age ? ` · ${age}` : ""}
      </span>
    </span>
  );
}
