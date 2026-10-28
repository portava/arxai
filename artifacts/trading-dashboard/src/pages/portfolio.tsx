import React from "react";
import { useGetPortfolioExposure, useGetCorrelationWarnings, getGetPortfolioExposureQueryKey, getGetCorrelationWarningsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Briefcase, AlertTriangle, TrendingDown } from "lucide-react";

const FALLBACK_SOURCE_NOTE =
  "From the legacy trades table only: simulated rows that no broker order stood behind. This table no longer records new trades. Your paper book (paper orders) and DEMO EA positions are not included. Broker positions are not included, so an empty view does not mean you have no open exposure.";

// Fixed client-side scope line, shown whatever the server note says (the
// client may only downgrade): every figure here comes from a frozen table of
// simulated rows, not from the trader's current paper book or EA positions.
const SCOPE_LINE =
  "Simulated rows from the legacy trades table, which no longer records new trades. Your current paper book, DEMO EA positions and broker positions are not shown here.";

export default function Portfolio() {
  const { data: exp, isLoading } = useGetPortfolioExposure({ query: { queryKey: getGetPortfolioExposureQueryKey(), refetchInterval: 10000 } });
  const { data: warns } = useGetCorrelationWarnings({ query: { queryKey: getGetCorrelationWarningsQueryKey(), refetchInterval: 10000 } });

  if (isLoading || !exp) return <Skeleton className="h-96 w-full" />;

  const renderBars = (label: string, data: Record<string, number> | undefined) => {
    const entries = Object.entries(data ?? {});
    if (entries.length === 0) return <p className="text-sm text-muted-foreground">No open rows in this source.</p>;
    const max = Math.max(...entries.map(([, v]) => Math.abs(v)));
    return (
      <div className="space-y-2">
        {entries.map(([k, v]) => (
          <div key={k}>
            <div className="flex justify-between text-xs font-mono mb-1"><span>{k}</span><span>{v.toFixed(2)} lots</span></div>
            <div className="h-2 rounded bg-muted overflow-hidden">
              <div className="h-full bg-primary" style={{ width: `${max ? (Math.abs(v) / max) * 100 : 0}%` }} />
            </div>
          </div>
        ))}
        <p className="sr-only">{label}</p>
      </div>
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Briefcase className="text-primary" /> Legacy Simulated Trades: Exposure
        </h2>
        <p className="text-muted-foreground" data-testid="portfolio-scope">{SCOPE_LINE}</p>
        {/* Scope first: these figures do not include broker positions, so an
            empty or quiet view is not an all-clear. Shown even if an older
            server omits the note (the client may only downgrade). */}
        <p className="mt-1 text-xs text-yellow-600" data-testid="portfolio-source-note">{exp.sourceNote ?? FALLBACK_SOURCE_NOTE}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Open legacy rows</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono">{exp.totalOpen}</div></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Simulated floating P&L</CardTitle></CardHeader><CardContent>
          {exp.floatingPnl == null ? (
            <>
              <div className="text-2xl font-bold font-mono text-muted-foreground" data-testid="floating-pnl">Unavailable</div>
              <div className="text-xs text-muted-foreground">{exp.floatingPnlUnavailableReason ?? "Open rows have no recorded P&L."}</div>
            </>
          ) : (
            <div className={`text-2xl font-bold font-mono ${exp.floatingPnl >= 0 ? "text-success" : "text-destructive"}`} data-testid="floating-pnl">${exp.floatingPnl.toFixed(2)}</div>
          )}
        </CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Simulated realized P&L</CardTitle></CardHeader><CardContent>
          <div className={`text-2xl font-bold font-mono ${exp.realizedPnl >= 0 ? "text-success" : "text-destructive"}`}>${exp.realizedPnl.toFixed(2)}</div>
          {(exp.realizedPnlExcludedUnknown ?? 0) > 0 ? (
            <div className="text-xs text-muted-foreground">{exp.realizedPnlExcludedUnknown} closed trade{exp.realizedPnlExcludedUnknown === 1 ? "" : "s"} excluded: P/L unknown</div>
          ) : null}
        </CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground flex items-center gap-1"><TrendingDown size={12}/>Simulated Net Loss, Last 24h</CardTitle></CardHeader><CardContent><div className={`text-2xl font-bold font-mono ${exp.dailyDrawdown < 0 ? "text-destructive" : ""}`} data-testid="daily-net-loss">${Math.abs(exp.dailyDrawdown).toFixed(2)}</div><div className="text-xs text-muted-foreground">Closed trades only; not a peak-to-trough drawdown.</div></CardContent></Card>
      </div>

      {warns && warns.length > 0 ? (
        <Card className="border-yellow-500/30 bg-yellow-500/5">
          <CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="text-yellow-500" size={18}/> Correlation Warnings</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {warns.map((w, i) => (
              <div key={i} className="flex items-start gap-2 text-sm" data-testid={`correlation-warning-${i}`}>
                <Badge variant="outline" className="text-xs">{w.group}</Badge>
                <span className="text-muted-foreground">{w.message}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader className="pb-3"><CardTitle className="text-base">Exposure by Market</CardTitle></CardHeader><CardContent>{renderBars("market", exp.exposureByMarket)}</CardContent></Card>
        <Card><CardHeader className="pb-3"><CardTitle className="text-base">Exposure by Strategy</CardTitle></CardHeader><CardContent>{renderBars("strategy", exp.exposureByStrategy)}</CardContent></Card>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Net Currency Exposure</CardTitle></CardHeader>
        <CardContent>
          {exp.exposureByCurrency.length === 0 ? <p className="text-sm text-muted-foreground">No open forex rows in this source.</p> :
            <div className="grid gap-2 sm:grid-cols-3">
              {exp.exposureByCurrency.map((c) => (
                <div key={c.currency} className="p-2 rounded border border-border/50 flex justify-between"><span className="font-mono font-bold">{c.currency}</span><span className={`font-mono ${c.netLots >= 0 ? "text-success" : "text-destructive"}`}>{c.netLots > 0 ? "+" : ""}{c.netLots.toFixed(2)}</span></div>
              ))}
            </div>
          }
        </CardContent>
      </Card>
    </div>
  );
}
