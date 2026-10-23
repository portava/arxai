// ── Market Heat service (Task #611) ─────────────────────────────────────────
//
// Composes the REAL price / news / economic-calendar provider reads into the
// shared honesty-aware `MarketHeatVerdict` contract for countries, currencies,
// synthetics, and the global aggregate.
//
// HONESTY: news and calendar contribute ONLY when their provider is connected.
// For macro scopes (country/currency/global) with no connected news/calendar the
// verdict is an explicit "unavailable" — never fake low-risk heat. Decision
// support only: this module imports NO safety-contract / live-pipeline code.

import {
  computeHeatVerdict,
  deriveNewsRisk,
  getSymbolGeography,
  marketMatchesSession,
  countryDisplayName,
  currencyDisplayName,
  type MarketHeatVerdict,
  type MarketHeatNewsRisk,
  type MarketHeatEvent,
  type PriceSignal,
  type NewsSignal,
  type CalendarSignal,
} from "@workspace/domain/market-heat";
import { ARX_FOCUS_MARKETS } from "@workspace/domain/market";
import {
  readNewsProvider,
  readCalendarProvider,
  readPriceProvider,
  type NewsProviderRead,
  type CalendarProviderRead,
} from "./marketHeatProviderStatus.js";

export interface ProviderStatusRow {
  price: MarketHeatVerdict["priceSource"];
  news: MarketHeatVerdict["newsSource"];
  calendar: MarketHeatVerdict["calendarSource"];
}

export interface MarketHeatBundle {
  generatedAt: string;
  timeframe: string;
  global: MarketHeatVerdict;
  countries: MarketHeatVerdict[];
  currencies: MarketHeatVerdict[];
  synthetics: MarketHeatVerdict[];
  providerStatus: ProviderStatusRow;
  /** Honest "today's news risk" — `unavailable` when news not connected. */
  newsRisk: MarketHeatNewsRisk;
  /** Upcoming high-impact events — empty (never fabricated) when calendar down. */
  upcomingEvents: MarketHeatEvent[];
  warnings: string[];
}

const UNAVAILABLE_PRICE: PriceSignal = {
  available: false,
  momentum: 0,
  volatility: 0,
  freshness: "UNAVAILABLE",
  updatedAt: null,
  source: "none",
  candleCount: 0,
};

function newsSignalOf(read: NewsProviderRead): NewsSignal {
  return {
    configured: read.configured,
    connected: read.connected,
    // Real severity + recency derived risk (marketHeatProviderStatus), NOT a
    // raw item-count proxy. Fail-closed: 0 when not connected.
    riskScore: read.connected ? Math.max(0, Math.min(1, read.riskScore)) : 0,
    itemCount: read.itemCount,
    updatedAt: read.updatedAt,
    source: read.provider,
    freshness: read.freshness,
  };
}

function calendarSignalOf(read: CalendarProviderRead): CalendarSignal {
  return {
    configured: read.configured,
    connected: read.connected,
    impactScore: read.connected ? Math.max(0, Math.min(1, read.eventCount / 8)) : 0,
    eventCount: read.eventCount,
    highImpactActive: read.highImpactActive,
    updatedAt: null,
    source: read.provider,
  };
}

/** Average a set of price signals into one representative macro price signal. */
function aggregatePrice(signals: PriceSignal[]): PriceSignal {
  const live = signals.filter((s) => s.available);
  if (live.length === 0) return UNAVAILABLE_PRICE;
  const momentum = live.reduce((a, s) => a + s.momentum, 0) / live.length;
  const volatility = live.reduce((a, s) => a + s.volatility, 0) / live.length;
  // Worst freshness wins (most honest).
  const order = { LIVE: 0, DELAYED: 1, STALE: 2, UNAVAILABLE: 3 } as const;
  const freshness = live.reduce<PriceSignal["freshness"]>(
    (worst, s) => (order[s.freshness] > order[worst] ? s.freshness : worst),
    "LIVE",
  );
  const newest = live.reduce<string | null>((acc, s) => {
    if (!s.updatedAt) return acc;
    if (!acc) return s.updatedAt;
    return Date.parse(s.updatedAt) > Date.parse(acc) ? s.updatedAt : acc;
  }, null);
  return {
    available: true,
    momentum,
    volatility,
    freshness,
    updatedAt: newest,
    source: live[0]!.source,
    candleCount: live.reduce((a, s) => a + s.candleCount, 0),
  };
}

interface BuildOptions {
  timeframe: string;
  includeNews: boolean;
  includeCalendar: boolean;
  /** Restrict the heat universe to these ARX symbols (view filter only). */
  symbols?: string[];
  /** Restrict the returned country verdicts to these country keys. */
  countries?: string[];
  /** Restrict the universe to markets active in this trading session. */
  session?: string;
  nowMs?: number;
}

