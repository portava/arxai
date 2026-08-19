import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Activity, RefreshCw } from "lucide-react";
import { humanizeReason } from "@/lib/friendlyLabels";

type Health = {
  symbol: string; timeframe: string; labels: string[];
  quote: { bid: number; ask: number; spread: number; isStale: boolean; provider: string; timestamp: string };
  spread: { spreadBps: number; label: string };
  volatility: { atr: number; ratio: number; label: string };
  session: { sessionLabel: string; activeSessions: string[] };
  news: { blocking: boolean; blockReason: string | null; events: Array<{ event: { eventName: string; impact: string }; minutesUntil: number }> };
  mt5BridgeConnected: boolean;
};

// Phase: Market Data Freshness — backend-driven provider status shape
// returned by GET /api/me/market-data/status. Surfaced as a separate
// header card so the user can never see a stale provider labelled as
// healthy. Driven by real fetch results, not config alone.
type MarketDataStatus = {
  provider: string;
  connected: boolean;
  configured: boolean;
  freshnessState: "FRESH" | "STALE" | "NEVER_FETCHED" | "UNAVAILABLE" | "ERROR";
  stale: boolean;
  lastSuccessfulFetchAt: string | null;
  lastAttemptedFetchAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  staleAfterMs: number;
  unavailableReason: string | null;
  features: { quotes: boolean; news: boolean; snapshots: boolean; economicCalendar: boolean; candles: boolean; currentEvents?: boolean };
  setupHint: string | null;
  // Cleanup phase E — discrete rate-limit field.
  rateLimitStatus?: {
    limited: boolean;
    retryAfterMs: number | null;
    lastHitAt: string | null;
    source: "lastError" | "none";
  };
};

const LABEL_COLOR: Record<string, string> = {
  TRADEABLE: "bg-emerald-500 text-white",
  CAUTION: "bg-amber-500/70 text-white",
  HIGH_SPREAD: "bg-rose-500/80 text-white",
  HIGH_VOLATILITY: "bg-amber-500/80 text-white",
  LOW_LIQUIDITY: "bg-zinc-500/80 text-white",
  NEWS_RISK: "bg-rose-500/80 text-white",
  DATA_STALE: "bg-rose-500/80 text-white",
  MT5_DEFERRED: "bg-purple-500/80 text-white",
};

function freshnessBadgeColor(state: MarketDataStatus["freshnessState"]): string {
  switch (state) {
    case "FRESH": return "bg-emerald-500 text-white";
    case "STALE": return "bg-rose-500/80 text-white";
    case "ERROR": return "bg-rose-600 text-white";
    case "NEVER_FETCHED": return "bg-amber-500/70 text-white";
    case "UNAVAILABLE": return "bg-zinc-500/80 text-white";
    default: return "bg-zinc-500/80 text-white";
  }
}

