import React from "react";
import { AlertCircle } from "lucide-react";
import { Link } from "wouter";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatPnl } from "@/lib/format";
import { eaTooOldForCloseFill } from "@workspace/domain/safety-contracts/eaCloseFill";

export interface PnlCellProps {
  /** Trade id, used to build the stable testids. */
  id: number | string;
  /** "UNKNOWN" means the broker close-result lacked a trustworthy fill price. */
  pnlStatus?: string | null;
  /** Numeric P/L (only trusted when pnlStatus !== "UNKNOWN"). */
  pnl?: number | null;
  /** EA version that closed the trade (null/old EAs cannot report close fill). */
  reportedEaVersion?: string | null;
  /** Optional data-quality marker, shown only to operators. */
  dataQualityFlag?: string | null;
  /** Whether to surface operator-only diagnostic detail. */
  shouldShowAdminDiagnostics?: boolean;
}

/**
 * Pure, presentational P/L cell for the Trade Logs table.
 *
 * Extracted so the EA-upgrade nudge (testid `trade-ea-upgrade-hint-<id>`)
 * can be unit-rendered without standing up the whole page + React Query.
 * The upgrade nudge appears only when the trade's P/L is UNKNOWN *and* the
 * closing EA is too old to report a close fill (null / < v1.28).
 */
export function PnlCell({
  id,
  pnlStatus,
  pnl,
  reportedEaVersion,
  dataQualityFlag,
  shouldShowAdminDiagnostics = false,
}: PnlCellProps) {
  // pnlStatus="UNKNOWN" means the broker close-result did not include a
  // trustworthy fill price, so the numeric pnl (if any) cannot be
  // trusted. Show "P/L unavailable" instead of a fabricated number.
  if (pnlStatus === "UNKNOWN") {
    const cell = (
      <span className="inline-flex items-center gap-1 text-muted-foreground italic">
        <AlertCircle size={12} className="text-amber-500" />
        P/L unavailable
        {shouldShowAdminDiagnostics && dataQualityFlag ? (
          <span
            className="ml-1 rounded bg-amber-500/10 px-1 py-0.5 font-mono text-[10px] text-amber-500"
            data-testid={`trade-data-quality-flag-${id}`}
          >
            {dataQualityFlag}
          </span>
        ) : null}
      </span>
    );
    const showUpgradeHint = eaTooOldForCloseFill(reportedEaVersion);
    return (
      <div className="inline-flex flex-col items-end gap-1">
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{cell}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">
              The broker did not return a usable close fill price for this
              trade, so we won't show a profit/loss number we can't trust.
              This row is excluded from your totals and win-rate.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {showUpgradeHint && (
          <div
            className="text-[10px] leading-tight text-amber-500"
            data-testid={`trade-ea-upgrade-hint-${id}`}
          >
            EA too old to report close fill —{" "}
            <Link
              href="/mt5-setup"
              className="underline underline-offset-2 hover:text-amber-400"
            >
              upgrade to v1.28
            </Link>
            {shouldShowAdminDiagnostics && (
              <span className="ml-1 font-mono text-amber-500/70">
                (reported v{reportedEaVersion ?? "null"})
              </span>
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <span
      className={`font-mono font-bold ${
        (pnl || 0) > 0 ? "text-green-500" : (pnl || 0) < 0 ? "text-destructive" : ""
      }`}
    >
      {pnl != null ? formatPnl(pnl) : "-"}
    </span>
  );
}