/**
 * Build the full honest heat bundle. Probes price ONLY where it can change a
 * verdict: for macro scopes the price probe is skipped when no news/calendar
 * provider is connected (the verdict is unavailable regardless), keeping the
 * call honest and cheap in a providers-disconnected environment.
 */
export async function buildMarketHeat(opts: BuildOptions): Promise<MarketHeatBundle> {
  const nowMs = opts.nowMs ?? Date.now();
  const timeframe = opts.timeframe;

  const newsRead = opts.includeNews
    ? await readNewsProvider()
    : await readNewsProvider();
  const calendarRead = await readCalendarProvider("GLOBAL", nowMs);

  const newsSignal = opts.includeNews
    ? newsSignalOf(newsRead)
    : { ...newsSignalOf(newsRead), connected: false };
  const calendarSignal = opts.includeCalendar
    ? calendarSignalOf(calendarRead)
    : { ...calendarSignalOf(calendarRead), connected: false };

  const macroActive = newsSignal.connected || calendarSignal.connected;

  const warnings: string[] = [];
  if (!newsSignal.connected) warnings.push("News provider not connected.");
  if (!calendarSignal.connected)
    warnings.push("Economic-calendar provider not connected.");

  // ── View filters (decision-support only; never weaken an honesty rule) ──
  const symbolFilter =
    opts.symbols && opts.symbols.length > 0
      ? new Set(
          opts.symbols.map((s) => {
            const g = getSymbolGeography(s);
            return g ? g.symbol : s.toUpperCase();
          }),
        )
      : null;
  const session = opts.session && opts.session.trim() ? opts.session.trim() : null;
  function marketIncluded(canonicalSymbol: string): boolean {
    if (symbolFilter && !symbolFilter.has(canonicalSymbol)) return false;
    if (session) {
      const g = getSymbolGeography(canonicalSymbol);
      if (!g || !marketMatchesSession(g, session)) return false;
    }
    return true;
  }

  // ── Synthetics (always price-only, immune to macro) ──
  const synthMarkets = ARX_FOCUS_MARKETS.filter(
    (m) => m.category === "synthetic" && marketIncluded(m.canonicalSymbol),
  );
  const synthetics: MarketHeatVerdict[] = [];
  for (const m of synthMarkets) {
    const price = await readPriceProvider(m.canonicalSymbol, timeframe, nowMs);
    synthetics.push(
      computeHeatVerdict({
        id: `synthetic:${m.canonicalSymbol}`,
        scope: "synthetic",
        key: m.canonicalSymbol,
        displayName: m.displayName,
        affectedSymbols: [m.canonicalSymbol],
        price: {
          available: price.available,
          momentum: price.momentum,
          volatility: price.volatility,
          freshness: price.freshness,
          updatedAt: price.updatedAt,
          source: price.provider,
          candleCount: price.candleCount,
        },
        news: { ...newsSignal, connected: false },
        calendar: { ...calendarSignal, connected: false },
      }),
    );
  }

  // ── Country / currency aggregation from non-synthetic markets ──
  const countryToSymbols = new Map<string, Set<string>>();
  const currencyToSymbols = new Map<string, Set<string>>();
  for (const m of ARX_FOCUS_MARKETS) {
    if (m.category === "synthetic") continue;
    if (!marketIncluded(m.canonicalSymbol)) continue;
    const geo = getSymbolGeography(m.canonicalSymbol);
    if (!geo) continue;
    for (const country of geo.countries) {
      if (!countryToSymbols.has(country)) countryToSymbols.set(country, new Set());
      countryToSymbols.get(country)!.add(m.canonicalSymbol);
    }
    for (const ccy of geo.currencies) {
      if (!currencyToSymbols.has(ccy)) currencyToSymbols.set(ccy, new Set());
      currencyToSymbols.get(ccy)!.add(m.canonicalSymbol);
    }
  }

  // Price probes are only meaningful when macro is active; dedupe across scopes.
  const priceCache = new Map<string, PriceSignal>();
  async function priceFor(symbol: string): Promise<PriceSignal> {
    if (!macroActive) return UNAVAILABLE_PRICE;
    const cached = priceCache.get(symbol);
    if (cached) return cached;
    const read = await readPriceProvider(symbol, timeframe, nowMs);
    const sig: PriceSignal = {
      available: read.available,
      momentum: read.momentum,
      volatility: read.volatility,
      freshness: read.freshness,
      updatedAt: read.updatedAt,
      source: read.provider,
      candleCount: read.candleCount,
    };
    priceCache.set(symbol, sig);
    return sig;
  }

  const countries: MarketHeatVerdict[] = [];
  for (const [country, symbols] of countryToSymbols) {
    const syms = [...symbols].sort();
    const priceSignals = await Promise.all(syms.map((s) => priceFor(s)));
    countries.push(
      computeHeatVerdict({
        id: `country:${country}`,
        scope: "country",
        key: country,
        displayName: countryDisplayName(country),
        affectedSymbols: syms,
        price: aggregatePrice(priceSignals),
        news: newsSignal,
        calendar: calendarSignal,
      }),
    );
  }
  countries.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const countryFilter =
    opts.countries && opts.countries.length > 0
      ? new Set(opts.countries.map((c) => c.toUpperCase()))
      : null;
  const filteredCountries = countryFilter
    ? countries.filter((v) => countryFilter.has(v.key.toUpperCase()))
    : countries;

  const currencies: MarketHeatVerdict[] = [];
  for (const [ccy, symbols] of currencyToSymbols) {
    const syms = [...symbols].sort();
    const priceSignals = await Promise.all(syms.map((s) => priceFor(s)));
    currencies.push(
      computeHeatVerdict({
        id: `currency:${ccy}`,
        scope: "currency",
        key: ccy,
        displayName: currencyDisplayName(ccy),
        affectedSymbols: syms,
        price: aggregatePrice(priceSignals),
        news: newsSignal,
        calendar: calendarSignal,
      }),
    );
  }
  currencies.sort((a, b) => a.displayName.localeCompare(b.displayName));

  // ── Global aggregate ──
  const allMacroSymbols = [...new Set([...countryToSymbols.values()].flatMap((s) => [...s]))].sort();
  const globalPrice = aggregatePrice(
    await Promise.all(allMacroSymbols.map((s) => priceFor(s))),
  );
  const global = computeHeatVerdict({
    id: "global",
    scope: "global",
    key: "global",
    displayName: "Global Markets",
    affectedSymbols: allMacroSymbols,
    price: globalPrice,
    news: newsSignal,
    calendar: calendarSignal,
  });

  const providerStatus: ProviderStatusRow = {
    price: global.priceSource,
    news: newsRead.source,
    calendar: calendarRead.source,
  };

  // ── Honest distinct surfaces: today's news risk + upcoming events ──
  const newsRisk = deriveNewsRisk(newsSignal, {
    topHeadlines: newsRead.topHeadlines,
    highImpactCount: newsRead.highImpactCount,
  });
  const upcomingEvents = calendarSignal.connected ? calendarRead.events : [];

  return {
    generatedAt: new Date(nowMs).toISOString(),
    timeframe,
    global,
    countries: filteredCountries,
    currencies,
    synthetics,
    providerStatus,
    newsRisk,
    upcomingEvents,
    warnings,
  };
}