function ageString(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

export default function MarketHealthPage() {
  const [symbol, setSymbol] = useState("EURUSD");
  const [tf, setTf] = useState("M15");
  const [h, setH] = useState<Health | null>(null);
  const [mds, setMds] = useState<MarketDataStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch(`/api/market/health?symbol=${symbol}&timeframe=${tf}`).then((x) => x.json());
      setH(r);
    } catch { /* keep last */ }
  }, [symbol, tf]);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch(`/api/me/market-data/status`, { credentials: "include" });
      if (!r.ok) { setMds(null); return; }
      const j = await r.json();
      setMds(j.status as MarketDataStatus);
    } catch { /* keep last */ }
  }, []);

  useEffect(() => {
    void loadHealth();
    const id = setInterval(loadHealth, 5000);
    return () => clearInterval(id);
  }, [loadHealth]);

  useEffect(() => {
    void loadStatus();
    const id = setInterval(loadStatus, 15000);
    return () => clearInterval(id);
  }, [loadStatus]);

  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshMessage(null);
    try {
      const r = await fetch(`/api/me/market-data/refresh`, { method: "POST", credentials: "include" });
      const j = await r.json();
      if (r.status === 429) {
        setRefreshMessage(`Rate-limited — try again in ${Math.ceil((j.retryAfterMs ?? 5000) / 1000)}s.`);
      } else if (!j.ok) {
        setRefreshMessage(`Refresh failed: ${j.reason ?? "unknown"}.`);
      } else {
        const okCount = (j.attempts as Array<{ ok: boolean }> ?? []).filter((a) => a.ok).length;
        setRefreshMessage(`Refreshed — ${okCount} live probe(s) succeeded.`);
      }
      if (j.status) setMds(j.status as MarketDataStatus);
    } catch (e) {
      setRefreshMessage(`Refresh error: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Activity className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Market Health</h1>
          <p className="text-sm text-muted-foreground">Composite spread + volatility + session + news + data freshness.</p>
        </div>
        <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className="w-32" />
        <Input value={tf} onChange={(e) => setTf(e.target.value)} className="w-20" />
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing} className="gap-1.5">
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing…" : "Refresh provider"}
        </Button>
      </div>

      {/* Phase: Market Data Freshness — honest provider status card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            Market Data Provider
            {mds && <Badge className={freshnessBadgeColor(mds.freshnessState)}>{mds.freshnessState}</Badge>}
            {mds?.rateLimitStatus?.limited && (
              <Badge
                className="bg-amber-500/80 text-white"
                data-testid="badge-provider-rate-limited"
                title={
                  mds.rateLimitStatus.retryAfterMs != null
                    ? `Retry available in ~${Math.ceil(mds.rateLimitStatus.retryAfterMs / 1000)}s`
                    : "Provider reported rate-limit on the last attempt."
                }
              >
                Provider Rate Limited
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs space-y-1.5">
          {!mds ? (
            <p className="text-muted-foreground">Loading provider status…</p>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">Provider</span><Badge variant="outline" className="text-[10px]">{mds.provider}</Badge></div>
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">Connected</span><span>{mds.connected ? "yes" : "no"}</span></div>
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">Configured</span><span>{mds.configured ? "yes" : "no"}</span></div>
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">Candles</span><span>{mds.features?.candles ? "yes" : "no"}</span></div>
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">Last success</span><span className="font-mono">{ageString(mds.lastSuccessfulFetchAt)}</span></div>
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">Last attempt</span><span className="font-mono">{ageString(mds.lastAttemptedFetchAt)}</span></div>
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">Stale after</span><span className="font-mono">{Math.round(mds.staleAfterMs / 60000)}m</span></div>
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">Stale now</span><span>{mds.stale ? "yes" : "no"}</span></div>
              </div>
              {mds.unavailableReason && (
                <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-rose-300">
                  <span className="font-semibold">Unavailable reason:</span> {mds.unavailableReason}
                </div>
              )}
              {mds.lastError && mds.freshnessState !== "FRESH" && (
                <div className="text-amber-300 break-words">
                  <span className="font-semibold">Last error:</span> {mds.lastError}
                  {mds.lastErrorAt && <span className="text-muted-foreground"> ({ageString(mds.lastErrorAt)})</span>}
                </div>
              )}
              {mds.setupHint && <p className="text-muted-foreground">{mds.setupHint}</p>}
              {refreshMessage && <p className="text-muted-foreground italic">{refreshMessage}</p>}
            </>
          )}
        </CardContent>
      </Card>

      {!h ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          <Card><CardHeader><CardTitle className="text-base">{h.symbol} {h.timeframe}</CardTitle></CardHeader>
            <CardContent className="flex flex-wrap gap-1">
              {h.labels.map((l) => <Badge key={l} className={LABEL_COLOR[l] ?? ""}>{l}</Badge>)}
            </CardContent></Card>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Quote</CardTitle></CardHeader>
              <CardContent className="text-xs space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">Provider</span><Badge variant="outline" className="text-[10px]">{h.quote.provider}</Badge></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Bid / Ask</span><span className="font-mono">{h.quote.bid} / {h.quote.ask}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Spread</span><span className="font-mono">{h.quote.spread}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Stale</span><span>{h.quote.isStale ? "yes" : "no"}</span></div>
              </CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Spread monitor</CardTitle></CardHeader>
              <CardContent className="text-xs space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">bps</span><span className="font-mono">{h.spread.spreadBps}</span></div>
                <Badge className={h.spread.label === "SPREAD_ACCEPTABLE" ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"}>{h.spread.label}</Badge>
              </CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Volatility</CardTitle></CardHeader>
              <CardContent className="text-xs space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">ATR</span><span className="font-mono">{h.volatility.atr}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Ratio</span><span className="font-mono">{h.volatility.ratio}</span></div>
                <Badge variant="outline">{h.volatility.label}</Badge>
              </CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Session</CardTitle></CardHeader>
              <CardContent className="text-xs space-y-1">
                <Badge variant="outline">{h.session.sessionLabel}</Badge>
                <p className="text-muted-foreground">{h.session.activeSessions.join(", ") || "none"}</p>
              </CardContent></Card>
          </div>

          <Card><CardHeader className="pb-2"><CardTitle className="text-sm">News risk</CardTitle></CardHeader>
            <CardContent className="text-xs space-y-2">
              {h.news.blocking && <Badge className="bg-rose-500/20 text-rose-400">Blocked — {humanizeReason(h.news.blockReason)}</Badge>}
              {h.news.events.length === 0
                ? <p className="text-muted-foreground">No upcoming events.</p>
                : <ul className="space-y-1">{h.news.events.map((e, i) => (
                    <li key={i} className="flex justify-between border-b py-1">
                      <span>{e.event.eventName}</span>
                      <Badge variant="outline" className="text-[10px]">{e.event.impact}</Badge>
                      <span className="text-muted-foreground">{Math.round(e.minutesUntil)}m</span>
                    </li>))}</ul>}
            </CardContent></Card>

          {!h.mt5BridgeConnected && <Badge className="bg-purple-500/20 text-purple-400">MT5 bridge deferred — quotes are not broker-executable</Badge>}
        </>
      )}
    </div>
  );
}
