import { AlertCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PnLValue } from "@/components/trading/PnLValue";
import { useTradingMode } from "@/hooks/useTradingMode";
import { explainUnknownPnl } from "@workspace/domain/safety-contracts/eaCloseFill";

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

// Shared realized-P/L renderer. pnlStatus="UNKNOWN" means no trustworthy
// P/L amount exists for the row, so the numeric pnl (if any) cannot be
// trusted — show "P/L unavailable" instead of a fabricated number. Mirrors
// the PnlCell pattern on Trade Logs, including WHY it is unavailable: a real
// broker close with a missing fill price and an in-app simulated close are
// different causes and must not be given each other's explanation.
export function RealizedPnl({ trade, size = "md", className }: Props) {
  const { shouldShowAdminDiagnostics } = useTradingMode();

  if (trade.pnlStatus === "UNKNOWN") {
    const explanation = explainUnknownPnl({ dataQualityFlag: trade.dataQualityFlag });
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex items-center gap-1 text-xs italic text-muted-foreground"
              data-testid={`trade-pnl-unavailable-${trade.id}`}
            >
              <AlertCircle size={12} className="text-warning" />
              P/L unavailable
              {shouldShowAdminDiagnostics && trade.dataQualityFlag ? (
                <span
                  className="ml-1 rounded bg-warning/10 px-1 py-0.5 font-mono text-[10px] text-warning"
                  data-testid={`trade-data-quality-flag-${trade.id}`}
                >
                  {trade.dataQualityFlag}
                </span>
              ) : null}
            </span>
          </TooltipTrigger>
          <TooltipContent
            className="max-w-xs text-xs"
            data-testid={`trade-pnl-unknown-tooltip-${trade.id}`}
          >
            {explanation.tooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return <PnLValue value={trade.pnl} size={size} className={className} />;
}
