import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Briefcase, X, Scissors, ArrowDownToLine, TrendingUp } from "lucide-react";
import { EmptyState } from "@/components/trading/EmptyState";

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

const STATUS_COLOR: Record<string, string> = {
  OPEN: "border-primary/40 bg-primary/10 text-primary",
  CLOSED: "border-border bg-secondary/40 text-txt-muted",
  STOPPED_OUT: "border-danger/40 bg-danger/10 text-danger",
  TAKE_PROFIT_HIT: "border-success/40 bg-success/10 text-success",
  MANUALLY_CLOSED: "border-border bg-secondary/40 text-txt-secondary",
};

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open", CLOSED: "Closed", STOPPED_OUT: "Stopped out",
  TAKE_PROFIT_HIT: "Take profit", MANUALLY_CLOSED: "Closed",
};
/** Signed dollars to the cent: "-$12.50", "$0.00". Not a number → "—". */
const usd = (n: unknown): string =>
  typeof n === "number" && Number.isFinite(n) ? `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}` : "—";

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
  // null until the first read answers; false when it failed. A failed read is
  // never shown as an empty book.
  const [loaded, setLoaded] = useState<boolean | null>(null);
  const [dataSource, setDataSource] = useState<string | null>(null);
  const [tab, setTab] = useState<"OPEN" | "CLOSED" | "INTENT" | "MT5">("OPEN");

  async function readJson(path: string): Promise<Record<string, unknown> | null> {
    try {
      const x = await fetch(path);
      if (!x.ok) return null;
      const body: unknown = await x.json();
      return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    } catch { return null; }
  }

  async function load() {
    const [r, s] = await Promise.all([readJson("/api/oms/positions"), readJson("/api/pnl/summary")]);
    if (r && Array.isArray(r.positions)) {
      setPositions(r.positions as Pos[]);
      setDataSource(typeof r.dataSource === "string" ? r.dataSource : null);
      setLoaded(true);
    } else {
      setPositions([]);
      setLoaded(false);
    }
    setPnl(s && typeof s.dailyPnL === "number" ? (s as unknown as Pnl) : null);
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
    <div className="mx-auto w-full max-w-[1280px] space-y-4 p-4 md:p-6 pb-32 md:pb-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
          <Briefcase className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <h1 className="text-2xl font-bold leading-tight">Positions</h1>
          <p className="text-sm text-txt-secondary">Your own simulator book: fills and P/L at ARX simulator prices, not a broker account. Real broker positions route through the MT5 bridge.</p>
        </div>
        <span data-testid="positions-data-source" className="rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs font-semibold text-warning">
          {loaded === false ? "Data source: not read" : `Data source: ${dataSource ?? "SIMULATOR"} (not a broker)`}
        </span>
      </div>

      {pnl && (
        <div className="grid gap-2 md:grid-cols-6">
          <Stat label="Sim realized today" value={usd(pnl.dailyPnL)} />
          <Stat label="Sim realized 7d" value={usd(pnl.weeklyPnL)} />
          <Stat label="Sim open (unrealized)" value={usd(pnl.openUnrealizedPnL)} />
          <Stat label="Win rate (closed)" value={`${pnl.winRate}%`} />
          <Stat label="Avg R (closed)" value={String(pnl.averageR)} />
          <Stat label="Max DD (closed)" value={usd(pnl.maxDrawdown)} />
        </div>
      )}

      <div className="flex gap-1">
        {(["OPEN", "CLOSED", "INTENT", "MT5"] as const).map((t) => (
          <Button key={t} size="sm" variant={tab === t ? "default" : "outline"} onClick={() => setTab(t)}>
            {t === "OPEN" && "Open Simulated"}
            {t === "CLOSED" && "Closed"}
            {t === "INTENT" && "Live Tester Intent"}
            {t === "MT5" && "Future MT5 Broker"}
          </Button>
        ))}
      </div>

      {tab === "MT5" ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-sm text-txt-muted">
          <span className="mr-2 rounded-md border border-ruby/40 bg-ruby/10 px-2 py-0.5 text-xs text-ruby">MT5 deferred</span>
          Real broker positions route through the MT5 bridge. This panel activates once the bridge is connected.
        </div>
      ) : loaded === false ? (
        <div className="rounded-2xl border border-danger/30 bg-danger/5 p-6 text-sm text-danger" role="alert">
          Could not load your simulator positions. The list is unknown, not empty — try again shortly.
        </div>
      ) : loaded === null ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-sm text-txt-muted">Loading your simulator positions…</div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-2">
          <EmptyState
            icon={Briefcase}
            title={tab === "CLOSED" ? "No closed simulator positions." : "No open simulator positions."}
            description="This list shows only simulator positions placed for your account. It does not show broker positions."
          />
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((p) => (
            <div key={p.positionId} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2 pb-2">
                <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-semibold", STATUS_COLOR[p.status] ?? "border-border bg-secondary/40 text-txt-muted")}>{statusLabel(p.status)}</span>
                <Badge variant="outline">{p.environment}</Badge>
                <span className="text-base font-semibold">{p.symbol}</span>
                <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold", p.direction === "BUY" ? "bg-success/15 text-success" : "bg-danger/15 text-danger")}>{p.direction} ×{p.lotSize}</span>
                <span className={cn("ml-auto font-mono font-bold", (p.unrealizedPnL || p.realizedPnL) >= 0 ? "text-success" : "text-danger")}>
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
                  <div className="flex flex-wrap gap-2 border-t border-border pt-2">
                    <Button size="sm" variant="outline" className="h-7" onClick={() => closeP(p)}><X className="h-3 w-3 mr-1" />Close</Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => partial(p)}><Scissors className="h-3 w-3 mr-1" />½ close</Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => be(p)}><ArrowDownToLine className="h-3 w-3 mr-1" />Break-even</Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => trail(p)}><TrendingUp className="h-3 w-3 mr-1" />Trail</Button>
                  </div>
                )}
                {p.environment === "LIVE_TESTER_INTENT" && (
                  <div className="flex flex-wrap gap-2 border-t border-border pt-2">
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
  return (
    <div className={cn("rounded-xl border border-border bg-card", small ? "p-2" : "p-3")}>
      <p className="text-[10px] uppercase text-txt-muted">{label}</p>
      <p className={small ? "font-mono text-sm" : "text-lg font-bold"}>{value}</p>
    </div>
  );
}