export interface SymbolHeatResult {
  generatedAt: string;
  symbol: string;
  isApprovedMarket: boolean;
  blockedReason: string | null;
  verdict?: MarketHeatVerdict;
  countries: MarketHeatVerdict[];
  currencies: MarketHeatVerdict[];
  newsRisk: string | null;
  providerStatus: ProviderStatusRow;
}

/** Build an honest heat verdict for a single approved symbol. */
export async function buildSymbolHeat(
  symbol: string,
  timeframe: string,
  nowMs: number = Date.now(),
): Promise<SymbolHeatResult> {
  const geo = getSymbolGeography(symbol);
  const newsRead = await readNewsProvider();
  const calendarRead = await readCalendarProvider(symbol, nowMs);
  const newsSignal = newsSignalOf(newsRead);
  const calendarSignal = calendarSignalOf(calendarRead);

  const providerStatus: ProviderStatusRow = {
    price: {
      kind: "price",
      name: "none",
      status: "unavailable",
      configured: false,
      connected: false,
      updatedAt: null,
      recordCount: 0,
      note: null,
    },
    news: newsRead.source,
    calendar: calendarRead.source,
  };

  if (!geo) {
    return {
      generatedAt: new Date(nowMs).toISOString(),
      symbol,
      isApprovedMarket: false,
      blockedReason:
        "This market is outside the approved ARX Focus universe — no heat read is produced.",
      countries: [],
      currencies: [],
      newsRisk: null,
      providerStatus,
    };
  }

  const price = await readPriceProvider(geo.symbol, timeframe, nowMs);
  providerStatus.price = price.source;
  const isSynthetic = geo.isSynthetic;

  const verdict = computeHeatVerdict({
    id: `symbol:${geo.symbol}`,
    scope: isSynthetic ? "synthetic" : "symbol",
    key: geo.symbol,
    displayName: geo.displayName,
    affectedSymbols: [geo.symbol],
    price: {
      available: price.available,
      momentum: price.momentum,
      volatility: price.volatility,
      freshness: price.freshness,
      updatedAt: price.updatedAt,
      source: price.provider,
      candleCount: price.candleCount,
    },
    news: isSynthetic ? { ...newsSignal, connected: false } : newsSignal,
    calendar: isSynthetic ? { ...calendarSignal, connected: false } : calendarSignal,
  });

  // Per-country / per-currency verdicts for the affected geographies.
  const countries: MarketHeatVerdict[] = geo.countries.map((country) =>
    computeHeatVerdict({
      id: `symbol:${geo.symbol}:country:${country}`,
      scope: "country",
      key: country,
      displayName: countryDisplayName(country),
      affectedSymbols: [geo.symbol],
      price: { ...UNAVAILABLE_PRICE },
      news: newsSignal,
      calendar: calendarSignal,
    }),
  );
  const currencies: MarketHeatVerdict[] = geo.currencies.map((ccy) =>
    computeHeatVerdict({
      id: `symbol:${geo.symbol}:currency:${ccy}`,
      scope: "currency",
      key: ccy,
      displayName: currencyDisplayName(ccy),
      affectedSymbols: [geo.symbol],
      price: { ...UNAVAILABLE_PRICE },
      news: newsSignal,
      calendar: calendarSignal,
    }),
  );

  // Honest news-risk phrasing — NEVER "low risk" when the provider is down.
  const newsRisk = !newsSignal.connected
    ? "News risk unavailable — news provider not connected."
    : newsSignal.itemCount === 0
      ? "No market-moving news detected on the connected feed."
      : `Connected news feed reports ${newsSignal.itemCount} recent item(s).`;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    symbol: geo.symbol,
    isApprovedMarket: true,
    blockedReason: null,
    verdict,
    countries,
    currencies,
    newsRisk,
    providerStatus,
  };
}

