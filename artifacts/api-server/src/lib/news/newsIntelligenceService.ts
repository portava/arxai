// MarketNewsIntelligenceService — fuses existing news provider + economic
// calendar + news risk scorer into a single normalized pack for the scanner,
// Ruby, and the trade-ticket news-risk panel.
//
// SAFETY:
//   - Pure read-side. Never places trades, never writes to live tables.
//   - Real providers only. If a feed is unavailable, fields are marked
//     unavailable — we never fabricate headlines or events.
//   - 60s in-memory cache per symbol to respect provider rate limits.

import { getMarketProvider } from "../assistant/marketProvider.js";
import type { NewsItem } from "../assistant/marketProvider.js";
import type { EconomicEvent } from "./calendar/economicEvents.js";
import { scoreNewsRisk, type NewsRisk } from "./calendar/newsRiskScorer.js";
import { getEconomicCalendar } from "./economicCalendarProvider.js";
import {
  buildRadarEvents,
  escalateNewsRiskLevel,
  isSyntheticInstrument,
  topAffectingSeverity,
  type RawCalendarEvent,
} from "@workspace/domain/smart-chart";

export type NewsRiskLevel = "none" | "low" | "medium" | "high" | "critical";
export type NewsBias = "bullish" | "bearish" | "mixed" | "unclear";

export interface NewsHeadline {
  headline: string;
  source: string;
  url: string | null;
  publishedAt: string;
}

export interface UpcomingEventSummary {
  title: string;
  currency: string;
  impact: "low" | "medium" | "high";
  eventTimeIso: string;
  minutesUntil: number;
}

export interface NewsIntelligencePack {
  symbol: string;
  generatedAt: string;
  riskLevel: NewsRiskLevel;
  bias: NewsBias;
  timing: "now" | "upcoming" | "recent" | "quiet";
  warningSummary: string;
  recommendation: "watch" | "wait" | "avoid" | "proceed_with_caution";
  upcomingEvent: UpcomingEventSummary | null;
  recentHeadlines: NewsHeadline[];
  affectedCurrencies: string[];
  dataSources: {
    headlines: { connected: boolean; provider: string; count: number };
    calendar: {
      connected: boolean;
      provider: string;
      /** Explicit provider state — use this for UX copy, not just `connected`. */
      providerState: import("./economicCalendarProvider.js").CalendarProviderState;
      note: string;
    };
    social: { connected: boolean; provider: string; note: string };
  };
  safetyNote: string;
}

const CACHE = new Map<string, { at: number; pack: NewsIntelligencePack }>();
const CACHE_TTL_MS = 60 * 1000;

const BULL_WORDS = ["surge", "rally", "soar", "jump", "beat", "rise", "gain", "strong", "bullish", "hawkish", "upside"];
const BEAR_WORDS = ["plunge", "fall", "drop", "miss", "weak", "bearish", "dovish", "decline", "slump", "tumble", "downside", "crash"];

function deriveBiasFromHeadlines(items: NewsHeadline[]): NewsBias {
  if (items.length === 0) return "unclear";
  let bull = 0, bear = 0;
  for (const h of items.slice(0, 8)) {
    const t = h.headline.toLowerCase();
    if (BULL_WORDS.some((w) => t.includes(w))) bull++;
    if (BEAR_WORDS.some((w) => t.includes(w))) bear++;
  }
  if (bull === 0 && bear === 0) return "unclear";
  if (bull > 0 && bear === 0) return "bullish";
  if (bear > 0 && bull === 0) return "bearish";
  return "mixed";
}

function mapRiskLevel(r: NewsRisk): NewsRiskLevel {
  if (r.blockTrading) return "critical";
  return r.riskLevel;
}

function deriveTiming(r: NewsRisk): NewsIntelligencePack["timing"] {
  if (r.minutesUntilEvent == null) return "quiet";
  const m = r.minutesUntilEvent;
  if (m >= -15 && m <= 15) return "now";
  if (m < -15) return "recent";
  return "upcoming";
}

