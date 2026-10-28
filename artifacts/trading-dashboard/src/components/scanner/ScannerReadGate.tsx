// ScannerReadGate — a single, honest downgrade notice for the advisory cards
// (Timing Intelligence, Ruby Market Read) shown beneath it (Task #391).
//
// It consumes the ONE shared scanner-truth contract. When the feed isn't valid
// for a live read (insufficient candles, stale, delayed, mismatch, or no data)
// it tells the user — in plain English — that the reads below are historical /
// limited, so a confident-looking analysis can never masquerade as live truth.
// Advisory only: it never blocks a gate or fabricates anything.

import { AlertTriangle } from "lucide-react";
import { CompactAlert, type CompactAlertTone } from "@/components/ui/CompactAlert";
import { cn } from "@/lib/utils";
import { useScannerReadGate } from "@/hooks/useScannerReadGate";

// When `compact` is set the gate renders as a single inline caption (for use
// INSIDE an advisory card header) instead of a full banner. Same shared truth,
// same downgrade decision — so a card can never present a confident read while
// the shared truth says the data is historical/limited/blocked.
export function ScannerReadGate({
  symbol,
  timeframe,
  compact = false,
}: {
  symbol: string;
  timeframe?: string;
  compact?: boolean;
}) {
  const { truth, level, isFull, reason } = useScannerReadGate(symbol, timeframe);
  if (isFull) return null;
  // A live read still waiting on the scanner's market analysis is confirming,
  // not a measured historical-only verdict.
  const pending = truth == null || truth.candles?.headerCapReason === "analysis_pending";

  const tone: CompactAlertTone =
    pending ? "info" : level === "blocked" ? "danger" : level === "limited" ? "info" : "warning";
  const title =
    pending ? "Confirming market data" : level === "blocked"
      ? "No live data — analysis unavailable"
      : level === "limited"
        ? "Delayed data — read with caution"
        : "Historical read only — not valid for a live entry";

  if (compact) {
    const toneCls =
      pending ? "text-blue-400" : level === "blocked"
        ? "text-rose-400"
        : level === "limited"
          ? "text-blue-400"
          : "text-amber-400";
    return (
      <div
        className={cn("flex items-start gap-1.5 text-[11px] leading-tight", toneCls)}
        data-testid="scanner-read-gate-compact"
      >
        <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
        <span>
          <span className="font-medium">{title}.</span>{" "}
          <span className="text-txt-muted">{reason}</span>
        </span>
      </div>
    );
  }

  return (
    <CompactAlert
      tone={tone}
      title={title}
      description={reason ?? undefined}
      testId="scanner-read-gate"
    />
  );
}
