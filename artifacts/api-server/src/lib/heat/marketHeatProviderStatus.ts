// ── Market Heat provider-status normalizer (Task #611) ──────────────────────
//
// Turns the REAL provider seams (price router, news status, economic calendar)
// into the shared `MarketHeatSource` honesty shape. Fail-closed: anything we
// can't positively confirm as connected reports as not-connected. A missing
// provider here NEVER becomes fake neutral heat downstream.

import { getMarketStatus, getMarketProvider, providerResultFetchedAt } from "../assistant/marketProvider.js";
import { getEconomicCalendar } from "../news/economicCalendarProvider.js";
import { routeCandles } from "../data/marketDataRouter.js";
import { rawTrailingIntervalGap } from "../data/chart/candleNormalization.js";
import { normalizeChartTimeframe } from "../data/chart/timeframes.js";
import { classifyCandleFreshness } from "../data/freshness.js";
import { getDerivSymbolFeedStatus } from "../data/providers/derivProvider.js";
import {
  resolveNewsHonesty,
  deriveNewsRiskScore,
  selectTopNewsHeadlines,
  type MarketHeatSource,
  type MarketHeatEvent,
  type MarketHeatNewsHeadline,
  type NewsRiskItem,
} from "@workspace/domain/market-heat";

export interface NewsProviderRead {
  source: MarketHeatSource;
  connected: boolean;
  configured: boolean;
  itemCount: number;
  /** Severity + recency derived 0..1 risk magnitude (0 when not connected). */
  riskScore: number;
  /** Items matching a high-impact severity keyword (0 when not connected). */
  highImpactCount: number;
  /** Top severity-ranked headlines driving the risk (empty when not connected). */
  topHeadlines: MarketHeatNewsHeadline[];
  updatedAt: string | null;
  provider: string;
  freshness: "LIVE" | "DELAYED" | "STALE" | "UNAVAILABLE";
  apiKeyPresent: boolean;
  lastError: string | null;
}

export interface CalendarProviderRead {
  source: MarketHeatSource;
  connected: boolean;
  /** Last successful calendar fetch (ISO), null when not connected. */
  updatedAt: string | null;
  configured: boolean;
  eventCount: number;
  highImpactActive: boolean;
  provider: string;
  /** Real upcoming events — empty (never fabricated) when not connected. */
  events: MarketHeatEvent[];
}

/** Normalize the news provider into an honest heat source. */
export async function readNewsProvider(): Promise<NewsProviderRead> {
  const status = getMarketStatus();
  const configured = status.configured;
  const statusConnected = status.connected;

  // Live probe: never trust `status.connected` alone. A status that claims
  // connected but whose fetch fails / returns disconnected is NOT connected.
  let probeItemCount = 0;
  let probeConnected = false;
  let probeFailed = false;
  let probeItems: NewsRiskItem[] = [];
  let probeFetchedAt: string | null = null;
  if (statusConnected) {
    try {
      const news = await getMarketProvider().getMarketNews("markets", 12);
      probeConnected = news.connected;
      probeFetchedAt = news.connected ? providerResultFetchedAt(news) : null;
      probeItemCount = news.connected ? news.items.length : 0;
      probeItems = news.connected
        ? news.items.map((i) => ({
            headline: i.headline,
            summary: i.summary ?? null,
            publishedAt: i.publishedAt ?? null,
            source: i.source ?? null,
          }))
        : [];
    } catch {
      probeFailed = true;
    }
  }

  // Fail-closed connectivity (pure domain resolver): downgrades a claimed-live
  // provider whose probe failed/returned disconnected or sits in ERROR state.
  const { connected, freshness, sourceStatus } = resolveNewsHonesty({
    configured,
    statusConnected,
    freshnessState: status.freshnessState,
    probeConnected,
    probeFailed,
  });

  // Honest record count: only report items when we positively confirmed live.
  const itemCount = connected ? probeItemCount : 0;
  // Real severity + recency derived risk — never a count proxy. Fail-closed:
  // 0 when not connected (the caller maps that to `unavailable`, never "low").
  const nowMs = Date.now();
  const severity = connected
    ? deriveNewsRiskScore(probeItems, nowMs)
    : { riskScore: 0, highImpactCount: 0, recentCount: 0 };
  // Top severity-ranked headlines that drove the score — so users can judge
  // relevance. Empty (never fabricated) when not connected.
  const topHeadlines: MarketHeatNewsHeadline[] = connected
    ? selectTopNewsHeadlines(probeItems, nowMs, 3)
    : [];
  // The HEADLINE fetch time behind this probe — never the provider-wide
  // lastSuccessfulFetchAt, which any quote/candle call moves — and only when
  // the resolver confirmed the source connected. Unknown stays null.
  const updatedAt = connected ? probeFetchedAt : null;

  return {
    source: {
      kind: "news",
      name: status.provider,
      status: sourceStatus,
      configured,
      connected,
      updatedAt,
      recordCount: itemCount,
      note: connected
        ? null
        : probeFailed
          ? "News provider request failed — treated as not connected."
          : "News provider not connected.",
    },
    connected,
    configured,
    itemCount,
    riskScore: severity.riskScore,
    highImpactCount: severity.highImpactCount,
    topHeadlines,
    updatedAt,
    provider: status.provider,
    freshness,
    apiKeyPresent: configured,
    lastError: status.lastError ?? null,
  };
}

