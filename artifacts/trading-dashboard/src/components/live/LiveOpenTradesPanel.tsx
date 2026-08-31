import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Briefcase, TrendingUp, TrendingDown, Wifi, WifiOff, AlertTriangle } from "lucide-react";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type SlotPosition = {
  brokerTicket: string | null;
  symbol: string;
  direction: string;
  volume: number;
  entryPrice: number;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  // null = this position's P/L has never synced from the broker — rendered as
  // "—" via fmtMoney/toneFor, never as a confident "0.00".
  grossProfit: number | null;
  swap: number | null;
  commission: number | null;
  netProfit: number | null;
  profitPercentOfSlot: number | null;
  openedAt: string | null;
  lastUpdated: string | null;
};

type SlotSummary = {
  accountCurrency: string;
  positions: SlotPosition[];
  isLive: boolean;
  isStale: boolean;
  lastUpdated: string;
};

function fmtMoney(v: number | null, ccy: string): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v < 0 ? "-" : v > 0 ? "+" : "";
  const abs = Math.abs(v);
  const body = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return ccy === "USD" ? `${sign}$${body}` : `${sign}${body} ${ccy}`;
}

function toneFor(v: number | null): string {
  if (v == null || !Number.isFinite(v) || v === 0) return "text-txt-secondary";
  return v > 0 ? "text-success" : "text-danger";
}