function deriveRecommendation(
  risk: NewsRiskLevel,
  timing: NewsIntelligencePack["timing"],
): NewsIntelligencePack["recommendation"] {
  if (risk === "critical") return "avoid";
  if (risk === "high" && timing === "now") return "wait";
  if (risk === "high") return "watch";
  if (risk === "medium") return "proceed_with_caution";
  return "watch";
}

/**
 * Exported for the honesty unit test (`__qa__/newsRiskFabrication.test.ts`).
 *
 * Honesty contract: a "none" risk read with the economic-calendar feed
 * DISCONNECTED means the system is blind to scheduled events, not that the
 * window is quiet — the summary must say "unknown", never assert
 * "No major scheduled news" (a real high-impact event could be minutes away).
 */
export function summarizeWarning(
  symbol: string,
  riskLevel: NewsRiskLevel,
  upcoming: UpcomingEventSummary | null,
  bias: NewsBias,
  calendarConnected: boolean,
): string {
  if (riskLevel === "critical" && upcoming) {
    return `${upcoming.impact.toUpperCase()}-impact ${upcoming.title} window active for ${symbol}. Wait for the dust to settle.`;
  }
  if (upcoming && riskLevel !== "none") {
    const when = upcoming.minutesUntil >= 0
      ? `in ${upcoming.minutesUntil}m`
      : `${Math.abs(upcoming.minutesUntil)}m ago`;
    return `${upcoming.title} (${upcoming.currency}) ${when} — ${riskLevel} news risk on ${symbol}. Bias from headlines: ${bias}.`;
  }
  if (riskLevel === "none") {
    if (!calendarConnected) {
      return `Economic-calendar feed unavailable — scheduled-news risk for ${symbol} is unknown, not confirmed quiet.`;
    }
    return `No major scheduled news for ${symbol} in the current window.`;
  }
  return `${riskLevel.toUpperCase()} news risk on ${symbol}. Headline bias: ${bias}.`;
}

function summarizeUpcoming(e: EconomicEvent, minutesUntil: number): UpcomingEventSummary {
  return {
    title: e.title,
    currency: e.currency,
    impact: e.impact,
    eventTimeIso: e.eventTime,
    minutesUntil,
  };
}

// Map a REAL calendar-provider event into the scorer's shape. We never fabricate
// forecast / actual / previous values — those stay null unless a real provider
// supplies them — so the news-risk score is driven only by genuine scheduled
// events, never a built-in mock schedule.
function rawToEconomicEvent(e: RawCalendarEvent): EconomicEvent {
  return {
    id: e.id,
    title: e.title,
    country: "",
    currency: e.currency,
    impact: e.impact,
    actual: null,
    forecast: null,
    previous: null,
    eventTime: e.eventTimeIso,
    affectedMarkets: e.affectedMarkets,
    source: "economic_calendar",
  };
}