/** Normalize the economic-calendar provider into an honest heat source. */
export async function readCalendarProvider(
  symbol: string,
  nowMs: number = Date.now(),
): Promise<CalendarProviderRead> {
  let connected = false;
  let provider = "none";
  let eventCount = 0;
  let highImpactActive = false;
  let errored = false;
  let events: MarketHeatEvent[] = [];
  let updatedAt: string | null = null;
  try {
    const snap = await getEconomicCalendar(symbol, nowMs);
    connected = snap.connected;
    // Last SUCCESSFUL fetch only — a failed attempt is not a check.
    updatedAt = snap.connected ? (snap.lastSuccessAt ?? null) : null;
    provider = snap.provider;
    errored = snap.status === "error";
    eventCount = snap.events.length;
    highImpactActive = snap.events.some((e) => e.impact === "high");
    // Real-or-empty: only surface events when the provider is connected.
    events = connected
      ? snap.events
          .slice()
          .sort((a, b) => Date.parse(a.eventTimeIso) - Date.parse(b.eventTimeIso))
          .slice(0, 12)
          .map((e) => ({
            id: e.id,
            title: e.title,
            currency: e.currency,
            impact: e.impact,
            timeUtc: e.eventTimeIso,
            affectedSymbols: e.affectedMarkets,
          }))
      : [];
  } catch {
    connected = false;
    errored = true;
    events = [];
  }

  const configured = provider !== "none";
  // `errored` takes precedence over `!configured`: if the calendar read threw
  // before the provider name was resolved (operational failure), provider stays
  // "none" — but it must surface as honest "error", never masquerade as the
  // "missing" (no-provider-configured) state.
  const sourceStatus = errored
    ? "error"
    : !configured
      ? "missing"
      : !connected
        ? "unavailable"
        : "live";

  return {
    source: {
      kind: "calendar",
      name: provider,
      status: sourceStatus,
      configured,
      connected,
      updatedAt,
      recordCount: eventCount,
      note: connected
        ? null
        : errored
          ? "Economic-calendar provider error — events could not be retrieved."
          : "Economic-calendar provider not connected.",
    },
    connected,
    configured,
    eventCount,
    highImpactActive,
    provider,
    events,
    updatedAt,
  };
}

export interface PriceProviderRead {
  source: MarketHeatSource;
  available: boolean;
  momentum: number;
  volatility: number;
  freshness: "LIVE" | "DELAYED" | "STALE" | "UNAVAILABLE";
  updatedAt: string | null;
  /**
   * What `updatedAt` measures: "tick" = this symbol's own last venue tick (the
   * price observation time); "bar_open" = the OPEN time of the newest bar
   * (a forming bar's open is NOT when its price was observed). Null when no
   * price is available.
   */
  priceTimeBasis: "tick" | "bar_open" | null;
  provider: string;
  candleCount: number;
}

/** Per-symbol last-tick reader (injectable for tests; no I/O in tests). */
export type PriceTickReader = (symbol: string) => { lastTickAt: string | null } | null;

const defaultTickReader: PriceTickReader = (symbol) => getDerivSymbolFeedStatus(symbol);

// A tick stamped further than this into the future is clock-skew, not evidence.
const TICK_FUTURE_TOLERANCE_MS = 5_000;
// Same per-symbol "recent tick" window the Deriv feed verdict uses.
const RECENT_TICK_MS = 30_000;

function isDerivBacked(provider: string | null | undefined): boolean {
  return provider === "deriv" || provider === "deriv_public";
}

/**
 * Probe the price router for a symbol and derive a normalized price signal.
 * Real-or-empty: an exhausted router yields an honest UNAVAILABLE signal.
 */
