import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Activity, AlertTriangle, CandlestickChart, CheckCircle2, Database, HardDrive, Lock, RefreshCw, ShieldAlert } from "lucide-react";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

type AssetClass = "synthetic" | "forex" | "metals" | "indices" | "crypto" | "stocks" | "unknown";

interface SecretMask { envKey: string; configured: boolean; lastFourMasked: string | null }
interface ProviderEntry {
  id: string;
  name: string;
  category: "broker" | "synthetic" | "market_data" | "news" | "ai";
  secretEnvKeys: string[];
  configured: boolean;
  secretMasks: SecretMask[];
  usedBy: string[];
  selectedForAssetClasses: AssetClass[];
  configuredButUnused: boolean;
  status: "healthy" | "degraded" | "failing" | "not_configured" | "reserved";
  statusReason: string;
  features: { liveQuote: boolean; historicalCandles: boolean; news: boolean; symbolSearch: boolean };
  rateLimitNote: string | null;
  lastSelfTestAt: string | null;
  lastSelfTestMs: number | null;
  lastSelfTestOk: boolean | null;
}
interface ProbeLeg {
  ok: boolean;
  primaryProvider: string | null;
  candleCount?: number;
  attempts: Array<{ provider: string; ok: boolean; reason: string | null; ms: number }>;
  userMessage: string;
  adminDetail: string;
}
interface SymbolProbe {
  symbol: string;
  assetClass: AssetClass;
  timeframe: string;
  candles: ProbeLeg & { candleCount: number };
  quote: ProbeLeg;
}
interface FeedsHealth {
  mt5: {
    heartbeat: {
      present: boolean;
      status: "live" | "stale" | "offline" | "none";
      ageSec: number | null;
      eaVersion: string | null;
      accountType: string | null;
      masterLiveCapable: boolean;
      blockReason: string | null;
    };
    quotePush: { active: boolean; symbolsWithFreshQuote: number; symbolsProbed: number; note: string };
    candlePush: { active: boolean; totalSeries: number; contributing: number; stale: number; nonContributing: number };
  };
  deriv: { configured: boolean; connected: boolean; healthSummary: string; feedReadinessState: string; lastTickAt: string | null; message: string };
  assistant: {
    provider: string;
    connected: boolean;
    configured: boolean;
    freshnessState: string;
    dataFreshness: string | null;
    dataSource: string | null;
    lastSuccessfulFetchAt: string | null;
    lastErrorAt: string | null;
    unavailableReason: string | null;
  };
  economicCalendar: {
    connected: boolean;
    provider: string;
    eventCount: number;
    configured: boolean;
    lastFetchAt: string | null;
    lastErrorAt: string | null;
    lastErrorMessage: string | null;
    freshnessStatus: "fresh" | "stale" | "unavailable";
  };
}
interface AssetClassActivity {
  assetClass: AssetClass;
  representativeSymbol: string;
  latestCandleProvider: string | null;
  latestQuoteProvider: string | null;
  lastCandleTime: string | null;
  lastQuoteTime: string | null;
  aiUsable: boolean;
  feedQuality: string;
  staleReason: string | null;
  fallbackReason: string | null;
}
interface ActiveConsumer { consumer: string; providers: string[] }
interface Snapshot {
  generatedAt: string;
  routerChains: Record<string, string[]>;
  providers: ProviderEntry[];
  symbolProbes: SymbolProbe[];
  feeds: FeedsHealth;
  assetClassActivity: AssetClassActivity[];
  activeConsumers: ActiveConsumer[];
  summary: {
    totalProviders: number;
    healthy: number;
    degraded: number;
    failing: number;
    notConfigured: number;
    reserved: number;
    configuredButUnused: number;
  };
}

type Mt5SeriesStatus = "contributing" | "stale" | "non-contributing" | "unavailable";
interface Mt5SeriesEntry {
  symbol: string;
  timeframe: string;
  status: Mt5SeriesStatus;
  barCount: number;
  ageMs: number | null;
  updatedAt: string | null;
}
interface Mt5FeedResponse {
  ok: boolean;
  feedActive: boolean;
  providerConnected: boolean;
  summary: {
    totalSeries: number;
    contributing: number;
    stale: number;
    nonContributing: number;
    unavailable: number;
  };
  series: Mt5SeriesEntry[];
  note: string;
}

