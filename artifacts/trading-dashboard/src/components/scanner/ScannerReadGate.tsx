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
import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import { useScannerTruth } from "@/hooks/useScannerTruth";

// When `compact` is set the gate renders as a single inline caption (for use
// INSIDE an advisory card header) instead of a full banner. Same shared truth,
// same downgrade decision — so a card can never present a confident read while
// the shared truth says the data is historical/limited/blocked.
export function ScannerReadGate({
  symbol,
  compact = false,
}: {
  symbol: string;
  compact?: boolean;
}) {
  const [timeframe] = useScannerTimeframe();
  const { truth } = useScannerTruth(symbol, timeframe);
  if (!truth) return null;

  const level = truth.analysis.level;
  if (level === "full") return null;

  const tone: CompactAlertTone =
    level === "blocked" ? "danger" : level === "limited" ? "info" : "warning";
  const title =
    level === "blocked"
      ? "No live data — analysis unavailable"
      : level === "limited"
        ? "Delayed data — read with caution"
        : "Historical read only — not valid for a live entry";

  if (compact) {
    const toneCls =
      level === "blocked"
        ? "text-danger"
        : level === "limited"
          ? "text-primary"
          : "text-warning";
    return (
      <div
        className={cn("flex items-start gap-1.5 text-[11px] leading-tight", toneCls)}
        data-testid="scanner-read-gate-compact"
      >
        <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
        <span>
          <span className="font-medium">{title}.</span>{" "}
          <span className="text-txt-muted">{truth.analysis.reason}</span>
        </span>
      </div>
    );
  }

  return (
    <CompactAlert
      tone={tone}
      title={title}
      description={truth.analysis.reason}
      testId="scanner-read-gate"
    />
  );
}
