import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Wallet, TrendingUp, TrendingDown, Wifi, WifiOff, AlertTriangle } from "lucide-react";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type SlotSummary = {
  accountCurrency: string;
  balance: number;
  /** Null when open P/L is unknown (a position's P/L not yet reported). */
  equity: number | null;
  margin: number;
  freeMargin: number | null;
  marginLevelPercent: number | null;
  marginSource?: string;
  marginEstimateIncomplete?: boolean;
  /** Null when any open position's P/L has not been reported (see unpricedPositionCount). */
  openPnL: number | null;
  unpricedPositionCount?: number;
  positions: unknown[];
  positionSyncIncomplete?: boolean;
  snapshotWarning?: string | null;
  isLive: boolean;
  isStale: boolean;
  isAllocated: boolean;
  allocationNote: string | null;
  /** When the broker last reported this book (null = never). Not the response time. */
  lastUpdated: string | null;
};

/**
 * Shared read for the /live-trades slot summary (card + Open Trades panel use
 * one query key). A non-2xx answer (401 envelope, HTML 500) is a failed read and
 * throws, so it surfaces as q.isError — it is never parsed into an empty book.
 */
export async function fetchLiveSlotSummary<T>(): Promise<T> {
  const r = await fetch(`${BASE}/api/me/live/slot-summary`, { credentials: "include" });
  if (!r.ok) throw new Error(`Slot summary request failed (HTTP ${r.status})`);
  return (await r.json()) as T;
}

/** Time of the last successful read, for "showing the last successful read from …" copy. */
export function lastGoodReadTime(dataUpdatedAt: number): string {
  return dataUpdatedAt > 0 ? new Date(dataUpdatedAt).toLocaleTimeString() : "an earlier read";
}

function fmtMoney(v: number | null, ccy: string): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const body = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return ccy === "USD" ? `${sign}$${body}` : `${sign}${body} ${ccy}`;
}

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}%`;
}

function Stat({ label, value, valueClassName, icon }: {
  label: string;
  value: string;
  valueClassName?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums flex items-center gap-1 ${valueClassName ?? ""}`}>
        {icon}{value}
      </div>
    </div>
  );
}

export function LiveSlotSummaryCard() {
  const q = useQuery<SlotSummary>({
    queryKey: ["live", "slot-summary"],
    queryFn: () => fetchLiveSlotSummary<SlotSummary>(),
    refetchInterval: 3000,
    refetchOnWindowFocus: false,
    staleTime: 1500,
  });
  // A failed refresh keeps the last good data in q.data; it is shown only as
  // "last successful read", never as live.
  const readFailed = q.isError;

  if (q.isLoading) {
    return (
      <Card data-testid="slot-summary-loading">
        <CardHeader><CardTitle className="text-base">Your Account</CardTitle></CardHeader>
        <CardContent><div className="text-sm text-muted-foreground">Loading account summary…</div></CardContent>
      </Card>
    );
  }
  const s = q.data;
  if (!s) {
    return (
      <Card data-testid="slot-summary-error">
        <CardHeader><CardTitle className="text-base">Your Account</CardTitle></CardHeader>
        <CardContent>
          <div className="text-sm text-rose-400">
            Your account summary could not be loaded — ARX could not read it from the server. Balance, equity and open P/L are unknown, not zero.
          </div>
        </CardContent>
      </Card>
    );
  }

  const pnl = s.openPnL;
  // A value from a failed refresh is not coloured as a live move.
  const pnlTone = pnl == null || readFailed ? "text-zinc-400" : pnl > 0 ? "text-emerald-400" : pnl < 0 ? "text-rose-400" : "text-zinc-300";
  const pnlIcon = readFailed
    ? null
    : pnl != null && pnl > 0
    ? <TrendingUp className="h-3 w-3 text-emerald-400" />
    : pnl != null && pnl < 0
    ? <TrendingDown className="h-3 w-3 text-rose-400" />
    : null;

  return (
    <Card data-testid="slot-summary-card">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4" /> Your Account
          </CardTitle>
          <CardDescription>
            {s.isAllocated
              ? readFailed
                ? "Your slotted funds and floating P/L from the last successful read."
                : "Your slotted funds and live floating P/L."
              : (s.allocationNote ?? "No allocation assigned.")}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {readFailed ? (
            <Badge
              variant="outline"
              className="text-amber-300 border-amber-500/40 gap-1"
              data-testid="badge-read-failed"
              title="The latest request for your account summary failed."
            >
              <AlertTriangle className="h-3 w-3" /> Not updating
            </Badge>
          ) : s.isLive ? (
            <Badge className="bg-emerald-500/20 text-emerald-300 gap-1" data-testid="badge-live"><Wifi className="h-3 w-3" /> Live</Badge>
          ) : s.isStale ? (
            <Badge variant="outline" className="text-amber-300 border-amber-500/40 gap-1" data-testid="badge-stale"><AlertTriangle className="h-3 w-3" /> Stale</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground gap-1" data-testid="badge-disconnected"><WifiOff className="h-3 w-3" /> Disconnected</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {readFailed ? (
          <div className="mb-3 text-[11px] text-amber-300/90 flex items-start gap-1" role="alert" data-testid="slot-refresh-failed">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>
              Could not refresh your account summary. Showing the last successful read from {lastGoodReadTime(q.dataUpdatedAt)};
              balance, equity and open P/L may have changed since.
            </span>
          </div>
        ) : null}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Slot Balance" value={fmtMoney(s.balance, s.accountCurrency)} />
          <Stat label="Slot Equity" value={fmtMoney(s.equity, s.accountCurrency)} />
          <Stat label="Open P/L" value={fmtMoney(s.openPnL, s.accountCurrency)} valueClassName={pnlTone} icon={pnlIcon} />
          <Stat label="Used Margin" value={fmtMoney(s.margin, s.accountCurrency)} />
          <Stat label="Free Margin" value={fmtMoney(s.freeMargin, s.accountCurrency)} />
          <Stat label="Margin Level" value={fmtPct(s.marginLevelPercent)} />
        </div>
        {s.openPnL == null && (s.unpricedPositionCount ?? 0) > 0 ? (
          <div className="mt-2 text-[11px] text-amber-300/90 flex items-start gap-1" data-testid="slot-pnl-unreported">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>
              The broker has not reported P/L for {s.unpricedPositionCount} open position{s.unpricedPositionCount === 1 ? "" : "s"} yet,
              so open P/L, equity and free margin are not shown.
            </span>
          </div>
        ) : null}
        {s.positionSyncIncomplete ? (
          <div className="mt-2 text-[11px] text-sky-300/90 flex items-start gap-1" data-testid="slot-sync-incomplete">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>{s.snapshotWarning ?? "Position sync incomplete — waiting for broker confirmation."}</span>
          </div>
        ) : null}
        {s.marginEstimateIncomplete ? (
          <div className="mt-2 text-[11px] text-amber-300/90 flex items-start gap-1">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>
              Used/free margin is a forex-only estimate. Your broker doesn't
              report margin for synthetic-index positions, so the real figure is
              higher.
            </span>
          </div>
        ) : null}
        <div className="mt-3 text-[11px] text-muted-foreground" data-testid="slot-last-update">
          {s.lastUpdated
            ? <>Last broker update: {new Date(s.lastUpdated).toLocaleTimeString()}{s.isStale ? " (stale)" : ""}</>
            : "Last broker update: none received"}
        </div>
      </CardContent>
    </Card>
  );
}
