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
    t.mt5Tradable === "yes" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" :
    t.mt5Tradable === "no"  ? "bg-amber-500/15 text-amber-300 border-amber-500/40" :
                              "bg-zinc-500/15 text-zinc-300 border-zinc-500/40";

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