export function LiveOpenTradesPanel() {
  const q = useQuery<SlotSummary>({
    queryKey: ["live", "slot-summary"],
    // P0-3 pattern (see OpenLivePositions) — a non-OK response MUST throw.
    // `.then(r => r.json())` with no r.ok check let a 500/401 error body
    // collapse to positions=[] and render "No open trades right now." — a
    // failed read presented as "you are flat" on a real-money surface.
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/me/live/slot-summary`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 3000,
    refetchOnWindowFocus: false,
    staleTime: 1500,
  });

  const ccy = q.data?.accountCurrency ?? "USD";
  const positions = q.data?.positions ?? [];
  const countKnown = !q.isLoading && !q.isError && q.data != null;

  return (
    <Card data-testid="live-open-trades-panel">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Briefcase className="h-4 w-4" /> Open Trades
            <span className="text-xs text-muted-foreground font-normal">
              {countKnown ? `(${positions.length})` : "(count unavailable)"}
            </span>
          </CardTitle>
          <CardDescription>Live floating P/L per position, refreshed every 3 seconds.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {q.data?.isLive ? (
            <Badge className="bg-success/20 text-success gap-1"><Wifi className="h-3 w-3" /> Live</Badge>
          ) : q.data?.isStale ? (
            <Badge variant="outline" className="text-warning border-warning/40 gap-1"><AlertTriangle className="h-3 w-3" /> Stale</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground gap-1"><WifiOff className="h-3 w-3" /> Disconnected</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="text-sm text-muted-foreground py-4 text-center" data-testid="open-trades-loading">Loading open trades…</div>
        ) : q.isError ? (
          // Failed read ≠ flat. Mirror OpenLivePositions' P0-3 error state:
          // warn against the "I am flat" reading and offer a retry.
          <div
            className="flex flex-col items-center gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-4 text-center"
            role="alert"
            data-testid="open-trades-error"
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-warning">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Couldn&apos;t load open trades — retrying. Do not assume you are flat.
            </div>
            <div className="text-xs text-warning/80">
              Your broker may still hold open positions. Check MT5 directly before placing or closing anything.
            </div>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
              onClick={() => void q.refetch()}
              disabled={q.isFetching}
              data-testid="btn-retry-open-trades"
            >
              {q.isFetching ? "Retrying…" : "Retry"}
            </button>
          </div>
        ) : positions.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center" data-testid="open-trades-empty">
            No open trades right now.
          </div>
        ) : (
          <>
            {/* Mobile card list */}
            <div className="md:hidden space-y-3">
              {positions.map((p) => (
                <div key={`${p.brokerTicket}-mobile`} className="rounded-lg border border-border p-3 space-y-2" data-testid={`open-trade-mobile-${p.brokerTicket ?? "x"}`}>
                  <div className="flex items-center justify-between">
                    <div className="font-mono font-semibold">{p.symbol}</div>
                    <Badge variant="outline">{p.direction}</Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><span className="text-muted-foreground">Vol</span> {p.volume}</div>
                    <div><span className="text-muted-foreground">Entry</span> {p.entryPrice}</div>
                    <div><span className="text-muted-foreground">Current</span> {p.currentPrice ?? "—"}</div>
                    <div><span className="text-muted-foreground">SL/TP</span> {p.stopLoss ?? "—"} / {p.takeProfit ?? "—"}</div>
                  </div>
                  <div className="flex items-center justify-between border-t border-border pt-2">
                    <div className="text-xs text-muted-foreground">Current P/L</div>
                    <div className={`text-base font-semibold tabular-nums flex items-center gap-1 ${toneFor(p.netProfit)}`}>
                      {p.netProfit != null && p.netProfit > 0 ? <TrendingUp className="h-3 w-3" /> : p.netProfit != null && p.netProfit < 0 ? <TrendingDown className="h-3 w-3" /> : null}
                      {fmtMoney(p.netProfit, ccy)}
                      {p.profitPercentOfSlot != null && (
                        <span className="text-xs text-muted-foreground ml-1">({p.profitPercentOfSlot >= 0 ? "+" : ""}{p.profitPercentOfSlot.toFixed(2)}%)</span>
                      )}
                    </div>
                  </div>
                  {(p.swap != null || p.commission != null) && (
                    <div className="text-[11px] text-muted-foreground flex gap-3">
                      {p.swap != null && <span>Swap {fmtMoney(p.swap, ccy)}</span>}
                      {p.commission != null && <span>Commission {fmtMoney(p.commission, ccy)}</span>}
                    </div>
                  )}
                  {p.lastUpdated && (
                    <div className="text-[10px] text-muted-foreground">Updated {new Date(p.lastUpdated).toLocaleTimeString()}</div>
                  )}
                </div>
              ))}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="py-2 pr-2">Symbol</th>
                    <th className="py-2 pr-2">Side</th>
                    <th className="py-2 pr-2 text-right">Vol</th>
                    <th className="py-2 pr-2 text-right">Entry</th>
                    <th className="py-2 pr-2 text-right">Current</th>
                    <th className="py-2 pr-2 text-right">SL / TP</th>
                    <th className="py-2 pr-2 text-right">Swap</th>
                    <th className="py-2 pr-2 text-right">Commission</th>
                    <th className="py-2 pr-2 text-right">Net P/L</th>
                    <th className="py-2 pr-2 text-right">% of Slot</th>
                    <th className="py-2 pr-2 text-right">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.brokerTicket} className="border-b border-border" data-testid={`open-trade-${p.brokerTicket ?? "x"}`}>
                      <td className="py-2 pr-2 font-mono">{p.symbol}</td>
                      <td className="py-2 pr-2"><Badge variant="outline">{p.direction}</Badge></td>
                      <td className="py-2 pr-2 text-right tabular-nums">{p.volume}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{p.entryPrice}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{p.currentPrice ?? "—"}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-xs">{p.stopLoss ?? "—"} / {p.takeProfit ?? "—"}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-xs">{p.swap == null ? "—" : fmtMoney(p.swap, ccy)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-xs">{p.commission == null ? "—" : fmtMoney(p.commission, ccy)}</td>
                      <td className={`py-2 pr-2 text-right tabular-nums font-semibold ${toneFor(p.netProfit)}`}>{fmtMoney(p.netProfit, ccy)}</td>
                      <td className={`py-2 pr-2 text-right tabular-nums ${toneFor(p.profitPercentOfSlot)}`}>
                        {p.profitPercentOfSlot == null ? "—" : `${p.profitPercentOfSlot >= 0 ? "+" : ""}${p.profitPercentOfSlot.toFixed(2)}%`}
                      </td>
                      <td className="py-2 pr-2 text-right text-[11px] text-muted-foreground">
                        {p.lastUpdated ? new Date(p.lastUpdated).toLocaleTimeString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {q.data?.lastUpdated && (
          <div className="mt-3 text-[11px] text-muted-foreground">
            Last refresh: {new Date(q.data.lastUpdated).toLocaleTimeString()}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
