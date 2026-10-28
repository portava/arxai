import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Briefcase, TrendingUp, TrendingDown, Wifi, WifiOff, AlertTriangle } from "lucide-react";
import { fetchLiveSlotSummary, lastGoodReadTime } from "./LiveSlotSummaryCard";

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
  // Position-snapshot reliability is separate from the bridge heartbeat: a
  // fresh heartbeat with an old/missing positions sweep is NOT a live book.
  positionSyncIncomplete?: boolean;
  snapshotWarning?: string | null;
  /** When the broker last reported this book (null = never). Not the response time. */
  lastUpdated: string | null;
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
    queryFn: () => fetchLiveSlotSummary<SlotSummary>(),
    refetchInterval: 3000,
    refetchOnWindowFocus: false,
    staleTime: 1500,
  });

  // A failed read is never an empty book. On a failed refresh React Query keeps
  // the last good data; it is shown as "last successful read", never as live.
  const readFailed = q.isError;
  const ccy = q.data?.accountCurrency ?? "USD";
  const positions = q.data?.positions ?? [];
  const syncIncomplete = q.data?.positionSyncIncomplete === true;
  // "Live" requires a successful latest read, a fresh bridge heartbeat AND a
  // reliable positions snapshot; the client may only downgrade the server's isLive.
  const bookLive = !readFailed && q.data?.isLive === true && !syncIncomplete;
  const plMuted = (p: SlotPosition) => readFailed || rowPending(p);
  const plCurrent = (p: SlotPosition) => !readFailed && rowConfirmed(p);

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
          {readFailed ? (
            <Badge
              variant="outline"
              className="text-amber-300 border-amber-500/40 gap-1"
              data-testid="open-trades-badge-read-failed"
              title="The latest request for your open trades failed."
            >
              <AlertTriangle className="h-3 w-3" /> {q.data ? "Not updating" : "Not loaded"}
            </Badge>
          ) : bookLive ? (
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
        {readFailed && q.data ? (
          <div className="mb-3 text-[11px] text-amber-300/90 flex items-start gap-1" role="alert" data-testid="open-trades-refresh-failed">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>
              Could not refresh open trades. Showing the last successful read from {lastGoodReadTime(q.dataUpdatedAt)};
              positions and P/L may have changed since.
            </span>
          </div>
        ) : null}
        {q.isLoading ? (
          <div className="text-sm text-muted-foreground py-4 text-center">Loading open trades…</div>
        ) : readFailed && !q.data ? (
          <div className="text-sm text-amber-300 py-4 text-center" role="alert" data-testid="open-trades-load-error">
            Open trades could not be loaded — ARX could not read your book from the server. Do not assume you are flat; check MT5 directly.
          </div>
        ) : positions.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center" data-testid="open-trades-empty">
            {readFailed
              ? `No open trades at the last successful read (${lastGoodReadTime(q.dataUpdatedAt)}).`
              : "No open trades right now."}
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
                    <div className="text-xs text-muted-foreground">{plCurrent(p) ? "Current P/L" : "Last reported P/L"}</div>
                    <div
                      className={`text-base font-semibold tabular-nums flex items-center gap-1 ${plMuted(p) ? "text-zinc-400" : toneFor(p.grossProfit)}`}
                      data-testid={`open-trade-mobile-pl-${p.brokerTicket ?? "x"}`}
                      title={p.grossProfit == null ? "The broker has not reported floating P/L for this position." : undefined}
                    >
                      {!plMuted(p) && p.grossProfit != null && p.grossProfit > 0 ? <TrendingUp className="h-3 w-3" /> : !plMuted(p) && p.grossProfit != null && p.grossProfit < 0 ? <TrendingDown className="h-3 w-3" /> : null}
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
                      <td className={`py-2 pr-2 text-right tabular-nums font-semibold ${plMuted(p) ? "text-zinc-400" : toneFor(p.grossProfit)}`} data-testid={`open-trade-pl-${p.brokerTicket ?? "x"}`}>{plText(p, ccy)}</td>
                      <td className={`py-2 pr-2 text-right tabular-nums ${plMuted(p) ? "text-zinc-400" : toneFor(p.profitPercentOfSlot)}`}>
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
