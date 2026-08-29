import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LiveTradeTicket } from "@/components/live/LiveTradeTicket";
import { AlertTriangle, RefreshCw, Sparkles } from "lucide-react";
import { SymbolExplorer } from "@/components/scanner/SymbolExplorer";
import { TradabilityBadge } from "@/components/live/TradabilityBadge";
import { useChartSymbol, bareSymbol, setChartSymbol } from "@/lib/use-chart-symbol";
import { resolveSymbol } from "@/lib/symbolRegistry";
import { useScannerTruth } from "@/hooks/useScannerTruth";
import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import { toApiTimeframe } from "@/lib/chartCandlesQuery";
import { resolveTradeAffordance } from "@/lib/trade-affordance";
import { resolveSelectedMarketView } from "@/components/scanner/selectedMarketView";
import { RubyReasoningBlock } from "@/components/ruby/RubyReasoningBlock";
import { buildReasoningFromOppMap } from "@/lib/rubyReasoningBlock";
import { useAssistantName } from "@/lib/assistant-name";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type ImpactLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type Bias = "BUY" | "SELL" | "NEUTRAL" | "WAIT";

interface SelectedMarketEvent {
  externalId: string;
  title: string;
  currency: string;
  impactLevel: ImpactLevel;
  eventTime: string;
  minutesUntil: number;
}

type DataState = "LIVE_CONFIRMED" | "SYNCING" | "STALE" | "UNAVAILABLE";

interface SnapshotOk {
  ok: true;
  symbolRaw: string;
  symbol: string;
  timeframe: string;
  highlights: {
    bias: Bias;
    confidenceLabel: string;
    /** Canonical name; the server dual-emits both fields with the same value. */
    signalStrength?: number;
    /** @deprecated Alias of `signalStrength`. */
    confidenceScore: number;
    volatilityLabel: string;
    trendState: string;
    // Levels are withheld (null) when the stale-level guard fires or the feed
    // has no confirmed candles — never rendered as numbers in those states.
    entryZone: { low: number; high: number } | null;
    suggestedStop: number | null;
    suggestedTakeProfit: number | null;
    riskRewardRatio: number;
    riskWarnings: string[];
  };
  explanation: {
    hedge: string;
    why: string;
    whyItMatters: string;
    risk: string;
    invalidation: string;
    cautions: string[];
    disclaimer: string;
  };
  upcomingEvents: SelectedMarketEvent[];
  newsRisk: { riskLevel: string; blockTrading: boolean; summary: string };
  // Additive truth fields (Task #518). dataAsOf = the DATA timestamp (newest
  // confirmed candle), distinct from generatedAt (analysis build time).
  dataSource?: string;
  dataSourceLabel?: string | null;
  dataState?: DataState;
  dataAsOf?: string | null;
  levelsWithheld?: boolean;
  levelsWithheldReason?: string | null;
  generatedAt: string;
  cacheHit: boolean;
}

interface SnapshotUnavailable {
  ok: false;
  symbol?: string;
  reason?: string;
  message: string;
}

type Snapshot = SnapshotOk | SnapshotUnavailable;

function biasBadgeClass(b: Bias): string {
  if (b === "BUY") return "bg-success/20 text-success border-success/40";
  if (b === "SELL") return "bg-danger/20 text-danger border-danger/40";
  if (b === "WAIT") return "bg-warning/20 text-warning border-warning/40";
  return "bg-muted/60 text-foreground border-border";
}
function impactBadgeClass(i: ImpactLevel): string {
  if (i === "CRITICAL") return "bg-premium/20 text-premium border-premium/40";
  if (i === "HIGH") return "bg-danger/10 text-danger border-danger/25";
  if (i === "MEDIUM") return "bg-warning/10 text-warning border-warning/25";
  return "bg-muted/60 text-foreground border-border";
}