export async function readPriceProvider(
  symbol: string,
  timeframe: string,
  nowMs: number = Date.now(),
  deps: { tickReader?: PriceTickReader; candleRouter?: typeof routeCandles } = {},
): Promise<PriceProviderRead> {
  let result;
  try {
    result = await (deps.candleRouter ?? routeCandles)(symbol, timeframe, 120);
  } catch {
    result = null;
  }

  if (!result || !result.ok || result.candles.length < 2) {
    const provider = result?.primaryProvider ?? "none";
    return {
      source: {
        kind: "price",
        name: provider,
        status: "unavailable",
        configured: provider !== "none",
        connected: false,
        updatedAt: null,
        recordCount: result?.candles.length ?? 0,
        note: "No live price feed for this market.",
      },
      available: false,
      momentum: 0,
      volatility: 0,
      freshness: "UNAVAILABLE",
      updatedAt: null,
      priceTimeBasis: null,
      provider,
      candleCount: result?.candles.length ?? 0,
    };
  }

  const c = result.candles;
  const first = c[0]!.close;
  const last = c[c.length - 1]!.close;
  const pct = first !== 0 ? (last - first) / first : 0;
  const momentum = Math.max(-1, Math.min(1, pct * 20));

  let sum = 0;
  let n = 0;
  for (let i = 1; i < c.length; i++) {
    const p = c[i - 1]!.close;
    if (p !== 0) {
      sum += Math.abs((c[i]!.close - p) / p);
      n++;
    }
  }
  const volatility = Math.max(0, Math.min(1, (n ? sum / n : 0) * 200));

  const provider = result.primaryProvider ?? "none";
  const barTime = c[c.length - 1]!.time;
  const lastMs = Date.parse(barTime);

  // Freshness uses the SAME trailing-interval rule as the chart feed status
  // (rawTrailingIntervalGap + classifyCandleFreshness: gap ≥ 2 delayed, ≥ 3
  // stale) instead of the old 2×/6× timeframe ladder that kept an M15 price
  // "LIVE" for 30 minutes. An unparseable bar time is never LIVE.
  const chartTf = normalizeChartTimeframe(timeframe) ?? "M15";
  const gapCls = classifyCandleFreshness(rawTrailingIntervalGap(c, provider, chartTf, nowMs));
  let freshness: PriceProviderRead["freshness"] =
    !Number.isFinite(lastMs) || gapCls == null ? "DELAYED"
      : gapCls.freshness === "stale" ? "STALE"
        : gapCls.freshness === "delayed" ? "DELAYED"
          : "LIVE";

  // Observation time. A Deriv bar's time is its OPEN (the forming M15 bar
  // opened up to 15 min ago while its close is seconds old), so for a
  // Deriv-backed series prefer THIS symbol's own last tick — but only when it
  // belongs to the newest bar (tick ≥ bar open) and is not from the future;
  // a stale cached tick from an old subscription can never make a row look
  // fresher than its bars. The tick may only DOWNGRADE freshness: no recent
  // tick for a Deriv-backed symbol → never LIVE (same rule as the per-symbol
  // Deriv feed verdict).
  let updatedAt = barTime;
  let priceTimeBasis: "tick" | "bar_open" = "bar_open";
  if (isDerivBacked(result.primaryProvider)) {
    let tickMs = Number.NaN;
    try {
      const tick = (deps.tickReader ?? defaultTickReader)(symbol);
      tickMs = tick?.lastTickAt ? Date.parse(tick.lastTickAt) : Number.NaN;
    } catch {
      tickMs = Number.NaN;
    }
    const tickUsable = Number.isFinite(tickMs) && Number.isFinite(lastMs)
      && tickMs >= lastMs && tickMs <= nowMs + TICK_FUTURE_TOLERANCE_MS;
    if (tickUsable) {
      updatedAt = new Date(tickMs).toISOString();
      priceTimeBasis = "tick";
    }
    const recentTick = tickUsable && nowMs - tickMs <= RECENT_TICK_MS;
    if (freshness === "LIVE" && !recentTick) freshness = "DELAYED";
  }

  const status =
    freshness === "STALE" ? "stale" : freshness === "DELAYED" ? "delayed" : "live";

  return {
    source: {
      kind: "price",
      name: provider,
      status,
      configured: true,
      connected: true,
      updatedAt,
      recordCount: c.length,
      note:
        status === "stale"
          ? "Price feed is stale."
          : status === "delayed"
            ? "Price feed is delayed."
            : null,
    },
    available: true,
    momentum,
    volatility,
    freshness,
    updatedAt,
    priceTimeBasis,
    provider,
    candleCount: c.length,
  };
}