export async function getNewsIntelligence(
  symbolRaw: string,
): Promise<NewsIntelligencePack> {
  const symbol = symbolRaw.trim().toUpperCase();
  const cached = CACHE.get(symbol);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.pack;
  }

  const provider = getMarketProvider();
  let headlineFetch: { connected: boolean; items: NewsItem[]; provider: string };
  try {
    headlineFetch = await provider.getMarketNews(symbol, 8);
  } catch {
    headlineFetch = { connected: false, items: [], provider: "error" };
  }

  // Honest-data invariant: if the provider reports disconnected, never
  // surface its payload — emit empty headlines and count=0 regardless of
  // what bytes came back. Prevents stale/synthetic items leaking through.
  const recentHeadlines: NewsHeadline[] = headlineFetch.connected
    ? headlineFetch.items.map((i) => ({
        headline: i.headline,
        source: i.source,
        url: i.url || null,
        publishedAt: i.publishedAt,
      }))
    : [];

  // Economic calendar — the SINGLE real provider seam (getEconomicCalendar) is
  // the only source for both the scanner news-risk score AND the chart's Market
  // Impact Radar, so the two can never disagree. When no live provider is
  // connected it returns connected:false + an empty event list, so both surfaces
  // degrade to an honest "no scheduled news" instead of surfacing any built-in /
  // mock schedule (with its fabricated forecasts/actuals) as if it were real. We
  // never fabricate an event here. The moment a real provider is wired in
  // economicCalendarProvider.ts, both surfaces light up with zero changes here.
  const nowMs = Date.now();
  const synthetic = isSyntheticInstrument(symbol);
  let calendar: Awaited<ReturnType<typeof getEconomicCalendar>> = {
    connected: false,
    provider: "none",
    status: "missing",
    events: [],
    providerState: "not_configured",
  };
  try {
    calendar = await getEconomicCalendar(symbol, nowMs);
  } catch {
    // Honest: on any calendar read failure treat it as disconnected (no events)
    // rather than surfacing stale or invented schedule data.
  }

  // Base news-risk is scored ONLY from real, connected calendar events. A
  // disconnected calendar or a synthetic instrument yields no events → "none".
  const scorableEvents: EconomicEvent[] =
    calendar.connected && !synthetic
      ? calendar.events.map(rawToEconomicEvent)
      : [];
  const newsRisk = scoreNewsRisk(symbol, scorableEvents);

  const upcoming = newsRisk.upcomingEvent && newsRisk.minutesUntilEvent != null
    ? summarizeUpcoming(newsRisk.upcomingEvent, newsRisk.minutesUntilEvent)
    : null;

  let riskLevel = mapRiskLevel(newsRisk);

  // Reflect the Market Impact Radar's top affecting severity into the scanner
  // news-risk ladder from the SAME calendar snapshot, escalate-only (a
  // higher-severity macro window can raise the scanner risk, never lower it). A
  // disconnected calendar / synthetic instrument yields no affecting event →
  // null severity → risk untouched.
  try {
    const radarEvents = buildRadarEvents({
      calendarConnected: calendar.connected,
      rawEvents: calendar.connected ? calendar.events : [],
      symbol,
      synthetic,
      nowMs,
    });
    riskLevel = escalateNewsRiskLevel(riskLevel, topAffectingSeverity(radarEvents));
  } catch {
    // Honest: on any failure leave the scanner risk untouched rather than
    // inventing a higher severity.
  }

  const timing = deriveTiming(newsRisk);
  const bias = deriveBiasFromHeadlines(recentHeadlines);
  const recommendation = deriveRecommendation(riskLevel, timing);
  const warningSummary = summarizeWarning(symbol, riskLevel, upcoming, bias, calendar.connected);

  const pack: NewsIntelligencePack = {
    symbol,
    generatedAt: new Date().toISOString(),
    riskLevel,
    bias,
    timing,
    warningSummary,
    recommendation,
    upcomingEvent: upcoming,
    recentHeadlines,
    affectedCurrencies: newsRisk.affectedSymbols,
    dataSources: {
      headlines: {
        connected: headlineFetch.connected,
        provider: headlineFetch.provider,
        count: recentHeadlines.length,
      },
      calendar: {
        connected: calendar.connected,
        provider: calendar.provider,
        providerState: calendar.providerState,
        note: calendar.connected
          ? "Live economic-calendar provider connected — scheduled events are real."
          : calendar.providerState === "fetch_error"
            ? "Economic-calendar provider is configured but the last fetch failed — no scheduled events until reconnected."
            : "No live economic-calendar provider (Trading Economics / FRED) is configured, so no scheduled events are shown.",
      },
      social: {
        connected: false,
        provider: "none",
        note: "Social/X feed monitoring is not configured. Configure X API to enable.",
      },
    },
    safetyNote:
      "Decision support only. Do not invent headlines or events beyond what is listed here. If a feed is marked unavailable, say so honestly.",
  };

  CACHE.set(symbol, { at: Date.now(), pack });
  return pack;
}
