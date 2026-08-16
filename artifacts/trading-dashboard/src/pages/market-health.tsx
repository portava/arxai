// Market Health — rebuilt on the live candle router.
//
// WHAT THIS PAGE USED TO SHOW
//   A composite "TRADEABLE" / "CAUTION" verdict from `/api/market/health`,
//   which is built entirely out of `marketSimulator.quote()` behind
//   `ACTIVE_PROVIDER = "SIMULATOR"` and a hardcoded
//   `MT5_BRIDGE_CONNECTED = false`. Every number on it — bid/ask, spread bps,
//   ATR, volatility ratio, session state, news events — was simulated, and the
//   page rendered a tradeability verdict from those simulated numbers to real
//   traders.
//
// WHAT IT SHOWS NOW
//   The SAME feed truth every other surface uses, via `useScannerTruth`, which
//   composes the one honest market query (GET /api/chart/candles) and resolves
//   it through the shared `resolveScannerTruth` contract. Scanner, chart,
//   Ruby reads and this page therefore cannot disagree about whether a feed is
//   live — there is one evaluator, not two.
//
//   The already-real "Market Data Provider" card (GET /api/me/market-data/status)
//   and its refresh action are kept unchanged: those were never simulated.
//
// WHAT WAS DROPPED, AND WHY
//   - Spread-bps / ATR / volatility-ratio / session cards: simulator-only, with
//     no live-router equivalent to rebuild them from. Showing nothing beats
//     showing invented values.
//   - The news-risk block: it read the same simulator. News risk now has its
//     own page on the real DB-backed pipeline; this page links there instead of
//     keeping a second, worse copy.
//   - The "MT5 bridge deferred" badge: it rendered a hardcoded constant.
//     `brokerFeedActive` below is derived from the real active candle source.
//
// Read-only: no trades, no mutation beyond the explicit provider refresh.

import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Activity, RefreshCw } from "lucide-react";

import { useScannerTruth } from "@/hooks/useScannerTruth";
import { FeedConfidenceBadge } from "@/components/charts/FeedConfidenceBadge";

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
  rateLimitStatus?: {
    limited: boolean;
    retryAfterMs: number | null;
    lastHitAt: string | null;
    source: "lastError" | "none";
  };
};

function freshnessBadgeColor(state: MarketDataStatus["freshnessState"]): string {
  switch (state) {
    case "FRESH": return "bg-emerald-500/80 text-white";
    case "STALE": return "bg-rose-500/80 text-white";
    case "ERROR": return "bg-rose-600 text-white";
    case "NEVER_FETCHED": return "bg-amber-500/70 text-white";
    case "UNAVAILABLE": return "bg-zinc-500/80 text-white";
    default: return "bg-zinc-500/80 text-white";
  }
}

/** Tone for a resolved data verdict. Only "Live" reads as good. */
function verdictColor(verdict: string): string {
  switch (verdict) {
    case "Live": return "bg-emerald-500/20 text-emerald-400";
    case "Delayed": return "bg-amber-500/20 text-amber-400";
    case "Stale": return "bg-rose-500/20 text-rose-400";
    case "Historical only": return "bg-zinc-500/20 text-zinc-300";
    default: return "bg-rose-500/20 text-rose-400";
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

function msAge(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

export default function MarketHealthPage() {
  const [symbol, setSymbol] = useState("EURUSD");
  const [tf, setTf] = useState("M15");
  const [mds, setMds] = useState<MarketDataStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);

  // The ONE honest feed source — the same hook the scanner and chart consume.
  const { truth, feedStatus, isLoading, isError, refetch } = useScannerTruth(symbol, tf);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch(`/api/me/market-data/status`, { credentials: "include" });
      if (!r.ok) { setMds(null); return; }
      const j = await r.json();
      setMds(j.status as MarketDataStatus);
    } catch { /* keep last */ }
  }, []);

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
      refetch();
    } catch (e) {
      setRefreshMessage(`Refresh error: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="page-market-health">
      <div className="flex items-center gap-3 flex-wrap">
        <Activity className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Market Health</h1>
          <p className="text-sm text-muted-foreground">
            Live feed truth for one symbol — the same verdict the scanner and chart use.
          </p>
        </div>
        <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className="w-32" aria-label="Symbol" />
        <Input value={tf} onChange={(e) => setTf(e.target.value.toUpperCase())} className="w-20" aria-label="Timeframe" />
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

      {isError && (
        <Card className="border-rose-500/40">
          <CardContent className="py-3 text-sm text-rose-300">
            Feed truth could not be read for {symbol}. Nothing is shown rather than a guessed verdict.
          </CardContent>
        </Card>
      )}

      {isLoading && !truth && <p className="text-sm text-muted-foreground">Loading feed truth…</p>}

      {truth && (
        <>
          <Card data-testid="card-feed-verdict">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex flex-wrap items-center gap-2">
                <span>{truth.symbolDisplay} {truth.timeframe}</span>
                <Badge className={verdictColor(truth.strip.data.verdict)} data-testid="badge-data-verdict">
                  {truth.strip.data.verdict}
                </Badge>
                <FeedConfidenceBadge feedStatus={feedStatus} />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <p className="text-muted-foreground">{truth.strip.data.detail}</p>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className="text-[10px]">
                  {truth.brokerFeedActive ? "Broker feed active" : "Not your broker's bars"}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {truth.isLivePrice ? "Live price" : "No live price"}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {truth.actionable ? "Valid for entry" : "Not valid for entry"}
                </Badge>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-3 md:grid-cols-3">
            <Card data-testid="card-quote-truth">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Quote</CardTitle></CardHeader>
              <CardContent className="text-xs space-y-1">
                <Row label="Source" value={truth.quote.sourceLabel} />
                <Row label="Bid / Ask" value={`${truth.quote.bid ?? "—"} / ${truth.quote.ask ?? "—"}`} />
                <Row label="Age" value={msAge(truth.quote.ageMs)} />
                <Row label="Status" value={truth.quote.status} />
                <p className="text-muted-foreground">{truth.quote.reason}</p>
              </CardContent>
            </Card>

            <Card data-testid="card-candle-truth">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Candles</CardTitle></CardHeader>
              <CardContent className="text-xs space-y-1">
                <Row label="Source" value={truth.candles.sourceLabel} />
                <Row label="Bars" value={`${truth.candles.count} / ${truth.candles.requestedCount}`} />
                <Row label="Min required" value={truth.candles.minRequired} />
                <Row label="Newest age" value={msAge(truth.candles.ageMs)} />
                <Row label="Status" value={truth.candles.status} />
                <p className="text-muted-foreground">{truth.candles.reason}</p>
              </CardContent>
            </Card>

            <Card data-testid="card-consistency-truth">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Quote vs candle</CardTitle></CardHeader>
              <CardContent className="text-xs space-y-1">
                <Row
                  label="Price delta"
                  value={truth.consistency.quoteCandlePriceDelta ?? "—"}
                />
                <Row
                  label="Delta %"
                  value={
                    truth.consistency.quoteCandlePriceDeltaPct != null
                      ? `${truth.consistency.quoteCandlePriceDeltaPct.toFixed(3)}%`
                      : "—"
                  }
                />
                <Row label="Status" value={truth.consistency.status} />
                <p className="text-muted-foreground">{truth.consistency.reason}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="py-3 text-xs text-muted-foreground">
              Spread, volatility and session panels were removed with the simulator that fed
              them — the live router exposes no equivalent, and invented numbers are worse
              than none. News risk has its own page on the real economic-calendar pipeline:{" "}
              <Link href="/news-risk" className="underline">News Risk</Link>.
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