function statusBadge(s: ProviderEntry["status"]) {
  switch (s) {
    case "healthy":        return <Badge className="bg-success/20 text-success">healthy</Badge>;
    case "degraded":       return <Badge className="bg-warning/20 text-warning">degraded</Badge>;
    case "failing":        return <Badge className="bg-danger/20 text-danger">failing</Badge>;
    case "not_configured": return <Badge className="bg-secondary/20 text-txt-secondary">not configured</Badge>;
    case "reserved":       return <Badge className="bg-primary/20 text-primary">reserved</Badge>;
  }
}

function mt5SeriesBadge(s: Mt5SeriesStatus) {
  switch (s) {
    case "contributing":     return <Badge className="bg-success/20 text-success">contributing</Badge>;
    case "stale":            return <Badge className="bg-warning/20 text-warning">stale</Badge>;
    case "non-contributing": return <Badge className="bg-secondary/30 text-txt-secondary">non-contributing</Badge>;
    case "unavailable":      return <Badge className="bg-secondary/20 text-txt-secondary">unavailable</Badge>;
  }
}

function feedStatusCls(s: "live" | "stale" | "offline" | "none"): string {
  switch (s) {
    case "live":    return "bg-success/20 text-success";
    case "stale":   return "bg-warning/20 text-warning";
    case "offline": return "bg-danger/20 text-danger";
    case "none":    return "bg-secondary/20 text-txt-secondary";
  }
}

function qualityCls(q: string): string {
  switch (q) {
    case "clean":   return "bg-success/20 text-success";
    case "delayed": return "bg-warning/20 text-warning";
    case "stale":   return "bg-danger/20 text-danger";
    default:        return "bg-secondary/20 text-txt-secondary";
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString();
}

function fmtAge(ageMs: number | null): string {
  if (ageMs == null || !Number.isFinite(ageMs)) return "—";
  if (ageMs < 1000) return "just now";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

// Compact UTC date+time (minute precision) for broker-candle oldest/newest,
// which can span days — a time-only label would be ambiguous.
function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16);
}

type BackfillStatus = "NOT_STARTED" | "BUILDING" | "PARTIAL" | "COMPLETE" | "BROKER_LIMITED" | "ERROR";

function backfillBadge(s: BackfillStatus) {
  switch (s) {
    case "COMPLETE":       return <Badge className="bg-success/20 text-success">COMPLETE</Badge>;
    case "BUILDING":       return <Badge className="bg-primary/20 text-primary">BUILDING</Badge>;
    case "PARTIAL":        return <Badge className="bg-warning/20 text-warning">PARTIAL</Badge>;
    case "BROKER_LIMITED": return <Badge className="bg-secondary/30 text-txt-secondary">BROKER_LIMITED</Badge>;
    case "ERROR":          return <Badge className="bg-danger/20 text-danger">ERROR</Badge>;
    case "NOT_STARTED":    return <Badge className="bg-secondary/20 text-txt-secondary">NOT_STARTED</Badge>;
  }
}

interface BrokerCoverageRow {
  userId: number;
  bridgeConnectionId: number;
  brokerSymbol: string;
  symbol: string;
  timeframe: string;
  status: BackfillStatus;
  statusReason: string | null;
  oldestStoredAt: string | null;
  newestStoredAt: string | null;
  barsStored: number;
  targetDays: number | null;
  coverageDays: number | null;
  retryCount: number;
  lastError: string | null;
  lastIngestAt: string | null;
  updatedAt: string | null;
  mirroredCacheBars: number;
  mirroredNewestAt: string | null;
  mirroredLastWriteAt: string | null;
}
interface BrokerCoverage {
  rows: BrokerCoverageRow[];
  statusCounts: Record<BackfillStatus, number>;
  totalSeries: number;
  totalBarsStored: number;
  totalMirroredCacheBars: number;
}
interface BrokerCoverageResponse {
  ok: boolean;
  coverage: BrokerCoverage;
}

