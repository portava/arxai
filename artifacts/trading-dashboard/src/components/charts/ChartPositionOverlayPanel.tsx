import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Layers, ShieldAlert } from "lucide-react";
import type {
  ChartPosition,
  UseLivePositionOverlaysResult,
} from "@/hooks/useLivePositionOverlays";

// ChartPositionOverlayPanel — Level 4 legend + gated close for the overlays
// drawn on ARXNativeChart. It is a thin presentation layer over
// useLivePositionOverlays: it NEVER executes a trade itself. The Close button
// calls the hook's `closePosition`, which routes through the existing gated
// executeInstantTrade(source:"chart") path (all server gates re-run).
//
// Renders nothing when there are no open positions on the symbol, so a clean
// no-position chart stays clean.

interface ChartPositionOverlayPanelProps {
  symbol: string;
  data: UseLivePositionOverlaysResult;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const decimals = abs < 10 ? 5 : abs < 1000 ? 3 : 2;
  return n.toFixed(decimals);
}

export function ChartPositionOverlayPanel({
  symbol,
  data,
}: ChartPositionOverlayPanelProps) {
  const { positions, canTrade, busyTicket, noTradeReason, closePosition } = data;

  // Clean no-position state: render nothing at all.
  if (positions.length === 0) return null;

  return (
    <Card className="border-border bg-background/40" data-testid="chart-position-overlay-panel">
      <CardHeader className="py-3 px-3 md:px-4">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-primary" />
            Open on {symbol}
          </span>
          <Badge variant="outline" className="text-[10px]">
            {positions.length} position{positions.length === 1 ? "" : "s"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-3 md:p-4 pt-0">
        {positions.map((p: ChartPosition, i) => {
          const key = p.brokerTicket ?? `${p.accountMode}-${i}`;
          const pnl = p.floatingPnl;
          const pnlClass =
            pnl == null
              ? "text-muted-foreground"
              : pnl >= 0
                ? "text-success"
                : "text-danger";
          const busy = busyTicket != null && busyTicket === p.brokerTicket;
          return (
            <div
              key={key}
              data-testid="chart-position-row"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge
                  variant="outline"
                  className={`text-[10px] ${
                    p.side === "BUY"
                      ? "border-primary/25 text-primary"
                      : "border-premium/25 text-premium"
                  }`}
                >
                  {p.side ?? "—"}
                </Badge>
                <Badge variant="outline" className="text-[10px] uppercase text-muted-foreground">
                  {p.accountMode}
                </Badge>
                <span className="font-mono text-txt-secondary">
                  {p.lotSize != null ? `${p.lotSize} lot` : ""}
                </span>
                <span className="font-mono text-muted-foreground">
                  @ {fmtPrice(p.entryPrice)}
                </span>
                {p.stopLoss != null && (
                  <span className="font-mono text-danger/80">SL {fmtPrice(p.stopLoss)}</span>
                )}
                {p.takeProfit != null && (
                  <span className="font-mono text-success/80">TP {fmtPrice(p.takeProfit)}</span>
                )}
                <span className={`font-mono font-semibold ${pnlClass}`} data-testid="chart-position-pnl">
                  {pnl == null ? "P/L —" : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`}
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={!canTrade || busy || !p.brokerTicket}
                onClick={() => void closePosition(p)}
                data-testid="chart-position-close"
                title={!canTrade ? noTradeReason ?? undefined : "Close via the gated trade router"}
              >
                {busy ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Closing…
                  </>
                ) : (
                  "Close"
                )}
              </Button>
            </div>
          );
        })}

        {!canTrade && noTradeReason && (
          <p
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            data-testid="chart-position-no-trade"
          >
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
            {noTradeReason}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