export interface HeatDiagnostics {
  generatedAt: string;
  providers: Array<{
    kind: "price" | "news" | "calendar";
    name: string;
    configured: boolean;
    connected: boolean;
    apiKeyPresent: boolean;
    lastFetchAt: string | null;
    lastError: string | null;
    recordCount: number;
    /** News only — high-impact severity-keyword match count (0 when N/A). */
    highImpactCount?: number;
    freshness: string;
  }>;
  coverage: {
    countries: number;
    currencies: number;
    symbols: number;
    synthetics: number;
  };
}

/** Per-provider diagnostics (API-key presence reported as a boolean only). */
export async function buildHeatDiagnostics(
  nowMs: number = Date.now(),
): Promise<HeatDiagnostics> {
  const news = await readNewsProvider();
  const calendar = await readCalendarProvider("GLOBAL", nowMs);
  const price = await readPriceProvider("EURUSD", "M15", nowMs);

  const countrySet = new Set<string>();
  const currencySet = new Set<string>();
  let symbols = 0;
  let synthetics = 0;
  for (const m of ARX_FOCUS_MARKETS) {
    if (m.category === "synthetic") {
      synthetics++;
      continue;
    }
    symbols++;
    const geo = getSymbolGeography(m.canonicalSymbol);
    if (!geo) continue;
    geo.countries.forEach((c) => countrySet.add(c));
    geo.currencies.forEach((c) => currencySet.add(c));
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    providers: [
      {
        kind: "price",
        name: price.provider,
        configured: price.source.configured,
        connected: price.source.connected,
        apiKeyPresent: price.source.configured,
        lastFetchAt: price.updatedAt,
        lastError: null,
        recordCount: price.candleCount,
        freshness: price.freshness,
      },
      {
        kind: "news",
        name: news.provider,
        configured: news.configured,
        connected: news.connected,
        apiKeyPresent: news.apiKeyPresent,
        lastFetchAt: news.updatedAt,
        lastError: news.lastError,
        recordCount: news.itemCount,
        highImpactCount: news.highImpactCount,
        freshness: news.freshness,
      },
      {
        kind: "calendar",
        name: calendar.provider,
        configured: calendar.configured,
        connected: calendar.connected,
        apiKeyPresent: calendar.configured,
        lastFetchAt: null,
        lastError: null,
        recordCount: calendar.eventCount,
        freshness: calendar.connected ? "LIVE" : "UNAVAILABLE",
      },
    ],
    coverage: {
      countries: countrySet.size,
      currencies: currencySet.size,
      symbols,
      synthetics,
    },
  };
}
