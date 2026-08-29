import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Loader2, AlertTriangle, Target, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

type WatchItem = {
  tradeKey: string;
  symbol: string;
  side: "BUY" | "SELL";
  lotSize: number;
  unrealizedPnl: number | null;
  peakPnl: number | null;
  profitGivebackPercent: number | null;
  closeUrgencyScore: number | null;
  reversalRiskScore: number | null;
  fakeoutRiskScore: number | null;
  volatilityRiskScore: number | null;
  label: string | null;
  recommendedAction: string | null;
  reasons: string[];
  urgencyTier: "info" | "watch" | "warning" | "urgent";
};

const tierStyle: Record<string, string> = {
  urgent: "border-rose-700 bg-rose-500/5 text-rose-300",
  warning: "border-amber-700 bg-amber-500/5 text-amber-300",
  watch: "border-blue-700 bg-blue-500/5 text-blue-300",
  info: "border-zinc-700 bg-zinc-500/5 text-zinc-300",
};

export default function SniperWatchlistPage() {
  const [items, setItems] = useState<WatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [routingMode, setRoutingMode] = useState<string>("—");

  async function load() {
    setErr(null);
    try {
      const r = await fetch(u("/api/me/sniper-watchlist"), { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = (await r.json()) as { items: WatchItem[]; routingMode: string };
      setItems(b.items ?? []);
      setRoutingMode(b.routingMode ?? "—");
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Sniper Watchlist</h1>
          <Badge variant="outline" className="text-[10px] uppercase">{routingMode}</Badge>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()} data-testid="watchlist-refresh">
          <RefreshCw className="mr-1 h-3 w-3" /> Refresh
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Open trades flagged by the Sniper Exit engine. Ranked by close urgency. No order is placed
        — this is decision support only. Tap a row to open the trade detail.
      </p>

      {loading ? (
        <Card><CardContent className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Scanning your open trades…</CardContent></Card>
      ) : err ? (
        <Card><CardContent className="flex items-center gap-2 p-6 text-danger"><AlertTriangle className="h-4 w-4" /> {err}</CardContent></Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={Target}
            title="None of your open trades are flagged for attention right now."
            description="The engine watches your trades continuously — if a profit-giveback, reversal, or close-urgency signal fires, it will appear here automatically."
            data-testid="watchlist-empty"
          />
        </Card>
      ) : (
        <div className="space-y-2" data-testid="watchlist-items">
          {items.map((it) => (
            <Link key={it.tradeKey} href={`/my-trades/${encodeURIComponent(it.tradeKey)}`}>
              <Card className={`cursor-pointer border ${tierStyle[it.urgencyTier]} hover:opacity-90`}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      {it.side === "BUY" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                      <span className="text-zinc-100">{it.symbol}</span>
                      <Badge variant="outline" className="text-[10px]">{it.side} · {it.lotSize}</Badge>
                      <Badge variant="outline" className="text-[10px] uppercase">{it.urgencyTier}</Badge>
                    </div>
                    {it.recommendedAction && (
                      <Badge variant={it.recommendedAction.startsWith("CLOSE") ? "destructive" : "secondary"} className="text-[10px]">
                        {it.recommendedAction}
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-xs">
                  <div className="grid grid-cols-2 gap-1 text-zinc-400 md:grid-cols-4">
                    <div>P&L: <span className="text-zinc-100">{it.unrealizedPnl?.toFixed?.(2) ?? "—"}</span></div>
                    <div>Peak: <span className="text-zinc-100">{it.peakPnl?.toFixed?.(2) ?? "—"}</span></div>
                    <div>Giveback: <span className="text-zinc-100">{it.profitGivebackPercent ?? "—"}%</span></div>
                    <div>Urgency: <span className="text-zinc-100">{it.closeUrgencyScore ?? "—"}</span></div>
                  </div>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {it.reasons.map((r) => (
                      <Badge key={r} variant="outline" className="text-[10px]">{r}</Badge>
                    ))}
                  </div>
                  {it.label && <div className="pt-1 text-zinc-300">{it.label}</div>}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
