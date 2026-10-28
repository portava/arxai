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
  /** Null when the broker has not reported this position's P/L yet. */
  grossProfit: number | null;
  swap: number | null;
  commission: number | null;
  netProfit: number | null;
  profitPercentOfSlot: number | null;
  openedAt: string | null;
  lastUpdated: string | null;
  /** Server per-row freshness of the broker sync. */
  freshness?: "FRESH" | "STALE" | "MISSING";
  /** BROKER_CONFIRMATION_PENDING when the broker has not re-confirmed the row recently. */
  confirmation?: "BROKER_CONFIRMED" | "BROKER_CONFIRMATION_PENDING";
};

/** Pending / stale rows are shown, but their P/L is not presented as live. */
function rowPending(p: SlotPosition): boolean {
  return p.confirmation === "BROKER_CONFIRMATION_PENDING" || p.freshness === "STALE" || p.freshness === "MISSING";
}

function PendingMarker({ p }: { p: SlotPosition }) {
  if (!rowPending(p)) return null;
  return (
    <Badge variant="outline" className="text-amber-300 border-amber-500/40 text-[10px]" data-testid={`open-trade-pending-${p.brokerTicket ?? "x"}`}>
      {p.freshness === "MISSING" ? "Not yet synced" : "Stale"} · awaiting broker confirmation
    </Badge>
  );
}

function plText(p: SlotPosition, ccy: string): string {
  return p.grossProfit == null ? "Not reported" : fmtMoney(p.grossProfit, ccy);
}

type SlotSummary = {
  accountCurrency: string;
  positions: SlotPosition[];
  isLive: boolean;
  isStale: boolean;
  /** When the broker last reported this book (null = never). Not the response time. */
  lastUpdated: string | null;
};

function fmtMoney(v: number | null, ccy: string): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v < 0 ? "-" : v > 0 ? "+" : "";
  const abs = Math.abs(v);
  const body = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return ccy === "USD" ? `${sign}$${body}` : `${sign}${body} ${ccy}`;
}

function toneFor(v: number | null): string {
  if (v == null || !Number.isFinite(v) || v === 0) return "text-zinc-300";
  return v > 0 ? "text-emerald-400" : "text-rose-400";
}

export function LiveOpenTradesPanel() {
  const q = useQuery<SlotSummary>({
    queryKey: ["live", "slot-summary"],
    queryFn: () => fetch(`${BASE}/api/me/live/slot-summary`, { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 3000,
    refetchOnWindowFocus: false,
    staleTime: 1500,
  });

  const ccy = q.data?.accountCurrency ?? "USD";
  const positions = q.data?.positions ?? [];

  return (
    <Card data-testid="live-open-trades-panel">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Briefcase className="h-4 w-4" /> Open Trades
            <span className="text-xs text-muted-foreground font-normal">({positions.length})</span>
          </CardTitle>
          <CardDescription>Floating P/L per position as last reported by the broker (before swap and commission, which the broker does not report).</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {q.data?.isLive ? (
            <Badge className="bg-emerald-500/20 text-emerald-300 gap-1"><Wifi className="h-3 w-3" /> Live</Badge>
          ) : q.data?.isStale ? (
            <Badge variant="outline" className="text-amber-300 border-amber-500/40 gap-1"><AlertTriangle className="h-3 w-3" /> Stale</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground gap-1"><WifiOff className="h-3 w-3" /> Disconnected</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="text-sm text-muted-foreground py-4 text-center">Loading open trades…</div>
        ) : positions.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center" data-testid="open-trades-empty">
            No open trades right now.
          </div>
        ) : (
          <>
            {/* Mobile card list */}
            <div className="md:hidden space-y-3">
              {positions.map((p) => (
                <div key={`${p.brokerTicket}-mobile`} className="rounded-lg border border-zinc-800 p-3 space-y-2" data-testid={`open-trade-mobile-${p.brokerTicket ?? "x"}`}>
                  <div className="flex items-center justify-between">
                    <div className="font-mono font-semibold">{p.symbol}</div>
                    <Badge variant="outline">{p.direction}</Badge>
                  </div>
                  <PendingMarker p={p} />
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><span className="text-muted-foreground">Vol</span> {p.volume}</div>
                    <div><span className="text-muted-foreground">Entry</span> {p.entryPrice}</div>
                    <div><span className="text-muted-foreground">Current</span> {p.currentPrice ?? "—"}</div>
                    <div><span className="text-muted-foreground">SL/TP</span> {p.stopLoss ?? "—"} / {p.takeProfit ?? "—"}</div>
                  </div>
                  <div className="flex items-center justify-between border-t border-zinc-800 pt-2">
                    <div className="text-xs text-muted-foreground">Floating P/L</div>
                    <div className={`text-base font-semibold tabular-nums flex items-center gap-1 ${rowPending(p) ? "text-zinc-400" : toneFor(p.grossProfit)}`}>
                      {!rowPending(p) && p.grossProfit != null && p.grossProfit > 0 ? <TrendingUp className="h-3 w-3" /> : !rowPending(p) && p.grossProfit != null && p.grossProfit < 0 ? <TrendingDown className="h-3 w-3" /> : null}
                      {plText(p, ccy)}
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
                  <tr className="text-left text-xs text-muted-foreground border-b border-zinc-800">
                    <th className="py-2 pr-2">Symbol</th>
                    <th className="py-2 pr-2">Side</th>
                    <th className="py-2 pr-2 text-right">Vol</th>
                    <th className="py-2 pr-2 text-right">Entry</th>
                    <th className="py-2 pr-2 text-right">Current</th>
                    <th className="py-2 pr-2 text-right">SL / TP</th>
                    <th className="py-2 pr-2 text-right">Swap</th>
                    <th className="py-2 pr-2 text-right">Commission</th>
                    <th className="py-2 pr-2 text-right">Floating P/L</th>
                    <th className="py-2 pr-2 text-right">% of Slot</th>
                    <th className="py-2 pr-2 text-right">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.brokerTicket} className="border-b border-zinc-900" data-testid={`open-trade-${p.brokerTicket ?? "x"}`}>
                      <td className="py-2 pr-2 font-mono">{p.symbol} <PendingMarker p={p} /></td>
                      <td className="py-2 pr-2"><Badge variant="outline">{p.direction}</Badge></td>
                      <td className="py-2 pr-2 text-right tabular-nums">{p.volume}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{p.entryPrice}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{p.currentPrice ?? "—"}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-xs">{p.stopLoss ?? "—"} / {p.takeProfit ?? "—"}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-xs">{p.swap == null ? "—" : fmtMoney(p.swap, ccy)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-xs">{p.commission == null ? "—" : fmtMoney(p.commission, ccy)}</td>
                      <td className={`py-2 pr-2 text-right tabular-nums font-semibold ${rowPending(p) ? "text-zinc-400" : toneFor(p.grossProfit)}`} data-testid={`open-trade-pl-${p.brokerTicket ?? "x"}`}>{plText(p, ccy)}</td>
                      <td className={`py-2 pr-2 text-right tabular-nums ${rowPending(p) ? "text-zinc-400" : toneFor(p.profitPercentOfSlot)}`}>
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
        {q.data && (
          <div className="mt-3 text-[11px] text-muted-foreground" data-testid="open-trades-last-update">
            {q.data.lastUpdated
              ? <>Last broker update: {new Date(q.data.lastUpdated).toLocaleTimeString()}{q.data.isStale ? " (stale)" : ""}</>
              : "Last broker update: none received"}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
