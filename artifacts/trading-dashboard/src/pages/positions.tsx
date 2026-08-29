import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Briefcase, X, Scissors, ArrowDownToLine, TrendingUp } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { STATUS_COLORS, directionTone, pnlTone, type StatusTone } from "@/lib/design-tokens";

type Pos = {
  positionId: string; orderId: string; environment: string;
  symbol: string; direction: string; lotSize: number;
  entryPrice: number; currentPrice: number;
  stopLoss?: number; takeProfit?: number;
  unrealizedPnL: number; realizedPnL: number; rMultiple: number;
  status: string; openedAt: string; closedAt?: string; closeReason?: string;
};

type Pnl = {
  environment: string; dailyPnL: number; weeklyPnL: number; monthlyPnL: number;
  openUnrealizedPnL: number; closedRealizedPnL: number;
  wins: number; losses: number; winRate: number; averageR: number; maxDrawdown: number;
};

// Status → semantic tone (badge classes come from STATUS_COLORS, so both
// themes render correctly). OPEN keeps the brand-blue accent.
const STATUS_TONE: Record<string, StatusTone> = {
  CLOSED: "inactive",
  STOPPED_OUT: "danger",
  TAKE_PROFIT_HIT: "success",
  MANUALLY_CLOSED: "neutral",
};
const OPEN_BADGE = "bg-primary/10 text-primary border-primary/25";
const statusBadgeClass = (s: string) =>
  s === "OPEN" ? OPEN_BADGE : STATUS_COLORS[STATUS_TONE[s] ?? "inactive"].badge;

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open", CLOSED: "Closed", STOPPED_OUT: "Stopped out",
  TAKE_PROFIT_HIT: "Take profit", MANUALLY_CLOSED: "Closed",
};
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, {
    headers: { "x-security-role": "ADMIN", "content-type": "application/json", ...(init?.headers ?? {}) }, ...init,
  });
  return r.json();
}