// Broker price-history coverage — per-series durable broker_candles depth and
// backfill state (Task #472). Reads the admin-only
// GET /api/admin/market-data/broker-candles endpoint, which reports exactly
// what the EA has pushed into the durable store + how many bars are mirrored
// into the router-read cache slot. Read-only market-data telemetry — never an
// execution surface. Optional symbol filter mirrors the candle-depth probe UX.
function BrokerCandleCoverageCard() {
  const [symbol, setSymbol] = useState("");
  const [data, setData] = useState<BrokerCoverage | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setBusy(true); setErr(null);
    try {
      const q = symbol.trim() ? `?symbol=${encodeURIComponent(symbol.trim())}` : "";
      const r = await fetch(`${BASE}/api/admin/market-data/broker-candles${q}`, {
        credentials: "include",
        headers: { "x-security-role": "ADMIN" },
      });
      if (!r.ok) {
        const t = await r.text();
        setErr(`HTTP ${r.status}: ${t.slice(0, 240)}`);
        return;
      }
      const j = (await r.json()) as BrokerCoverageResponse;
      if (!j.ok) setErr("Unknown error");
      else setData(j.coverage);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  const ORDER: BackfillStatus[] = ["NOT_STARTED", "BUILDING", "PARTIAL", "COMPLETE", "BROKER_LIMITED", "ERROR"];
  const STATUS_TILE_CLS: Record<BackfillStatus, string> = {
    NOT_STARTED: "bg-secondary/20 text-txt-secondary",
    BUILDING: "bg-primary/20 text-primary",
    PARTIAL: "bg-warning/20 text-warning",
    COMPLETE: "bg-success/20 text-success",
    BROKER_LIMITED: "bg-secondary/30 text-txt-secondary",
    ERROR: "bg-danger/20 text-danger",
  };

  return (
    <Card data-testid="card-broker-candle-coverage">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <HardDrive className="h-4 w-4" />
          Broker price-history coverage
          <Badge variant="outline" className="font-mono text-[10px]">read-only</Badge>
          <span className="ml-auto flex items-center gap-2">
            <Input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void load(); }}
              placeholder="Filter symbol (optional)"
              className="w-52 h-8 font-mono text-xs"
              data-testid="input-broker-coverage-symbol"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void load()}
              disabled={busy}
              data-testid="btn-refresh-broker-coverage"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${busy ? "animate-spin" : ""}`} />
              {busy ? "Loading…" : "Refresh"}
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {err && (
          <Alert variant="destructive" data-testid="alert-broker-coverage-err">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Failed to load broker price-history coverage</AlertTitle>
            <AlertDescription className="font-mono text-xs">{err}</AlertDescription>
          </Alert>
        )}

        {data && (
          <>
            {/* Per-backfill-status summary */}
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              {ORDER.map((s) => (
                <div key={s} className="border border-border/40 rounded p-2" data-testid={`broker-status-${s}`}>
                  <div className="text-[11px] text-muted-foreground">{s}</div>
                  <div className={`mt-1 inline-block rounded px-2 py-0.5 text-sm font-mono ${STATUS_TILE_CLS[s]}`}>
                    {data.statusCounts[s] ?? 0}
                  </div>
                </div>
              ))}
            </div>

            <div className="text-[11px] text-muted-foreground font-mono">
              {data.totalSeries} series · {data.totalBarsStored.toLocaleString()} bars stored ·{" "}
              {data.totalMirroredCacheBars.toLocaleString()} bars mirrored into the router cache slot
            </div>

            {data.rows.length === 0 ? (
              <Alert variant="default" className="border-border/40" data-testid="empty-broker-coverage">
                <HardDrive className="h-4 w-4" />
                <AlertTitle>No broker history stored yet</AlertTitle>
                <AlertDescription>
                  {symbol.trim()
                    ? `No durable broker candles found for "${symbol.trim().toUpperCase()}".`
                    : "The EA candle-history producer (v1.51+) has not pushed any bars into the durable broker_candles store yet. Until it does, the chart/scanner read path falls through to its other providers."}
                </AlertDescription>
              </Alert>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left py-1 pr-3">Symbol</th>
                      <th className="text-left py-1 pr-3">TF</th>
                      <th className="text-left py-1 pr-3">Status</th>
                      <th className="text-right py-1 pr-3">Bars</th>
                      <th className="text-right py-1 pr-3">Coverage</th>
                      <th className="text-left py-1 pr-3">Oldest</th>
                      <th className="text-left py-1 pr-3">Newest</th>
                      <th className="text-right py-1 pr-3">Mirrored</th>
                      <th className="text-right py-1">Last ingest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => {
                      const lastIngestAgeMs = r.lastIngestAt
                        ? Date.now() - new Date(r.lastIngestAt).getTime()
                        : null;
                      return (
                        <tr
                          key={`${r.bridgeConnectionId}:${r.brokerSymbol}:${r.timeframe}`}
                          className="border-t border-border/40 align-top"
                          data-testid={`broker-coverage-${r.symbol}-${r.timeframe}`}
                        >
                          <td className="py-1 pr-3 font-mono font-semibold">
                            {r.symbol}
                            {r.brokerSymbol && r.brokerSymbol !== r.symbol && (
                              <div className="text-[10px] text-muted-foreground">{r.brokerSymbol}</div>
                            )}
                          </td>
                          <td className="py-1 pr-3 font-mono">{r.timeframe}</td>
                          <td className="py-1 pr-3">
                            {backfillBadge(r.status)}
                            {r.statusReason && (
                              <div className="text-[10px] text-muted-foreground">{r.statusReason}</div>
                            )}
                            {r.lastError && (
                              <div className="text-[10px] text-danger" title={r.lastError}>err: {r.lastError}</div>
                            )}
                          </td>
                          <td className="py-1 pr-3 text-right font-mono">{r.barsStored.toLocaleString()}</td>
                          <td className="py-1 pr-3 text-right font-mono">
                            {r.coverageDays != null ? r.coverageDays.toFixed(0) : "—"}
                            <span className="text-muted-foreground">/{r.targetDays ?? "—"}d</span>
                          </td>
                          <td className="py-1 pr-3 font-mono text-muted-foreground">{fmtDateTime(r.oldestStoredAt)}</td>
                          <td className="py-1 pr-3 font-mono text-muted-foreground">{fmtDateTime(r.newestStoredAt)}</td>
                          <td className="py-1 pr-3 text-right font-mono">
                            {r.mirroredCacheBars.toLocaleString()}
                          </td>
                          <td className="py-1 text-right font-mono text-muted-foreground">{fmtAge(lastIngestAgeMs)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground italic">
              Durable broker_candles store (per bridge / broker symbol / timeframe). "Mirrored" is how
              many bars are present in the router-read cache slot the chart/scanner prefer when fresh +
              sufficient. Read-only market-data telemetry — never an execution path.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// MT5 Candle Feed — dedicated panel showing per-symbol/timeframe contribution
// status from the EA candle feed. Polls every 30s while the tab is open so
// operators can see at a glance which series are live from the EA without
// reaching for curl. Empty-state guides the operator to the EA contract doc.
function Mt5CandleFeedCard() {
  const [feed, setFeed] = useState<Mt5FeedResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${BASE}/api/admin/market-data/mt5-feed`, {
        credentials: "include",
        headers: { "x-security-role": "ADMIN" },
      });
      if (!r.ok) {
        const t = await r.text();
        setErr(`HTTP ${r.status}: ${t.slice(0, 240)}`);
        return;
      }
      const j = (await r.json()) as Mt5FeedResponse;
      if (!j.ok) setErr("Unknown error");
      else setFeed(j);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    // Auto-refresh every 30s while the admin tab is open. The interval is
    // paused by the browser when the tab is hidden (timers are throttled),
    // and torn down on unmount.
    const id = window.setInterval(() => { void load(); }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <Card data-testid="card-mt5-candle-feed">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <CandlestickChart className="h-4 w-4" />
          MT5 Candle Feed
          {feed && (
            <Badge
              className={feed.feedActive ? "bg-success/20 text-success" : "bg-secondary/20 text-txt-secondary"}
              data-testid="badge-mt5-feed-active"
            >
              {feed.feedActive ? "feed connected" : "feed offline"}
            </Badge>
          )}
          <span className="ml-auto flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground font-normal">auto-refresh 30s</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void load()}
              disabled={busy}
              data-testid="btn-refresh-mt5-feed"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${busy ? "animate-spin" : ""}`} />
              {busy ? "Loading…" : "Refresh"}
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {err && (
          <Alert variant="destructive" data-testid="alert-mt5-feed-err">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Failed to load MT5 candle feed</AlertTitle>
            <AlertDescription className="font-mono text-xs">{err}</AlertDescription>
          </Alert>
        )}

        {feed && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {[
                ["Total series", feed.summary.totalSeries, "bg-secondary/20 text-foreground"],
                ["Contributing", feed.summary.contributing, "bg-success/20 text-success"],
                ["Stale", feed.summary.stale, "bg-warning/20 text-warning"],
                ["Non-contributing", feed.summary.nonContributing, "bg-secondary/30 text-txt-secondary"],
                ["Unavailable", feed.summary.unavailable, "bg-secondary/20 text-txt-secondary"],
              ].map(([label, val, cls]) => (
                <div key={label as string} className="border border-border/40 rounded p-2">
                  <div className="text-[11px] text-muted-foreground">{label}</div>
                  <div className={`mt-1 inline-block rounded px-2 py-0.5 text-sm font-mono ${cls}`}>{String(val)}</div>
                </div>
              ))}
            </div>

            {feed.series.length === 0 ? (
              <Alert variant="default" className="border-border/40" data-testid="empty-mt5-feed">
                <CandlestickChart className="h-4 w-4" />
                <AlertTitle>EA hasn't sent candles yet</AlertTitle>
                <AlertDescription>
                  No symbol/timeframe series have been pushed since the server started. The router
                  falls through to Deriv / the assistant composite until the EA sends its first
                  sync-candles payload. See <span className="font-mono">EA_CANDLE_CONTRACT.md</span>.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left py-1 pr-3">Symbol</th>
                      <th className="text-left py-1 pr-3">Timeframe</th>
                      <th className="text-left py-1 pr-3">Status</th>
                      <th className="text-right py-1 pr-3">Bars</th>
                      <th className="text-right py-1">Last push</th>
                    </tr>
                  </thead>
                  <tbody>
                    {feed.series.map((s) => (
                      <tr
                        key={`${s.symbol}:${s.timeframe}`}
                        className="border-t border-border/40"
                        data-testid={`mt5-series-${s.symbol}-${s.timeframe}`}
                      >
                        <td className="py-1 pr-3 font-mono font-semibold">{s.symbol}</td>
                        <td className="py-1 pr-3 font-mono">{s.timeframe}</td>
                        <td className="py-1 pr-3">{mt5SeriesBadge(s.status)}</td>
                        <td className="py-1 pr-3 text-right font-mono">{s.barCount}</td>
                        <td className="py-1 text-right font-mono text-muted-foreground">{fmtAge(s.ageMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground italic">{feed.note}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function ProviderHealthPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${BASE}/api/admin/providers/health`, {
        credentials: "include",
        headers: { "x-security-role": "ADMIN" },
      });
      if (!r.ok) {
        const t = await r.text();
        setErr(`HTTP ${r.status}: ${t.slice(0, 240)}`);
        return;
      }
      const j = await r.json();
      if (!j.ok) setErr(j.message ?? j.error ?? "Unknown error");
      else setSnap(j.snapshot as Snapshot);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <div className="space-y-4 p-1" data-testid="page-admin-provider-health">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="h-6 w-6 text-primary" />
            Provider Health
          </h1>
          <p className="text-sm text-muted-foreground">
            Sanitized inventory of every market-data, news, broker, and AI provider, plus live
            self-tests routed through the unified market-data router. Never displays raw secrets.
          </p>
        </div>
        <Button onClick={() => void load()} disabled={busy} data-testid="btn-refresh-provider-health">
          <RefreshCw className={`h-4 w-4 mr-2 ${busy ? "animate-spin" : ""}`} />
          {busy ? "Probing…" : "Refresh"}
        </Button>
      </div>

      {err && (
        <Alert variant="destructive" data-testid="alert-provider-health-err">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load provider health</AlertTitle>
          <AlertDescription className="font-mono text-xs">{err}</AlertDescription>
        </Alert>
      )}

      {snap && (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-2 md:grid-cols-7 gap-2">
            {[
              ["Total", snap.summary.totalProviders, "bg-secondary/20 text-foreground"],
              ["Healthy", snap.summary.healthy, "bg-success/20 text-success"],
              ["Degraded", snap.summary.degraded, "bg-warning/20 text-warning"],
              ["Failing", snap.summary.failing, "bg-danger/20 text-danger"],
              ["Not configured", snap.summary.notConfigured, "bg-secondary/20 text-txt-secondary"],
              ["Reserved", snap.summary.reserved, "bg-primary/20 text-primary"],
              ["Configured but unused", snap.summary.configuredButUnused, "bg-fuchsia-500/20 text-fuchsia-300"],
            ].map(([label, val, cls]) => (
              <Card key={label as string} className="border-border/40">
                <CardContent className="py-3">
                  <div className="text-[11px] text-muted-foreground">{label}</div>
                  <div className={`mt-1 inline-block rounded px-2 py-0.5 text-sm font-mono ${cls}`}>{String(val)}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* MT5 candle feed health */}
          <Mt5CandleFeedCard />

          {/* Durable broker price-history coverage */}
          <BrokerCandleCoverageCard />

          {/* Live feed status — one honest row per upstream feed */}
          <Card data-testid="card-feeds-health">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="h-4 w-4" />
                Live feed status
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs">
              {/* MT5 heartbeat */}
              <div className="border border-border/40 rounded p-3 space-y-1" data-testid="feed-mt5-heartbeat">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">MT5 heartbeat</span>
                  <Badge className={feedStatusCls(snap.feeds.mt5.heartbeat.status)}>{snap.feeds.mt5.heartbeat.status}</Badge>
                </div>
                <div className="text-muted-foreground font-mono">
                  age {snap.feeds.mt5.heartbeat.ageSec == null ? "—" : `${snap.feeds.mt5.heartbeat.ageSec}s`}
                  {" · "}EA {snap.feeds.mt5.heartbeat.eaVersion ?? "—"}
                  {" · "}{snap.feeds.mt5.heartbeat.accountType ?? "—"}
                </div>
                <div className="text-muted-foreground">
                  master-live capable:{" "}
                  <span className={snap.feeds.mt5.heartbeat.masterLiveCapable ? "text-success" : "text-txt-secondary"}>
                    {snap.feeds.mt5.heartbeat.masterLiveCapable ? "yes" : "no"}
                  </span>
                  {snap.feeds.mt5.heartbeat.blockReason && (
                    <span className="font-mono"> — {snap.feeds.mt5.heartbeat.blockReason}</span>
                  )}
                </div>
              </div>

              {/* MT5 quote + candle push */}
              <div className="border border-border/40 rounded p-3 space-y-1" data-testid="feed-mt5-push">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">MT5 broker push</span>
                  <Badge className={snap.feeds.mt5.quotePush.active ? "bg-success/20 text-success" : "bg-secondary/20 text-txt-secondary"}>
                    quote {snap.feeds.mt5.quotePush.active ? "active" : "inactive"}
                  </Badge>
                  <Badge className={snap.feeds.mt5.candlePush.active ? "bg-success/20 text-success" : "bg-secondary/20 text-txt-secondary"}>
                    candle {snap.feeds.mt5.candlePush.active ? "active" : "inactive"}
                  </Badge>
                </div>
                <div className="text-muted-foreground font-mono">
                  quotes {snap.feeds.mt5.quotePush.symbolsWithFreshQuote}/{snap.feeds.mt5.quotePush.symbolsProbed}
                  {" · "}series {snap.feeds.mt5.candlePush.totalSeries}
                  {" · "}contrib {snap.feeds.mt5.candlePush.contributing}
                  {" · "}stale {snap.feeds.mt5.candlePush.stale}
                </div>
                <div className="text-muted-foreground italic">{snap.feeds.mt5.quotePush.note}</div>
              </div>

              {/* Deriv */}
              <div className="border border-border/40 rounded p-3 space-y-1" data-testid="feed-deriv">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">Deriv synthetic feed</span>
                  <Badge className={snap.feeds.deriv.connected ? "bg-success/20 text-success" : "bg-secondary/20 text-txt-secondary"}>
                    {snap.feeds.deriv.healthSummary}
                  </Badge>
                  <Badge className="bg-secondary/20 text-txt-secondary font-mono text-[10px]">{snap.feeds.deriv.feedReadinessState}</Badge>
                </div>
                <div className="text-muted-foreground font-mono">last tick {snap.feeds.deriv.lastTickAt ? fmtTime(snap.feeds.deriv.lastTickAt) : "—"}</div>
                <div className="text-muted-foreground italic">{snap.feeds.deriv.message}</div>
              </div>

              {/* Assistant composite */}
              <div className="border border-border/40 rounded p-3 space-y-1" data-testid="feed-assistant">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">Assistant market feed</span>
                  <Badge className={snap.feeds.assistant.connected ? "bg-success/20 text-success" : "bg-secondary/20 text-txt-secondary"}>
                    {snap.feeds.assistant.provider}
                  </Badge>
                  <Badge className="bg-secondary/20 text-txt-secondary font-mono text-[10px]">{snap.feeds.assistant.freshnessState}</Badge>
                </div>
                <div className="text-muted-foreground font-mono">
                  freshness {snap.feeds.assistant.dataFreshness ?? "—"}
                  {" · "}last ok {snap.feeds.assistant.lastSuccessfulFetchAt ? fmtTime(snap.feeds.assistant.lastSuccessfulFetchAt) : "—"}
                </div>
                {snap.feeds.assistant.unavailableReason && (
                  <div className="text-warning italic">{snap.feeds.assistant.unavailableReason}</div>
                )}
              </div>

              {/* Economic calendar */}
              <div className="border border-border/40 rounded p-3 space-y-1" data-testid="feed-calendar">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">Economic calendar</span>
                  <Badge className={snap.feeds.economicCalendar.connected ? "bg-success/20 text-success" : "bg-secondary/20 text-txt-secondary"}>
                    {snap.feeds.economicCalendar.connected ? "connected" : snap.feeds.economicCalendar.configured ? "key set / disconnected" : "not configured"}
                  </Badge>
                  <Badge className={
                    snap.feeds.economicCalendar.freshnessStatus === "fresh" ? "bg-success/20 text-success"
                    : snap.feeds.economicCalendar.freshnessStatus === "stale" ? "bg-warning/20 text-warning"
                    : "bg-secondary/20 text-txt-secondary"
                  }>
                    {snap.feeds.economicCalendar.freshnessStatus}
                  </Badge>
                </div>
                <div className="text-muted-foreground font-mono">
                  provider {snap.feeds.economicCalendar.provider}
                  {" · "}key {snap.feeds.economicCalendar.configured ? "configured" : "not set"}
                  {" · "}events {snap.feeds.economicCalendar.eventCount}
                </div>
                <div className="text-muted-foreground font-mono">
                  last fetch {snap.feeds.economicCalendar.lastFetchAt ? fmtTime(snap.feeds.economicCalendar.lastFetchAt) : "—"}
                  {snap.feeds.economicCalendar.lastErrorAt && (
                    <span className="ml-2 text-warning">· error {fmtTime(snap.feeds.economicCalendar.lastErrorAt)}</span>
                  )}
                </div>
                {snap.feeds.economicCalendar.lastErrorMessage && (
                  <div className="text-warning italic text-[10px]">{snap.feeds.economicCalendar.lastErrorMessage}</div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Per asset-class live activity */}
          <Card data-testid="card-asset-class-activity">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CandlestickChart className="h-4 w-4" />
                Per asset-class live activity
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto text-xs">
              {snap.assetClassActivity.length === 0 ? (
                <div className="text-muted-foreground italic">No asset-class activity resolved.</div>
              ) : (
                <table className="w-full">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left py-1 pr-3">Asset class</th>
                      <th className="text-left py-1 pr-3">Symbol</th>
                      <th className="text-left py-1 pr-3">Candle provider</th>
                      <th className="text-left py-1 pr-3">Quote provider</th>
                      <th className="text-left py-1 pr-3">Quality</th>
                      <th className="text-left py-1 pr-3">AI usable</th>
                      <th className="text-right py-1">Last candle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snap.assetClassActivity.map((a) => (
                      <tr key={a.assetClass} className="border-t border-border/40 align-top" data-testid={`activity-${a.assetClass}`}>
                        <td className="py-1 pr-3"><Badge className="bg-secondary/20 text-txt-secondary">{a.assetClass}</Badge></td>
                        <td className="py-1 pr-3 font-mono font-semibold">{a.representativeSymbol}</td>
                        <td className="py-1 pr-3 font-mono">
                          {a.latestCandleProvider ?? "—"}
                          {a.fallbackReason && <div className="text-[10px] text-warning">fallback: {a.fallbackReason}</div>}
                        </td>
                        <td className="py-1 pr-3 font-mono">{a.latestQuoteProvider ?? "—"}</td>
                        <td className="py-1 pr-3">
                          <Badge className={qualityCls(a.feedQuality)}>{a.feedQuality}</Badge>
                          {a.staleReason && <div className="text-[10px] text-warning">{a.staleReason}</div>}
                        </td>
                        <td className="py-1 pr-3">
                          <span className={a.aiUsable ? "text-success" : "text-txt-secondary"}>{a.aiUsable ? "yes" : "no"}</span>
                        </td>
                        <td className="py-1 text-right font-mono text-muted-foreground">{a.lastCandleTime ? fmtTime(a.lastCandleTime) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {/* Active consumers — inverse of provider.usedBy over live providers */}
          <Card data-testid="card-active-consumers">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Database className="h-4 w-4" />
                Active consumers (what each surface reads right now)
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
              {snap.activeConsumers.length === 0 ? (
                <div className="text-muted-foreground italic">No live providers — every surface is on a fallback or awaiting feed.</div>
              ) : (
                snap.activeConsumers.map((c) => (
                  <div key={c.consumer} className="font-mono flex gap-2 items-baseline" data-testid={`consumer-${c.consumer}`}>
                    <span className="w-28 text-muted-foreground">{c.consumer}:</span>
                    <span>{c.providers.join(", ")}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Router chains */}
          <Card data-testid="card-router-chains">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="h-4 w-4" />
                Unified market-data router — selected chain per asset class
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
              {Object.entries(snap.routerChains).map(([cls, chain]) => (
                <div key={cls} className="font-mono flex gap-2 items-baseline">
                  <span className="w-20 text-muted-foreground">{cls}:</span>
                  <span>{(chain as string[]).join("  →  ")}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Symbol probes */}
          <Card data-testid="card-symbol-probes">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" />
                Live self-tests via unified router
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {snap.symbolProbes.map((p) => (
                <div key={p.symbol} className="border border-border/40 rounded p-2" data-testid={`probe-${p.symbol}`}>
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
                    <div className="font-mono font-semibold">{p.symbol}</div>
                    <Badge className="bg-secondary/20 text-txt-secondary">{p.assetClass}</Badge>
                    <Badge className={p.candles.ok ? "bg-success/20 text-success" : "bg-danger/20 text-danger"}>
                      {p.candles.ok ? `candles OK (${p.candles.candleCount})` : "candles FAIL"}
                    </Badge>
                    <Badge className={p.quote.ok ? "bg-success/20 text-success" : "bg-danger/20 text-danger"}>
                      {p.quote.ok ? "quote OK" : "quote FAIL"}
                    </Badge>
                    <span className="text-muted-foreground">
                      via <span className="font-mono">{p.candles.primaryProvider ?? "none"}</span>
                    </span>
                  </div>
                  <div className="text-muted-foreground italic mb-1">{p.candles.userMessage}</div>
                  <details className="text-[11px]">
                    <summary className="cursor-pointer text-muted-foreground">Attempts (sanitized)</summary>
                    <div className="mt-1 font-mono space-y-0.5">
                      <div className="text-primary">candles:</div>
                      {p.candles.attempts.map((a, i) => (
                        <div key={i} className="ml-3">
                          {a.ok ? "✓" : "✗"} {a.provider} ({a.ms}ms){a.reason ? ` — ${a.reason}` : ""}
                        </div>
                      ))}
                      <div className="text-primary mt-1">quote:</div>
                      {p.quote.attempts.map((a, i) => (
                        <div key={i} className="ml-3">
                          {a.ok ? "✓" : "✗"} {a.provider} ({a.ms}ms){a.reason ? ` — ${a.reason}` : ""}
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Provider inventory */}
          <Card data-testid="card-provider-inventory">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Database className="h-4 w-4" />
                Provider inventory
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {snap.providers.map((p) => (
                <div key={p.id} className="border border-border/40 rounded p-3" data-testid={`provider-${p.id}`}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{p.name}</span>
                      <Badge className="bg-secondary/20 text-txt-secondary font-mono text-[10px]">{p.id}</Badge>
                      <Badge className="bg-secondary/20 text-txt-secondary text-[10px]">{p.category}</Badge>
                      {statusBadge(p.status)}
                      {p.configuredButUnused && (
                        <Badge className="bg-fuchsia-500/20 text-fuchsia-300">configured but unused</Badge>
                      )}
                    </div>
                    {p.lastSelfTestMs != null && (
                      <span className="text-[11px] text-muted-foreground font-mono">
                        last probe {p.lastSelfTestMs}ms {p.lastSelfTestOk ? "✓" : "✗"}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{p.statusReason}</div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px] mt-2">
                    <div>
                      <div className="text-muted-foreground mb-0.5">Selected for</div>
                      <div className="font-mono">{p.selectedForAssetClasses.length === 0 ? "—" : p.selectedForAssetClasses.join(", ")}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Used by</div>
                      <div className="font-mono">{p.usedBy.length === 0 ? "—" : p.usedBy.join(", ")}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5 flex items-center gap-1"><Lock className="h-3 w-3" />Secrets (sanitized)</div>
                      {p.secretMasks.length === 0
                        ? <div className="font-mono">no secret required</div>
                        : p.secretMasks.map((s) => (
                            <div key={s.envKey} className="font-mono">
                              {s.envKey}: {s.configured ? <span className="text-success">{s.lastFourMasked}</span> : <span className="text-txt-secondary">not set</span>}
                            </div>
                          ))}
                    </div>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-2">
                    Features:{" "}
                    {Object.entries(p.features).filter(([, v]) => v).map(([k]) => k).join(" · ") || "—"}
                    {p.rateLimitNote && <> · {p.rateLimitNote}</>}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="text-[10px] text-muted-foreground font-mono">
            generated {new Date(snap.generatedAt).toLocaleString()} — secrets never displayed; reasons truncated to 280 chars
          </div>
        </>
      )}
    </div>
  );
}
