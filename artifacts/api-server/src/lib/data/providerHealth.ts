// ARX AI — Provider Health inventory + sanitized self-tests.
//
// Admin-only diagnostics surface that:
//   - Lists every market-data / news / Deriv / MT5 / TwelveData / Polygon /
//     Finnhub / AlphaVantage / NewsAPI / OpenAI provider known to the app.
//   - Reports whether each provider is CONFIGURED (boolean only — never the
//     raw secret value), whether it is currently SELECTED by the router for
//     a given asset class, which app modules USE it (scanner / chart /
//     ruby / trade ticket / news / backtest / watchlist), and whether the
//     most recent self-test succeeded.
//   - Runs a sanitized self-test:
//       * one historical candle pull per asset class (EURUSD, BTCUSDT,
//         XAUUSD, AAPL, V75, V75_1S)
//       * one live quote per asset class (where supported)
//       * timing (ms) + provider that actually answered
//       * error reasons are pre-redacted by marketDataRouter.redact() and
//         additionally truncated to 280 chars here
//
// Inviolables:
//   - NEVER returns or logs raw values for any env var (no API keys, no
//     tokens, no account numbers, no SESSION_SECRET, no MT5_BRIDGE_TOKEN).
//   - Only "configured: yes/no" and "lastFourMasked" (last 4 chars of the
//     secret, prefixed with "••••") are exposed, and only to admins.
//   - NEVER fabricates candles. Empty results stay empty.
//   - NEVER touches MT5 dispatch, live order pipeline, or any safety state.

import {
  classifySymbol,
  getRouterDiagnostics,
  routeCandles,
  routeQuote,
  type AssetClass,
} from "./marketDataRouter.js";
import { getDerivFeedStatus } from "./providers/derivProvider.js";
import {
  mt5Provider,
  getMt5AllSeriesStatus,
  getMt5QuoteAvailability,
} from "./providers/mt5Provider.js";
import { getMarketProvider, getMarketStatus } from "../assistant/marketProvider.js";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";
import { getChartFeedStatus } from "./chart/chartDataService.js";
import type { ChartTimeframe } from "./chart/timeframes.js";
import { detectCurrentConnectedBridge } from "../mt5/currentConnectedBridgeDetector.js";
import { getCalendarHealthSnapshot } from "../news/economicCalendarProvider.js";

