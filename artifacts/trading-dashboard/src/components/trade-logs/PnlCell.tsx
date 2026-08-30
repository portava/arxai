import React from "react";
import { AlertCircle } from "lucide-react";
import { Link } from "wouter";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatPnl } from "@/lib/format";
import { explainUnknownPnl } from "@workspace/domain/safety-contracts/eaCloseFill";

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
 * The upgrade nudge appears only when the trade's P/L is UNKNOWN, the close
 * came from a real BROKER, *and* the closing EA is too old to report a close
 * fill (null / < v1.28). A simulated close (dataQualityFlag
 * "SIMULATED_CLOSE_NO_PRICED_PNL") involved no EA and no broker, so it gets its
 * own explanation and never the upgrade nudge — see
 * `explainUnknownPnl` in @workspace/domain/safety-contracts/eaCloseFill.
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
        <AlertCircle size={12} className="text-warning" />
        P/L unavailable
        {shouldShowAdminDiagnostics && dataQualityFlag ? (
          <span
            className="ml-1 rounded bg-warning/10 px-1 py-0.5 font-mono text-[10px] text-warning"
            data-testid={`trade-data-quality-flag-${id}`}
          >
            {dataQualityFlag}
          </span>
        ) : null}
      </span>
    );
    // Which explanation this row gets is decided by the shared contract, not
    // inline here: a simulated close has no EA and no broker, so it must not
    // be told its EA is too old nor that "the broker did not return" anything.
    const explanation = explainUnknownPnl({ dataQualityFlag, reportedEaVersion });
    const showUpgradeHint = explanation.showEaUpgradeHint;
    return (
      <div className="inline-flex flex-col items-end gap-1">
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{cell}</span>
            </TooltipTrigger>
            <TooltipContent
              className="max-w-xs text-xs"
              data-testid={`trade-pnl-unknown-tooltip-${id}`}
            >
              {explanation.tooltip}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {showUpgradeHint && (
          <div
            className="text-[10px] leading-tight text-warning"
            data-testid={`trade-ea-upgrade-hint-${id}`}
          >
            EA too old to report close fill —{" "}
            <Link
              href="/mt5-setup"
              className="underline underline-offset-2 hover:text-warning"
            >
              upgrade to v1.28
            </Link>
            {shouldShowAdminDiagnostics && (
              <span className="ml-1 font-mono text-warning/70">
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
        (pnl || 0) > 0 ? "text-success" : (pnl || 0) < 0 ? "text-destructive" : ""
      }`}
    >
      {pnl != null ? formatPnl(pnl) : "-"}
    </span>
  );
}
