// Compact badge that explains, in plain language, whether the selected
// market is live-tradable through the connected MT5 bridge or
// analysis-only. Reads from /api/market-data/tradability so trade
// ticket, scanner card, and Ruby panel all agree.
import { Badge } from "@/components/ui/badge";
import { Info } from "lucide-react";
import { useTradability } from "@/lib/useTradability";

export function TradabilityBadge({
  symbol,
  showHelper = true,
  className,
}: {
  symbol: string;
  showHelper?: boolean;
  className?: string;
}) {
  const q = useTradability(symbol);
  const t = q.data;

  if (!t) {
    // No verdict yet — quiet placeholder, never leak provider/route names.
    return (
      <Badge variant="outline" className={`text-[10px] ${className ?? ""}`} data-testid="badge-tradability-loading">
        Checking tradability…
      </Badge>
    );
  }

  const tone =
    t.mt5Tradable === "yes" ? "bg-success/15 text-success border-success/40" :
    t.mt5Tradable === "no"  ? "bg-warning/15 text-warning border-warning/40" :
                              "bg-muted text-txt-secondary border-border/40";

  return (
    <div className={`flex flex-col gap-1 ${className ?? ""}`}>
      <Badge variant="outline" className={`text-[10px] w-fit ${tone}`} data-testid="badge-tradability">
        {t.badgeLabel}
      </Badge>
      {showHelper && (
        <div className="flex items-start gap-1 text-[11px] text-muted-foreground" data-testid="text-tradability-helper">
          <Info className="h-3 w-3 mt-[2px] shrink-0" />
          <span>{t.userMessage}</span>
        </div>
      )}
    </div>
  );
}