export default function PositionsPage() {
  const [positions, setPositions] = useState<Pos[]>([]);
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [tab, setTab] = useState<"OPEN" | "CLOSED" | "INTENT" | "MT5">("OPEN");

  async function load() {
    const [r, s] = await Promise.all([
      fetch("/api/oms/positions").then((x) => x.json()),
      fetch("/api/pnl/summary").then((x) => x.json()),
    ]);
    setPositions(r.positions ?? []);
    setPnl(s);
  }
  useEffect(() => { void load(); const id = setInterval(load, 3000); return () => clearInterval(id); }, []);

  const visible = useMemo(() => {
    if (tab === "OPEN") return positions.filter((p) => p.status === "OPEN" && !p.environment.startsWith("LIVE"));
    if (tab === "CLOSED") return positions.filter((p) => p.status !== "OPEN");
    if (tab === "INTENT") return positions.filter((p) => p.environment === "LIVE_TESTER_INTENT");
    return [];
  }, [positions, tab]);

  async function closeP(p: Pos) { await api(`/api/oms/positions/${p.positionId}/close`, { method: "POST" }); load(); }
  async function partial(p: Pos) { await api(`/api/oms/positions/${p.positionId}/partial-close`, { method: "POST", body: JSON.stringify({ fraction: 0.5 }) }); load(); }
  async function be(p: Pos) { await api(`/api/oms/positions/${p.positionId}/breakeven`, { method: "POST" }); load(); }
  async function trail(p: Pos) {
    const dist = Math.abs(p.entryPrice - (p.stopLoss ?? p.entryPrice)) || (p.symbol === "XAUUSD" ? 1 : 0.001);
    await api(`/api/oms/positions/${p.positionId}/trailing-stop`, { method: "POST", body: JSON.stringify({ distance: dist }) }); load();
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6 pb-32 md:pb-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
          <Briefcase className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <h1 className="text-2xl font-bold leading-tight tracking-tight">Positions</h1>
          <p className="text-sm text-muted-foreground">Simulated positions tracked live. Real broker positions route through the MT5 bridge.</p>
        </div>
      </div>

      {pnl && (
        <div className="grid gap-4 grid-cols-2 md:grid-cols-6">
          <Stat label="Daily" value={`$${pnl.dailyPnL}`} />
          <Stat label="Weekly" value={`$${pnl.weeklyPnL}`} />
          <Stat label="Open" value={`$${pnl.openUnrealizedPnL}`} />
          <Stat label="Win rate" value={`${pnl.winRate}%`} />
          <Stat label="Avg R" value={String(pnl.averageR)} />
          <Stat label="Max DD" value={`$${pnl.maxDrawdown}`} />
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {(["OPEN", "CLOSED", "INTENT", "MT5"] as const).map((t) => (
          <Button
            key={t}
            size="sm"
            variant="outline"
            className={cn(tab === t && "border-primary/40 bg-primary/10 text-primary")}
            onClick={() => setTab(t)}
          >
            {t === "OPEN" && "Open Simulated"}
            {t === "CLOSED" && "Closed"}
            {t === "INTENT" && "Live Tester Intent"}
            {t === "MT5" && "Future MT5 Broker"}
          </Button>
        ))}
      </div>

      {tab === "MT5" ? (
        <div className="rounded-xl border border-card-border bg-card p-6 text-sm text-txt-muted shadow-sm">
          <span className={cn("mr-2 rounded-full border px-2.5 py-0.5 text-xs", STATUS_COLORS.info.badge)}>MT5 deferred</span>
          Real broker positions route through the MT5 bridge. This panel activates once the bridge is connected.
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-card-border bg-card p-2 shadow-sm">
          <EmptyState
            icon={Briefcase}
            title="No open positions yet."
            description="Your positions will appear here once you place a trade. Use Demo mode to practice risk-free, or finish account setup to unlock live trading."
          />
        </div>
      ) : (
        <div className="space-y-4">
          {visible.map((p) => (
            <div key={p.positionId} className="rounded-xl border border-card-border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-2 pb-2">
                <span className={cn("rounded-full border px-2.5 py-0.5 text-[11px] font-medium", statusBadgeClass(p.status))}>{statusLabel(p.status)}</span>
                <Badge variant="outline">{p.environment}</Badge>
                <span className="text-base font-semibold tracking-tight">{p.symbol}</span>
                <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-medium tabular-nums", STATUS_COLORS[directionTone(p.direction)].bg, STATUS_COLORS[directionTone(p.direction)].text)}>{p.direction} ×{p.lotSize}</span>
                <span className={cn("ml-auto font-mono font-bold tabular-nums", STATUS_COLORS[pnlTone(p.status === "OPEN" ? p.unrealizedPnL : p.realizedPnL)].text)}>
                  ${p.status === "OPEN" ? p.unrealizedPnL : p.realizedPnL} {p.rMultiple !== 0 && `(${p.rMultiple}R)`}
                </span>
              </div>
              <div className="space-y-2 text-xs">
                <div className="grid grid-cols-4 gap-2 text-center">
                  <Stat small label="Entry" value={String(p.entryPrice)} />
                  <Stat small label="Now" value={String(p.currentPrice)} />
                  <Stat small label="SL" value={p.stopLoss ? String(p.stopLoss) : "—"} />
                  <Stat small label="TP" value={p.takeProfit ? String(p.takeProfit) : "—"} />
                </div>
                {p.status === "OPEN" && p.environment !== "LIVE_TESTER_INTENT" && (
                  <div className="flex flex-wrap gap-2 border-t border-border/60 pt-2">
                    <Button size="sm" variant="outline" className="h-7" onClick={() => closeP(p)}><X className="h-3 w-3 mr-1" />Close</Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => partial(p)}><Scissors className="h-3 w-3 mr-1" />½ close</Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => be(p)}><ArrowDownToLine className="h-3 w-3 mr-1" />Break-even</Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => trail(p)}><TrendingUp className="h-3 w-3 mr-1" />Trail</Button>
                  </div>
                )}
                {p.environment === "LIVE_TESTER_INTENT" && (
                  <div className="flex flex-wrap gap-2 border-t border-border/60 pt-2">
                    <Button size="sm" variant="outline" disabled>Send to broker (MT5 deferred)</Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return small ? (
    <div className="rounded-lg bg-muted/40 p-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="font-mono text-sm tabular-nums">{value}</p>
    </div>
  ) : (
    <div className="rounded-xl border border-card-border bg-card p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-lg font-bold tabular-nums">{value}</p>
    </div>
  );
}