function timeAgo(iso: string): string {
  const diff = Math.max(0, Date.now() - +new Date(iso));
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

export function SelectedMarketPanel() {
  // Bridge with the app-wide chart symbol bus. Selecting a symbol here
  // immediately updates chart / trade ticket / Ruby context everywhere.
  const [chartSym] = useChartSymbol();
  const { name } = useAssistantName();
  const initial = (() => {
    const bare = bareSymbol(chartSym || "EURUSD").toUpperCase();
    return resolveSymbol(bare)?.canonicalSymbol ?? "EURUSD";
  })();
  const [activeSymbol, setActiveSymbol] = useState(initial);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ticketSide, setTicketSide] = useState<"BUY" | "SELL">("BUY");

  // Listen for external symbol changes (chart, ticket, Ruby chat) and
  // mirror them into this panel.
  useEffect(() => {
    const bare = bareSymbol(chartSym || "").toUpperCase();
    if (!bare) return;
    const hit = resolveSymbol(bare);
    if (hit && hit.canonicalSymbol !== activeSymbol) setActiveSymbol(hit.canonicalSymbol);
  }, [chartSym, activeSymbol]);

  // Compact public Deriv status — drives the "Deriv feed not configured"
  // badge in SymbolExplorer. Synthetics stay selectable either way.
  // The status endpoint is auth-gated (per-user session). A 401 / network
  // failure means the status is UNKNOWN — it must NEVER be rendered as
  // "Deriv feed not configured" (that false badge made a healthy feed look
  // broken). Only an explicit `configured:false` payload means unconfigured.
  const derivStatus = useQuery<{
    configured?: boolean; connected?: boolean; status?: string; statusKnown?: boolean;
  }>({
    queryKey: ["deriv-status"],
    queryFn: async () => {
      try {
        const r = await fetch(`${BASE}/api/market-data/deriv/status`, { credentials: "include" });
        if (!r.ok) return { statusKnown: false };
        return { statusKnown: true, ...(await r.json()) };
      } catch { return { statusKnown: false }; }
    },
    refetchOnWindowFocus: false,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
  const derivStatusKnown = derivStatus.data?.statusKnown === true;
  const derivConfigured = derivStatus.data?.configured !== false;
  const derivConnected = derivStatusKnown && derivStatus.data?.connected === true;
  // Only claim "connecting" when we actually KNOW the status; unknown status
  // renders no feed note at all (synthetics stay selectable either way).
  const derivConnecting = derivStatusKnown && derivConfigured && !derivConnected;

  // Active scanner timeframe (e.g. "15m"), normalized to the backend candles
  // enum (e.g. "M15"). The analysis must match the timeframe the user's chart
  // is on, so it flows into BOTH the fetch URL and the react-query key.
  const [scannerTf] = useScannerTimeframe();
  const apiTf = toApiTimeframe(scannerTf);

  const enabled = activeSymbol.length > 0;
  const q = useQuery<Snapshot>({
    queryKey: ["scanner", "selected-market", activeSymbol, apiTf],
    queryFn: async () => {
      const r = await fetch(
        `${BASE}/api/market-scanner/selected-market?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(apiTf)}`,
        { credentials: "include" },
      );
      return (await r.json()) as Snapshot;
    },
    enabled,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });

  // Shared scanner feed-truth for the focused symbol/timeframe — same source the
  // header strip and chart read. Drives an honest, NON-BLOCKING feed warning on
  // this panel and inside the live ticket it opens. Never gates the trade.
  const { truth: feedTruth } = useScannerTruth(activeSymbol, scannerTf);
  const liveAffordance = resolveTradeAffordance(feedTruth, "live");
  const liveFeedWarning = liveAffordance.warningTitle
    ? { warningTitle: liveAffordance.warningTitle, warningDetail: liveAffordance.warningDetail }
    : null;

  const refreshMutating = useState(false);
  const [refreshing, setRefreshing] = refreshMutating;
  async function manualRefresh() {
    if (!activeSymbol) return;
    setRefreshing(true);
    try {
      await fetch(
        `${BASE}/api/market-scanner/selected-market?symbol=${encodeURIComponent(activeSymbol)}&timeframe=${encodeURIComponent(apiTf)}&refresh=1`,
        { credentials: "include" },
      );
      await q.refetch();
    } finally {
      setRefreshing(false);
    }
  }

  /** Single point that switches global market focus. */
  function selectSymbol(canonical: string) {
    setActiveSymbol(canonical);
    // Broadcast to chart, trade ticket, Ruby context.
    setChartSymbol(canonical);
    // Scroll the explanation card into view on mobile.
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setTimeout(() => {
        document.querySelector('[data-testid="selected-market-panel"]')
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    }
  }

  const snap = q.data;
  // A snapshot only drives the full "ok" render path when it actually carries
  // the structural pieces that path reads (highlights + explanation). A
  // truthy-but-partial payload (ok:true but missing those) has historically
  // thrown into the route error boundary elsewhere in this app — here it must
  // degrade to the friendly fallback context card, never crash the panel.
  const ok =
    snap?.ok === true && snap.highlights != null && snap.explanation != null
      ? snap
      : null;
  // Anything with data that is NOT a complete ok snapshot → fallback context.
  // Covers ok:false AND the partial-ok payload that would otherwise crash.
  const fallback = snap != null && !ok ? snap : null;
  const fallbackSymbol = fallback?.symbol;
  const fallbackMessage =
    fallback && fallback.ok === false ? fallback.message : undefined;

  const rubyNote = useMemo(() => {
    if (!ok) return null;
    return `${ok.explanation.hedge} ${ok.explanation.why}`;
  }, [ok]);

  // ONE always-visible Ruby Reasoning Block for the selected/detail view.
  // Honesty: levelsWithheld / a degraded dataState collapse this to
  // WAIT/conditional with the limit stated in Feed/Data — never a fabricated
  // entry/stop/target. Display only; grants no execution permission.
  const oppReasoning = useMemo(() => {
    if (!ok) return null;
    return buildReasoningFromOppMap({
      symbol: ok.symbol,
      timeframe: ok.timeframe,
      bias: ok.highlights.bias,
      confidenceLabel: ok.highlights.confidenceLabel,
      trendState: ok.highlights.trendState,
      volatilityLabel: ok.highlights.volatilityLabel,
      entryZone: ok.highlights.entryZone ?? null,
      suggestedStop: ok.highlights.suggestedStop ?? null,
      suggestedTakeProfit: ok.highlights.suggestedTakeProfit ?? null,
      riskRewardRatio: ok.highlights.riskRewardRatio,
      riskWarnings: ok.highlights.riskWarnings ?? [],
      explanation: {
        hedge: ok.explanation.hedge,
        why: ok.explanation.why,
        whyItMatters: ok.explanation.whyItMatters,
        risk: ok.explanation.risk,
        invalidation: ok.explanation.invalidation,
        cautions: ok.explanation.cautions ?? [],
      },
      levelsWithheld: ok.levelsWithheld ?? undefined,
      levelsWithheldReason: ok.levelsWithheldReason ?? null,
      dataState: ok.dataState ?? null,
      dataSourceLabel: ok.dataSourceLabel ?? null,
      newsRiskLevel: ok.newsRisk?.riskLevel ?? null,
    });
  }, [ok]);

  return (
    <Card className="rounded-2xl border-success/25 bg-card" data-testid="selected-market-panel">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-success/15 text-success ring-1 ring-success/25">
            <Sparkles className="h-[18px] w-[18px]" />
          </span>
          <span>Pick a market — {name} explains it</span>
        </CardTitle>
        <div className="flex items-center gap-2 pt-2">
          <Badge variant="outline" className="font-mono" data-testid="badge-active-symbol">{activeSymbol}</Badge>
          <Button
            size="sm"
            variant="outline"
            onClick={manualRefresh}
            disabled={refreshing || !ok}
            data-testid="btn-refresh-symbol"
            className="ml-auto"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <div className="pt-2">
          <TradabilityBadge symbol={activeSymbol} />
        </div>
        <div className="pt-2">
          <SymbolExplorer
            activeSymbol={activeSymbol}
            derivFeedConfigured={derivConfigured}
            derivFeedConnected={derivConnected}
            derivFeedConnecting={derivConnecting}
            onSelect={(canonical) => selectSymbol(canonical)}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading && <div className="text-sm text-muted-foreground">Loading market…</div>}
        {fallback && (() => {
          // When the legacy scanner endpoint can't deliver a complete snapshot
          // (e.g. Deriv synthetics, fresh symbols, OR a truthy-but-partial
          // payload missing highlights/explanation), fall back to a friendly
          // registry-sourced card instead of the old "<SYMBOL> unavailable"
          // destructive alert. Trade panel and chart still use the selected
          // symbol normally.
          const reg = resolveSymbol(activeSymbol);
          if (reg) {
            return (
              <div
                className="rounded-xl border border-border bg-background/40 p-3 space-y-1"
                data-testid="selected-market-snapshot-pending"
              >
                <div className="flex items-center gap-2 text-sm">
                  <Sparkles className="h-4 w-4 text-success" />
                  <span className="font-semibold text-foreground">{reg.displayName}</span>
                  <Badge variant="outline" className="ml-auto uppercase text-[10px]">{reg.marketType}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {reg.canonicalSymbol} is loaded. {name} is checking whether this
                  market has a clean setup — she'll show the bias, risk, and
                  entry conditions before you decide.
                </p>
              </div>
            );
          }
          return (
            <Alert variant="destructive" data-testid="selected-market-unavailable">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{fallbackSymbol ? `${fallbackSymbol} unavailable` : "Symbol unavailable"}</AlertTitle>
              <AlertDescription>{fallbackMessage ?? "This market couldn't be analyzed right now."}</AlertDescription>
            </Alert>
          );
        })()}
        {ok && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{ok.symbol}</Badge>
              <Badge variant="outline">{ok.timeframe}</Badge>
              <Badge className={biasBadgeClass(ok.highlights.bias)}>{ok.highlights.bias}</Badge>
              <Badge variant="outline">{ok.highlights.confidenceLabel} confidence</Badge>
              <Badge variant="outline">Volatility {ok.highlights.volatilityLabel}</Badge>
              <Badge variant="outline">Trend {ok.highlights.trendState}</Badge>
              {ok.dataSourceLabel && (
                <Badge variant="outline" data-testid="badge-data-source">{ok.dataSourceLabel}</Badge>
              )}
              <span className="ml-auto" data-testid="text-selected-last-updated">
                {ok.dataAsOf
                  ? `Data as of ${timeAgo(ok.dataAsOf)}`
                  : "Awaiting live market data"}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground -mt-1" data-testid="text-ruby-cache-note">
              {ok.dataAsOf
                ? `Analysis built ${timeAgo(ok.generatedAt)}${ok.cacheHit ? " · cached" : ""}. `
                : ""}
              {name} Market Intelligence uses cached market analysis and updates on interval/event triggers (no live AI/LLM call per refresh).
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-xl border border-border bg-background/40 p-3">
                <div className="text-xs font-semibold mb-2 text-foreground">Highlights</div>
                {(() => {
                  const view = resolveSelectedMarketView(ok);
                  if (view.kind === "levels") {
                    const l = view.levels;
                    return (
                      <dl className="text-xs space-y-1" data-testid="selected-market-levels">
                        <div className="flex justify-between"><dt className="text-txt-muted">Entry zone</dt>
                          <dd className="font-mono">{l.entryLow} – {l.entryHigh}</dd></div>
                        <div className="flex justify-between"><dt className="text-txt-muted">Suggested stop</dt>
                          <dd className="font-mono">{l.stop}</dd></div>
                        <div className="flex justify-between"><dt className="text-txt-muted">Possible target</dt>
                          <dd className="font-mono">{l.target}</dd></div>
                        <div className="flex justify-between"><dt className="text-txt-muted">Risk : reward</dt>
                          <dd className="font-mono">1 : {l.riskReward}</dd></div>
                      </dl>
                    );
                  }
                  return (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid={view.kind === "waiting" ? "selected-market-levels-waiting" : "selected-market-levels-withheld"}
                    >
                      {view.kind === "waiting"
                        ? "Waiting for a confirmed live feed before showing entry, stop, and target."
                        : view.reason}
                    </p>
                  );
                })()}
                {(ok.highlights.riskWarnings ?? []).length > 0 && (
                  <div className="mt-2 text-xs text-danger">
                    {(ok.highlights.riskWarnings ?? []).map((w, i) => (<div key={i}>⚠ {w}</div>))}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-border bg-background/40 p-3">
                <div className="text-xs font-semibold mb-2 text-foreground">{name}'s read</div>
                {oppReasoning && (
                  <RubyReasoningBlock data={oppReasoning} testid="opp-map-reasoning" dense />
                )}
                <p className="text-[10px] italic text-muted-foreground mt-2">{ok.explanation.disclaimer}</p>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-background/40 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-foreground">Upcoming events that may move {ok.symbol}</div>
                <Badge variant="outline" className="text-[10px]">News risk: {ok.newsRisk?.riskLevel ?? "—"}</Badge>
              </div>
              {(ok.upcomingEvents ?? []).length === 0
                ? <div className="text-xs text-muted-foreground">No medium/high impact events in the next 24h.</div>
                : (
                  <ul className="text-xs space-y-1">
                    {(ok.upcomingEvents ?? []).map((e) => (
                      <li key={e.externalId} className="flex items-center gap-2">
                        <Badge className={impactBadgeClass(e.impactLevel)}>{e.impactLevel}</Badge>
                        <span className="font-mono text-txt-muted">{e.currency}</span>
                        <span className="flex-1 truncate">{e.title}</span>
                        <span className="text-txt-muted">{e.minutesUntil >= 0 ? `in ${e.minutesUntil}m` : `${-e.minutesUntil}m ago`}</span>
                      </li>
                    ))}
                  </ul>
                )}
              {ok.newsRisk?.summary && (
                <div className="text-xs mt-2 text-warning">{ok.newsRisk.summary}</div>
              )}
            </div>

            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                <Button
                  className="bg-success hover:bg-success/90 text-white font-bold h-11 text-base sm:flex-1 sm:min-w-[120px]"
                  onClick={() => { setTicketSide("BUY"); setTicketOpen(true); }}
                  data-testid="btn-open-ticket-buy"
                >BUY</Button>
                <Button
                  className="bg-danger hover:bg-danger/90 text-white font-bold h-11 text-base sm:flex-1 sm:min-w-[120px]"
                  onClick={() => { setTicketSide("SELL"); setTicketOpen(true); }}
                  data-testid="btn-open-ticket-sell"
                >SELL</Button>
              </div>
              {liveFeedWarning && (
                <p className="text-[11px] text-warning flex items-start gap-1.5" data-testid="selected-market-feed-warning">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                  <span><strong>{liveFeedWarning.warningTitle}.</strong> {liveFeedWarning.warningDetail}</span>
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                Trade ticket runs every server safety gate before any order is placed.
              </p>
            </div>
          </>
        )}
      </CardContent>

      {ok && (
        <LiveTradeTicket
          open={ticketOpen}
          onOpenChange={setTicketOpen}
          defaultSymbol={ok.symbol}
          defaultSide={ticketSide}
          sourcePage="SCANNER_SELECTED_MARKET"
          rubyExplanationSummary={rubyNote}
          feedWarning={liveFeedWarning}
        />
      )}
    </Card>
  );
}
