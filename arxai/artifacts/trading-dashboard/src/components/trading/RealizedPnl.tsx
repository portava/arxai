import { AlertCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PnLValue } from "@/components/trading/PnLValue";
import { useTradingMode } from "@/hooks/useTradingMode";

interface RealizedPnlTrade {
  id: number;
  pnl?: number | null;
  pnlStatus?: string | null;
  dataQualityFlag?: string | null;
}

interface Props {
  trade: RealizedPnlTrade;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

// Shared realized-P/L renderer. pnlStatus="UNKNOWN" means the broker
// close-result did not include a trustworthy fill price, so the numeric
// pnl (if any) cannot be trusted — show "P/L unavailable" instead of a
// fabricated number. Mirrors the renderPnlCell pattern on Trade Logs.
export function RealizedPnl({ trade, size = "md", className }: Props) {
  const { shouldShowAdminDiagnostics } = useTradingMode();

  if (trade.pnlStatus === "UNKNOWN") {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex items-center gap-1 text-xs italic text-muted-foreground"
              data-testid={`trade-pnl-unavailable-${trade.id}`}
            >
              <AlertCircle size={12} className="text-amber-500" />
              P/L unavailable
              {shouldShowAdminDiagnostics && trade.dataQualityFlag ? (
                <span
                  className="ml-1 rounded bg-amber-500/10 px-1 py-0.5 font-mono text-[10px] text-amber-500"
                  data-testid={`trade-data-quality-flag-${trade.id}`}
                >
                  {trade.dataQualityFlag}
                </span>
              ) : null}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs">
            The broker did not return a usable close fill price for this
            trade, so we won't show a profit/loss number we can't trust.
            This row is excluded from your totals and win-rate.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return <PnLValue value={trade.pnl} size={size} className={className} />;
}
