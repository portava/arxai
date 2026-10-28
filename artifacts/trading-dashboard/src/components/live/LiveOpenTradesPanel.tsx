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
  // null = the bridge has not reported this position's floating P/L
  // (unknown, never shown as $0.00).
  grossProfit: number | null;
  swap: number | null;
  commission: number | null;
  netProfit: number | null;
  profitPercentOfSlot: number | null;
  openedAt: string | null;
  lastUpdated: string | null;
  freshness?: "FRESH" | "STALE" | "MISSING";
  confirmation?: "BROKER_CONFIRMED" | "BROKER_CONFIRMATION_PENDING";
};

type SlotSummary = {
  accountCurrency: string;
  positions: SlotPosition[];
  isLive: boolean;
  isStale: boolean;
  // Position-snapshot reliability is separate from the bridge heartbeat: a
  // fresh heartbeat with an old/missing positions sweep is NOT a live book.
  positionSyncIncomplete?: boolean;
  snapshotWarning?: string | null;
  lastUpdated: string;
};

// A row is confirmed only when the server says the broker re-confirmed it in a
// fresh snapshot. Missing fields (older server) are treated as unconfirmed.
function rowConfirmed(p: SlotPosition): boolean {
  return p.freshness === "FRESH" && p.confirmation === "BROKER_CONFIRMED";
}

function rowPendingNote(p: SlotPosition): string {
  const seen = p.lastUpdated ? new Date(p.lastUpdated).toLocaleTimeString() : null;
  return seen
    ? `Broker confirmation pending — last reported by the bridge at ${seen}`
    : "Broker confirmation pending — the bridge has not reported this position yet";
}

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
  const syncIncomplete = q.data?.positionSyncIncomplete === true;
  // "Live" requires BOTH a fresh bridge heartbeat AND a reliable positions
  // snapshot; the client may only downgrade the server's isLive.
  const bookLive = q.data?.isLive === true && !syncIncomplete;

  return (
    <Card data-testid="live-open-trades-panel">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Briefcase className="h-4 w-4" /> Open Trades
            <span className="text-xs text-muted-foreground font-normal">({positions.length})</span>
          </CardTitle>
          <CardDescription>
            Floating P/L per position as last reported by your MT5 bridge, checked every 3 seconds.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {bookLive ? (
            <Badge className="bg-emerald-500/20 text-emerald-300 gap-1" data-testid="open-trades-badge-live"><Wifi className="h-3 w-3" /> Live</Badge>
          ) : q.data?.isLive && syncIncomplete ? (
            <Badge
              variant="outline"
              className="text-sky-300 border-sky-500/40 gap-1"
              data-testid="open-trades-badge-sync-pending"
              title="Bridge heartbeat is fresh, but no recent complete positions snapshot has arrived."
            >
              <AlertTriangle className="h-3 w-3" /> Sync pending
            </Badge>
          ) : q.data?.isStale ? (
            <Badge variant="outline" className="text-amber-300 border-amber-500/40 gap-1"><AlertTriangle className="h-3 w-3" /> Stale</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground gap-1"><WifiOff className="h-3 w-3" /> Disconnected</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {syncIncomplete && (
          <div className="mb-3 text-[11px] text-sky-300/90 flex items-start gap-1" data-testid="open-trades-sync-incomplete">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>{q.data?.snapshotWarning ?? "Position sync incomplete — waiting for broker confirmation."}</span>
          </div>
        )}
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
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><span className="text-muted-foreground">Vol</span> {p.volume}</div>
                    <div><span className="text-muted-foreground">Entry</span> {p.entryPrice}</div>
                    <div><span className="text-muted-foreground">Current</span> {p.currentPrice ?? "—"}</div>
                    <div><span className="text-muted-foreground">SL/TP</span> {p.stopLoss ?? "—"} / {p.takeProfit ?? "—"}</div>
                  </div>
                  <div className="flex items-center justify-between border-t border-zinc-800 pt-2">
                    <div className="text-xs text-muted-foreground">{rowConfirmed(p) ? "Current P/L" : "Last reported P/L"}</div>
                    <div
                      className={`text-base font-semibold tabular-nums flex items-center gap-1 ${toneFor(p.netProfit)}`}
                      data-testid={`open-trade-mobile-pl-${p.brokerTicket ?? "x"}`}
                      title={p.netProfit == null ? "The bridge has not reported floating P/L for this position." : undefined}
                    >
                      {p.netProfit != null && p.netProfit > 0 ? <TrendingUp className="h-3 w-3" /> : p.netProfit != null && p.netProfit < 0 ? <TrendingDown className="h-3 w-3" /> : null}
                      {p.netProfit == null ? "Not reported" : fmtMoney(p.netProfit, ccy)}
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
                  {rowConfirmed(p) ? (
                    p.lastUpdated && (
                      <div className="text-[10px] text-muted-foreground">Updated {new Date(p.lastUpdated).toLocaleTimeString()}</div>
                    )
                  ) : (
                    <div className="text-[10px] text-amber-300/90" data-testid={`open-trade-mobile-pending-${p.brokerTicket ?? "x"}`}>
                      {rowPendingNote(p)}
                    </div>
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
                    <th className="py-2 pr-2 text-right">Net P/L</th>
                    <th className="py-2 pr-2 text-right">% of Slot</th>
                    <th className="py-2 pr-2 text-right">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.brokerTicket} className="border-b border-zinc-900" data-testid={`open-trade-${p.brokerTicket ?? "x"}`}>
                      <td className="py-2 pr-2 font-mono">{p.symbol}</td>
                      <td className="py-2 pr-2"><Badge variant="outline">{p.direction}</Badge></td>
                      <td className="py-2 pr-2 text-right tabular-nums">{p.volume}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{p.entryPrice}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{p.currentPrice ?? "—"}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-xs">{p.stopLoss ?? "—"} / {p.takeProfit ?? "—"}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-xs">{p.swap == null ? "—" : fmtMoney(p.swap, ccy)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-xs">{p.commission == null ? "—" : fmtMoney(p.commission, ccy)}</td>
                      <td
                        className={`py-2 pr-2 text-right tabular-nums font-semibold ${toneFor(p.netProfit)}`}
                        data-testid={`open-trade-pl-${p.brokerTicket ?? "x"}`}
                        title={p.netProfit == null ? "The bridge has not reported floating P/L for this position." : undefined}
                      >
                        {p.netProfit == null ? "—" : fmtMoney(p.netProfit, ccy)}
                      </td>
                      <td className={`py-2 pr-2 text-right tabular-nums ${toneFor(p.profitPercentOfSlot)}`}>
                        {p.profitPercentOfSlot == null ? "—" : `${p.profitPercentOfSlot >= 0 ? "+" : ""}${p.profitPercentOfSlot.toFixed(2)}%`}
                      </td>
                      <td
                        className={`py-2 pr-2 text-right text-[11px] ${rowConfirmed(p) ? "text-muted-foreground" : "text-amber-300/90"}`}
                        data-testid={`open-trade-updated-${p.brokerTicket ?? "x"}`}
                        title={rowConfirmed(p) ? undefined : rowPendingNote(p)}
                      >
                        {p.lastUpdated ? new Date(p.lastUpdated).toLocaleTimeString() : "—"}
                        {!rowConfirmed(p) && <span className="block">unconfirmed</span>}
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