export interface ProviderEntry {
  id: string;
  name: string;
  category: "broker" | "synthetic" | "market_data" | "news" | "ai";
  secretEnvKeys: string[];
  configured: boolean;
  secretMasks: Array<{ envKey: string; configured: boolean; lastFourMasked: string | null }>;
  usedBy: Array<"scanner" | "chart" | "ruby" | "trade_ticket" | "watchlist" | "backtest" | "news" | "ai_assistant">;
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

export interface SymbolProbe {
  symbol: string;
  assetClass: AssetClass;
  timeframe: string;
  candles: {
    ok: boolean;
    primaryProvider: string | null;
    candleCount: number;
    attempts: Array<{ provider: string; ok: boolean; reason: string | null; ms: number }>;
    userMessage: string;
    adminDetail: string;
  };
  quote: {
    ok: boolean;
    primaryProvider: string | null;
    attempts: Array<{ provider: string; ok: boolean; reason: string | null; ms: number }>;
    userMessage: string;
    adminDetail: string;
  };
}

// ── Live feed status (one honest row per upstream feed) ──────────────────────
// Read-only projection of the existing feed introspection helpers. Never names
// a raw secret and never changes any provider behaviour.
export interface FeedsHealth {
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
    quotePush: {
      active: boolean;
      symbolsWithFreshQuote: number;
      symbolsProbed: number;
      note: string;
    };
    candlePush: {
      active: boolean;
      totalSeries: number;
      contributing: number;
      stale: number;
      nonContributing: number;
    };
  };
  deriv: {
    configured: boolean;
    connected: boolean;
    healthSummary: string;
    feedReadinessState: string;
    lastTickAt: string | null;
    message: string;
  };
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

// ── Per asset-class live activity (resolved feed truth + fallback reason) ─────
export interface AssetClassActivity {
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

// ── Inverse of provider.usedBy: which providers each app surface consumes ─────
export interface ActiveConsumer {
  consumer: string;
  providers: string[];
}

export interface ProviderHealthSnapshot {
  generatedAt: string;
  routerChains: Record<AssetClass, string[]>;
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

const PROBE_SYMBOLS: ReadonlyArray<{ symbol: string; timeframe: string }> = [
  { symbol: "EURUSD",  timeframe: "M5" },
  { symbol: "BTCUSDT", timeframe: "M5" },
  { symbol: "XAUUSD",  timeframe: "M5" },
  { symbol: "AAPL",    timeframe: "M5" },
  { symbol: "V75",     timeframe: "M5" },
  { symbol: "V75_1S",  timeframe: "M5" },
];

function maskLastFour(envKey: string): { envKey: string; configured: boolean; lastFourMasked: string | null } {
  const v = process.env[envKey];
  const configured = !!(v && v.trim().length > 0);
  if (!configured) return { envKey, configured: false, lastFourMasked: null };
  const trimmed = (v ?? "").trim();
  const last4 = trimmed.length >= 4 ? trimmed.slice(-4) : "••••";
  return { envKey, configured: true, lastFourMasked: `••••${last4}` };
}

function truncate(s: string | null, n = 280): string | null {
  if (s == null) return null;
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export async function getProviderHealthSnapshot(): Promise<ProviderHealthSnapshot> {
  const router = getRouterDiagnostics();
  const assistant = getMarketProvider();
  const deriv = getDerivFeedStatus();
  const mt5Connected = await mt5Provider.isConnected().catch(() => false);

  // Which providers are SELECTED for which asset classes (read from chains).
  function classesWhereSelected(routerId: "mt5_broker" | "deriv" | "assistant_real"): AssetClass[] {
    const out: AssetClass[] = [];
    for (const [cls, chain] of Object.entries(router.chainsByAssetClass)) {
      if ((chain as string[]).includes(routerId)) out.push(cls as AssetClass);
    }
    return out;
  }

  const providers: ProviderEntry[] = [];

  // MT5 broker (reserved for entire chain top slot)
  providers.push({
    id: "mt5_broker",
    name: "MetaTrader 5 broker bridge",
    category: "broker",
    secretEnvKeys: [],
    configured: true,
    secretMasks: [],
    usedBy: ["trade_ticket", "chart", "watchlist"],
    selectedForAssetClasses: classesWhereSelected("mt5_broker"),
    configuredButUnused: false,
    status: mt5Connected ? "healthy" : "reserved",
    statusReason: mt5Connected
      ? "Broker tick push active."
      : "EA v1.27 heartbeat-only — tick push not yet implemented. Slot reserved for EA v1.28+.",
    features: { liveQuote: mt5Connected, historicalCandles: mt5Connected, news: false, symbolSearch: false },
    rateLimitNote: null,
    lastSelfTestAt: null, lastSelfTestMs: null, lastSelfTestOk: null,
  });

  // Deriv synthetic indices
  providers.push({
    id: "deriv",
    name: "Deriv synthetic indices (WebSocket)",
    category: "synthetic",
    secretEnvKeys: ["DERIV_APP_ID", "DERIV_API_TOKEN"],
    configured: deriv.configured,
    secretMasks: [maskLastFour("DERIV_APP_ID"), maskLastFour("DERIV_API_TOKEN")],
    usedBy: ["scanner", "chart", "ruby"],
    selectedForAssetClasses: classesWhereSelected("deriv"),
    configuredButUnused: deriv.configured && classesWhereSelected("deriv").length === 0,
    status: !deriv.configured ? "not_configured" : deriv.connected ? "healthy" : "degraded",
    statusReason: deriv.message,
    features: { liveQuote: true, historicalCandles: true, news: false, symbolSearch: true },
    rateLimitNote: null,
    lastSelfTestAt: null, lastSelfTestMs: null, lastSelfTestOk: null,
  });

  // Assistant-real composite — actual concrete adapters underneath.
  const tdConfigured = !!process.env.TWELVEDATA_API_KEY;
  const polygonConfigured = !!process.env.POLYGON_API_KEY;
  const finnhubConfigured = !!process.env.FINNHUB_API_KEY;
  const avConfigured = !!process.env.ALPHA_VANTAGE_API_KEY;
  const newsConfigured = !!process.env.NEWSAPI_API_KEY;
  const assistantSelected = classesWhereSelected("assistant_real");

  providers.push({
    id: "twelve_data",
    name: "Twelve Data (REST)",
    category: "market_data",
    secretEnvKeys: ["TWELVEDATA_API_KEY"],
    configured: tdConfigured,
    secretMasks: [maskLastFour("TWELVEDATA_API_KEY")],
    usedBy: tdConfigured && assistant.name.startsWith("twelve_data") ? ["scanner", "chart", "ruby", "trade_ticket", "watchlist"] : [],
    selectedForAssetClasses: tdConfigured && assistant.name.startsWith("twelve_data") ? assistantSelected : [],
    configuredButUnused: tdConfigured && !assistant.name.startsWith("twelve_data"),
    status: !tdConfigured ? "not_configured" : (assistant.name.startsWith("twelve_data") ? "healthy" : "degraded"),
    statusReason: !tdConfigured
      ? "TWELVEDATA_API_KEY not set."
      : assistant.name.startsWith("twelve_data") ? "Active market-data adapter." : "Configured but not selected — another provider is active.",
    features: { liveQuote: true, historicalCandles: true, news: false, symbolSearch: true },
    rateLimitNote: "Free tier ≈ 8 req/min, 800/day. Per-call cache amortizes scanner load.",
    lastSelfTestAt: null, lastSelfTestMs: null, lastSelfTestOk: null,
  });

  providers.push({
    id: "polygon",
    name: "Polygon.io (REST)",
    category: "market_data",
    secretEnvKeys: ["POLYGON_API_KEY"],
    configured: polygonConfigured,
    secretMasks: [maskLastFour("POLYGON_API_KEY")],
    usedBy: polygonConfigured && assistant.name === "polygon" ? ["scanner", "chart", "ruby"] : [],
    selectedForAssetClasses: polygonConfigured && assistant.name === "polygon" ? assistantSelected : [],
    configuredButUnused: polygonConfigured && assistant.name !== "polygon",
    status: !polygonConfigured ? "not_configured" : (assistant.name === "polygon" ? "healthy" : "degraded"),
    statusReason: !polygonConfigured
      ? "POLYGON_API_KEY not set."
      : assistant.name === "polygon" ? "Active." : "Configured but not selected — TwelveData/Finnhub takes priority when both set.",
    features: { liveQuote: true, historicalCandles: true, news: true, symbolSearch: true },
    rateLimitNote: "Free tier ≈ 5 req/min.",
    lastSelfTestAt: null, lastSelfTestMs: null, lastSelfTestOk: null,
  });

  providers.push({
    id: "finnhub",
    name: "Finnhub (REST)",
    category: "market_data",
    secretEnvKeys: ["FINNHUB_API_KEY"],
    configured: finnhubConfigured,
    secretMasks: [maskLastFour("FINNHUB_API_KEY")],
    // hybridTwelveDataFinnhub keeps name="twelve_data" but uses Finnhub for quotes/news.
    usedBy: finnhubConfigured && tdConfigured ? ["trade_ticket", "ruby", "news"] : (finnhubConfigured && assistant.name === "finnhub" ? ["scanner", "chart", "ruby", "news"] : []),
    selectedForAssetClasses: finnhubConfigured && assistant.name === "finnhub" ? assistantSelected : [],
    configuredButUnused: finnhubConfigured && !tdConfigured && assistant.name !== "finnhub",
    status: !finnhubConfigured ? "not_configured" : "healthy",
    statusReason: !finnhubConfigured
      ? "FINNHUB_API_KEY not set."
      : tdConfigured ? "Active in hybrid mode (TwelveData candles + Finnhub quotes/news)." : assistant.name === "finnhub" ? "Active." : "Configured but not selected.",
    features: { liveQuote: true, historicalCandles: true, news: true, symbolSearch: true },
    rateLimitNote: "Free tier ≈ 60 req/min, no historical news beyond 1 year.",
    lastSelfTestAt: null, lastSelfTestMs: null, lastSelfTestOk: null,
  });

  providers.push({
    id: "alpha_vantage",
    name: "Alpha Vantage (REST)",
    category: "market_data",
    secretEnvKeys: ["ALPHA_VANTAGE_API_KEY"],
    configured: avConfigured,
    secretMasks: [maskLastFour("ALPHA_VANTAGE_API_KEY")],
    usedBy: avConfigured && assistant.name === "alpha_vantage" ? ["scanner", "chart", "ruby"] : [],
    selectedForAssetClasses: avConfigured && assistant.name === "alpha_vantage" ? assistantSelected : [],
    configuredButUnused: avConfigured && assistant.name !== "alpha_vantage",
    status: !avConfigured ? "not_configured" : (assistant.name === "alpha_vantage" ? "healthy" : "degraded"),
    statusReason: !avConfigured
      ? "ALPHA_VANTAGE_API_KEY not set."
      : assistant.name === "alpha_vantage" ? "Active." : "Configured but not selected — Twelve Data / Polygon / Finnhub take priority when present.",
    features: { liveQuote: true, historicalCandles: false, news: false, symbolSearch: true },
    rateLimitNote: "Free tier ≈ 5 req/min, 500/day.",
    lastSelfTestAt: null, lastSelfTestMs: null, lastSelfTestOk: null,
  });

  providers.push({
    id: "newsapi",
    name: "NewsAPI.org",
    category: "news",
    secretEnvKeys: ["NEWSAPI_API_KEY"],
    configured: newsConfigured,
    secretMasks: [maskLastFour("NEWSAPI_API_KEY")],
    usedBy: newsConfigured ? ["news", "ruby"] : [],
    selectedForAssetClasses: [],
    configuredButUnused: false,
    status: !newsConfigured ? "not_configured" : "healthy",
    statusReason: !newsConfigured ? "NEWSAPI_API_KEY not set." : "Active for news/ruby market explanations.",
    features: { liveQuote: false, historicalCandles: false, news: true, symbolSearch: false },
    rateLimitNote: "Free tier ≈ 100 req/day.",
    lastSelfTestAt: null, lastSelfTestMs: null, lastSelfTestOk: null,
  });

  // OpenAI (Ruby brain — listed for completeness; not a market-data provider)
  const openAiConfigured = !!process.env.OPENAI_API_KEY;
  providers.push({
    id: "openai",
    name: `OpenAI (${DEFAULT_ASSISTANT_NAME} AI assistant)`,
    category: "ai",
    secretEnvKeys: ["OPENAI_API_KEY"],
    configured: openAiConfigured,
    secretMasks: [maskLastFour("OPENAI_API_KEY")],
    usedBy: openAiConfigured ? ["ai_assistant", "ruby"] : [],
    selectedForAssetClasses: [],
    configuredButUnused: false,
    status: !openAiConfigured ? "not_configured" : "healthy",
    statusReason: !openAiConfigured ? "OPENAI_API_KEY not set." : "Active.",
    features: { liveQuote: false, historicalCandles: false, news: false, symbolSearch: false },
    rateLimitNote: "Per-org rate limits apply.",
    lastSelfTestAt: null, lastSelfTestMs: null, lastSelfTestOk: null,
  });

  // ── Symbol self-tests via the unified router ────────────────────────────
  const probes: SymbolProbe[] = [];
  for (const { symbol, timeframe } of PROBE_SYMBOLS) {
    const cls = classifySymbol(symbol);
    const [c, q] = await Promise.all([
      routeCandles(symbol, timeframe, 5).catch((err) => ({
        ok: false, symbol, assetClass: cls, candles: [],
        primaryProvider: null, attempts: [],
        userMessage: "Probe failed.",
        adminDetail: truncate(String((err as Error).message ?? err), 280) ?? "unknown error",
      })),
      routeQuote(symbol).catch((err) => ({
        ok: false, symbol, assetClass: cls, quote: null,
        primaryProvider: null, attempts: [],
        userMessage: "Probe failed.",
        adminDetail: truncate(String((err as Error).message ?? err), 280) ?? "unknown error",
      })),
    ]);
    probes.push({
      symbol,
      assetClass: cls,
      timeframe,
      candles: {
        ok: c.ok,
        primaryProvider: c.primaryProvider,
        candleCount: c.candles.length,
        attempts: c.attempts.map((a) => ({ provider: a.provider, ok: a.ok, reason: truncate(a.reason, 280), ms: a.ms })),
        userMessage: c.userMessage,
        adminDetail: truncate(c.adminDetail, 280) ?? "",
      },
      quote: {
        ok: q.ok,
        primaryProvider: q.primaryProvider,
        attempts: q.attempts.map((a) => ({ provider: a.provider, ok: a.ok, reason: truncate(a.reason, 280), ms: a.ms })),
        userMessage: q.userMessage,
        adminDetail: truncate(q.adminDetail, 280) ?? "",
      },
    });

    // Attribute the probe outcome back to the primaryProvider that answered.
    const tsNow = new Date().toISOString();
    if (c.primaryProvider) {
      const idFromProbe = c.primaryProvider.startsWith("assistant_real:") ? c.primaryProvider.slice("assistant_real:".length) : c.primaryProvider;
      const p = providers.find((p) => p.id === idFromProbe);
      if (p) {
        p.lastSelfTestAt = tsNow;
        p.lastSelfTestMs = c.attempts[c.attempts.length - 1]?.ms ?? null;
        p.lastSelfTestOk = c.ok;
      }
    }
  }

  // ── Live feed status rows ───────────────────────────────────────────────
  // MT5 heartbeat — read the freshest connected bridge (read-only detector).
  const bridge = await detectCurrentConnectedBridge().catch(() => null);
  const bridgeEv = bridge ? (bridge.ok ? bridge.bridge : bridge.latestHint) : null;
  const hbAgeSec = bridgeEv?.heartbeatAgeSec ?? null;
  const hbStatus: FeedsHealth["mt5"]["heartbeat"]["status"] =
    !bridgeEv ? "none" : hbAgeSec == null ? "offline" : hbAgeSec <= 15 ? "live" : "stale";

  // MT5 quote push — honest count of probe symbols with a fresh usable quote.
  // EA v1.27/1.50 is heartbeat-only, so this stays 0/false until a quote-push
  // EA lands; we never fabricate a quote to make this look active.
  let symbolsWithFreshQuote = 0;
  for (const { symbol } of PROBE_SYMBOLS) {
    const qa = getMt5QuoteAvailability(symbol);
    if (qa.hasQuote && qa.fresh && qa.hasPrice) symbolsWithFreshQuote += 1;
  }

  // MT5 candle push — same classification the dedicated mt5-feed route uses.
  const mt5Series = getMt5AllSeriesStatus();
  const mt5Contributing = mt5Series.filter((s) => s.status === "contributing").length;
  const mt5Stale = mt5Series.filter((s) => s.status === "stale").length;
  const mt5NonContributing = mt5Series.filter((s) => s.status === "non-contributing").length;

  const assistantStatus = getMarketStatus();
  // Provider-agnostic calendar health: the shared service reports the SELECTED
  // provider (TE or FRED), configured/connected truth, and liveness — never a
  // hardcoded provider. Fail-closed to honest not-configured on any error.
  const calendar = await getCalendarHealthSnapshot().catch(() => ({
    connected: false as boolean,
    provider: "none" as string,
    configured: false as boolean,
    lastFetchAt: null as string | null,
    lastErrorAt: null as string | null,
    lastErrorMessage: null as string | null,
    eventCount: 0,
    freshnessStatus: "unavailable" as "fresh" | "stale" | "unavailable",
  }));

  const feeds: FeedsHealth = {
    mt5: {
      heartbeat: {
        present: bridgeEv != null,
        status: hbStatus,
        ageSec: hbAgeSec,
        eaVersion: bridgeEv?.eaVersion ?? null,
        accountType: bridgeEv?.accountType ?? null,
        masterLiveCapable: bridge?.ok === true,
        blockReason: bridge && !bridge.ok ? bridge.primaryReason : null,
      },
      quotePush: {
        active: symbolsWithFreshQuote > 0,
        symbolsWithFreshQuote,
        symbolsProbed: PROBE_SYMBOLS.length,
        note:
          symbolsWithFreshQuote > 0
            ? "Broker quote push active for at least one probed symbol."
            : "No broker tick push — EA heartbeat-only. Router falls through to Deriv / assistant composite.",
      },
      candlePush: {
        // Honest: candle push is "active" ONLY when at least one symbol+timeframe
        // series is actually contributing fresh, usable candles — NOT derived from
        // general MT5 connectivity (which a quote-only/heartbeat-only EA satisfies).
        // EA v1.27/1.50 is heartbeat-only, so this stays false until a candle-push
        // EA lands; we never fabricate candle activity from a quote/heartbeat.
        active: mt5Contributing > 0,
        totalSeries: mt5Series.length,
        contributing: mt5Contributing,
        stale: mt5Stale,
        nonContributing: mt5NonContributing,
      },
    },
    deriv: {
      configured: deriv.configured,
      connected: deriv.connected,
      healthSummary: deriv.healthSummary,
      feedReadinessState: deriv.feedReadinessState,
      lastTickAt: deriv.lastTickAt,
      message: deriv.message,
    },
    assistant: {
      provider: assistantStatus.provider,
      connected: assistantStatus.connected,
      configured: assistantStatus.configured,
      freshnessState: assistantStatus.freshnessState,
      dataFreshness: assistantStatus.dataFreshness,
      dataSource: assistantStatus.dataSource,
      lastSuccessfulFetchAt: assistantStatus.lastSuccessfulFetchAt,
      lastErrorAt: assistantStatus.lastErrorAt,
      unavailableReason: assistantStatus.unavailableReason,
    },
    economicCalendar: {
      connected: calendar.connected,
      provider: calendar.provider,
      configured: calendar.configured,
      // Liveness derived from the shared service diagnostics (provider-agnostic):
      // lastFetchAt, lastErrorAt, lastErrorMessage, eventCount, freshnessStatus.
      lastFetchAt: calendar.lastFetchAt,
      lastErrorAt: calendar.lastErrorAt,
      lastErrorMessage: calendar.lastErrorMessage,
      eventCount: calendar.eventCount,
      freshnessStatus: calendar.freshnessStatus,
    },
  };

  // ── Per asset-class live activity (resolved feed truth + fallback reason) ──
  // One representative symbol per distinct probed asset class. getChartFeedStatus
  // resolves the SAME way the chart endpoints do, so aiUsable / quality / staleness
  // here matches what the chart shows. fallbackReason = the first failed candle
  // attempt for that class (why the top router slot fell through).
  const seenClasses = new Set<AssetClass>();
  const assetClassActivity: AssetClassActivity[] = [];
  for (const probe of probes) {
    if (seenClasses.has(probe.assetClass)) continue;
    seenClasses.add(probe.assetClass);
    const feed = await getChartFeedStatus(probe.symbol, probe.timeframe as ChartTimeframe).catch(
      () => null,
    );
    const firstFailedCandle = probe.candles.attempts.find((a) => !a.ok) ?? null;
    assetClassActivity.push({
      assetClass: probe.assetClass,
      representativeSymbol: probe.symbol,
      latestCandleProvider: feed?.source ?? probe.candles.primaryProvider,
      latestQuoteProvider: probe.quote.primaryProvider,
      lastCandleTime: feed?.lastCandleTime ?? null,
      lastQuoteTime: feed?.lastTickTime ?? null,
      aiUsable: feed?.aiUsable ?? false,
      feedQuality: feed?.quality ?? "unknown",
      staleReason: feed?.warning ?? null,
      fallbackReason: firstFailedCandle ? firstFailedCandle.reason : null,
    });
  }

  // ── Active consumers (inverse of provider.usedBy over live providers) ─────
  // Only providers that are actually healthy/active contribute, so this answers
  // "what is each app surface reading from RIGHT NOW", not the static wiring.
  const consumerMap = new Map<string, Set<string>>();
  for (const p of providers) {
    if (p.status !== "healthy") continue;
    for (const consumer of p.usedBy) {
      if (!consumerMap.has(consumer)) consumerMap.set(consumer, new Set());
      consumerMap.get(consumer)!.add(p.id);
    }
  }
  const activeConsumers: ActiveConsumer[] = Array.from(consumerMap.entries())
    .map(([consumer, providerIds]) => ({ consumer, providers: Array.from(providerIds).sort() }))
    .sort((a, b) => a.consumer.localeCompare(b.consumer));

  // Summary counters
  const summary = {
    totalProviders: providers.length,
    healthy: providers.filter((p) => p.status === "healthy").length,
    degraded: providers.filter((p) => p.status === "degraded").length,
    failing: providers.filter((p) => p.status === "failing").length,
    notConfigured: providers.filter((p) => p.status === "not_configured").length,
    reserved: providers.filter((p) => p.status === "reserved").length,
    configuredButUnused: providers.filter((p) => p.configuredButUnused).length,
  };

  return {
    generatedAt: new Date().toISOString(),
    routerChains: router.chainsByAssetClass,
    providers,
    symbolProbes: probes,
    feeds,
    assetClassActivity,
    activeConsumers,
    summary,
  };
}
