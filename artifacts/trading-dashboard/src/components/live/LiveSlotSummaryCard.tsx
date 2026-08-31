import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Wallet, TrendingUp, TrendingDown, Wifi, WifiOff, AlertTriangle } from "lucide-react";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type SlotSummary = {
  accountCurrency: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevelPercent: number | null;
  marginSource?: string;
  marginEstimateIncomplete?: boolean;
  openPnL: number;
  openPnLIncomplete?: boolean;
  positions: unknown[];
  positionSyncIncomplete?: boolean;
  snapshotWarning?: string | null;
  isLive: boolean;
  isStale: boolean;
  isAllocated: boolean;
  allocationNote: string | null;
  lastUpdated: string;
};

function fmtMoney(v: number, ccy: string): string {
  if (!Number.isFinite(v)) return "—";
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
    queryFn: () => fetch(`${BASE}/api/me/live/slot-summary`, { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 3000,
    refetchOnWindowFocus: false,
    staleTime: 1500,
  });

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
        <CardContent><div className="text-sm text-danger">Couldn't load your account summary.</div></CardContent>
      </Card>
    );
  }

  const pnlTone = s.openPnL > 0 ? "text-success" : s.openPnL < 0 ? "text-danger" : "text-txt-secondary";
  const pnlIcon = s.openPnL > 0
    ? <TrendingUp className="h-3 w-3 text-success" />
    : s.openPnL < 0
    ? <TrendingDown className="h-3 w-3 text-danger" />
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
              ? "Your slotted funds and live floating P/L."
              : (s.allocationNote ?? "No allocation assigned.")}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {s.isLive ? (
            <Badge className="bg-success/20 text-success gap-1" data-testid="badge-live"><Wifi className="h-3 w-3" /> Live</Badge>
          ) : s.isStale ? (
            <Badge variant="outline" className="text-warning border-warning/40 gap-1" data-testid="badge-stale"><AlertTriangle className="h-3 w-3" /> Stale</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground gap-1" data-testid="badge-disconnected"><WifiOff className="h-3 w-3" /> Disconnected</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Slot Balance" value={fmtMoney(s.balance, s.accountCurrency)} />
          <Stat label="Slot Equity" value={fmtMoney(s.equity, s.accountCurrency)} />
          <Stat label="Open P/L" value={fmtMoney(s.openPnL, s.accountCurrency)} valueClassName={pnlTone} icon={pnlIcon} />
          <Stat label="Used Margin" value={fmtMoney(s.margin, s.accountCurrency)} />
          <Stat label="Free Margin" value={fmtMoney(s.freeMargin, s.accountCurrency)} />
          <Stat label="Margin Level" value={fmtPct(s.marginLevelPercent)} />
        </div>
        {s.positionSyncIncomplete ? (
          <div className="mt-2 text-[11px] text-ruby/90 flex items-start gap-1" data-testid="slot-sync-incomplete">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>{s.snapshotWarning ?? "Position sync incomplete — waiting for broker confirmation."}</span>
          </div>
        ) : null}
        {s.openPnLIncomplete ? (
          <div className="mt-2 text-[11px] text-warning/90 flex items-start gap-1" data-testid="slot-openpnl-incomplete">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>
              One or more open positions haven't reported a P/L yet, so Open
              P/L and Slot Equity are partial figures.
            </span>
          </div>
        ) : null}
        {s.marginEstimateIncomplete ? (
          <div className="mt-2 text-[11px] text-warning/90 flex items-start gap-1">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>
              Used/free margin is a forex-only estimate. Your broker doesn't
              report margin for synthetic-index positions, so the real figure is
              higher.
            </span>
          </div>
        ) : null}
        <div className="mt-3 text-[11px] text-muted-foreground">
          Last update: {new Date(s.lastUpdated).toLocaleTimeString()}
        </div>
      </CardContent>
    </Card>
  );
}
