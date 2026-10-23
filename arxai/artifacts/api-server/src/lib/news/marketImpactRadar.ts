// Market Impact Radar (Task #197) — maps real economic events onto the selected
// symbol with severity + countdown, and derives the honest news behavior.
//
// HONESTY (inviolable):
//  - The radar surfaces economic events ONLY from a connected, REAL
//    economic-calendar provider. No such provider is wired in this environment
//    (the canonical news service reports `dataSources.calendar.connected:false`,
//    provider "mock_economic_calendar"), so the radar is honestly EMPTY here —
//    we NEVER fabricate a scheduled macro event, a forecast, or an `actual`
//    result, and therefore can never raise an actionable (Critical/High) alert
//    from synthetic data. The `buildRadarEvents` domain gate enforces this.
//  - This mirrors the reserved `mt5_broker` market-data slot: the moment a real
//    calendar provider (Trading Economics / FRED) is connected, pass its events
//    + `calendarConnected:true` into `buildRadarEvents` and the radar lights up
//    with zero other changes.
//  - The radar's `provider.connected` reflects whether the real
//    economic-CALENDAR feed is connected (not headlines). Headline connection is
//    tracked separately and surfaced in the note.
//  - Synthetic / non-real-world instruments (e.g. Deriv Volatility indices) are
//    immune to real-world macro events — they never map to an event.
//  - Advisory only. Nothing here gates, slows, or places a trade.

import {
  buildRadarEvents,
  deriveNewsBehavior,
  severityRank,
  type MarketImpactRadar,
  type NewsRadarEvent,
  type NewsRadarSeverity,
  type RawCalendarEvent,
  type SmartChartNewsBehavior,
} from "@workspace/domain/smart-chart";
import { getNewsIntelligence } from "./newsIntelligenceService.js";
import { getEconomicCalendar, type CalendarProviderState } from "./economicCalendarProvider.js";

export interface MarketImpactRadarResult {
  radar: MarketImpactRadar;
  behavior: SmartChartNewsBehavior;
}

/**
 * Synthetic instruments are not driven by real-world economic events. We detect
 * the common Deriv synthetic families by name so the radar never pretends a
 * macro event moves a volatility index.
 */
function isSyntheticSymbol(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return (
    s.includes("VOLATILITY") ||
    s.includes("CRASH") ||
    s.includes("BOOM") ||
    s.includes("JUMP") ||
    s.includes("STEP") ||
    /\bR_\d+\b/.test(s) ||
    /\b(1S)\b/.test(s)
  );
}

/**
 * Build the Market Impact Radar + news behavior for a symbol. Reads the real
 * news-provider connection state and the scheduled economic calendar; maps each
 * event onto the symbol; classifies severity and countdown; and derives how the
 * news window should colour the read.
 */
export async function buildMarketImpactRadar(
  symbolRaw: string,
  nowMs: number = Date.now(),
): Promise<MarketImpactRadarResult> {
  const symbol = symbolRaw.trim().toUpperCase();
  const synthetic = isSyntheticSymbol(symbol);

  // Scheduled events + connection state come together from the real
  // economic-calendar provider seam (single source of truth — events can never
  // drift out of sync with the connected flag). The headline feed is tracked
  // separately, only for the honest note. Neither is fabricated.
  let calendarConnected = false;
  let calendarProvider = "none";
  let calendarProviderState: CalendarProviderState = "not_configured";
  let rawEvents: RawCalendarEvent[] = [];
  let headlinesConnected = false;
  try {
    const calendar = await getEconomicCalendar(symbol, nowMs);
    calendarConnected = calendar.connected;
    calendarProvider = calendar.provider;
    calendarProviderState = calendar.providerState;
    // Real-or-absent: only trust the provider's events when it reports connected.
    rawEvents = calendar.connected ? calendar.events : [];
  } catch {
    calendarConnected = false;
    calendarProvider = "unavailable";
    calendarProviderState = "fetch_error";
    rawEvents = [];
  }
  try {
    const pack = await getNewsIntelligence(symbol);
    headlinesConnected = pack.dataSources.headlines.connected;
  } catch {
    headlinesConnected = false;
  }

  // Honesty gate: `buildRadarEvents` returns [] whenever `calendarConnected` is
  // false, regardless of `rawEvents` — no fabricated macro events, no actionable
  // alerts from a disconnected/synthetic source.
  const events: NewsRadarEvent[] = buildRadarEvents({
    calendarConnected,
    rawEvents,
    symbol,
    synthetic,
    nowMs,
  });

  // Sort: affecting first, then by absolute proximity to now.
  events.sort((a, b) => {
    if (a.affectsSymbol !== b.affectsSymbol) return a.affectsSymbol ? -1 : 1;
    return Math.abs(a.countdownSeconds) - Math.abs(b.countdownSeconds);
  });

  const affecting = events.filter((e) => e.affectsSymbol);
  let topSeverity: NewsRadarSeverity | null = null;
  for (const e of affecting) {
    if (topSeverity == null || severityRank(e.severity) > severityRank(topSeverity)) {
      topSeverity = e.severity;
    }
  }
  const highImpactWindowActive = affecting.some(
    (e) =>
      (e.severity === "CRITICAL" || e.severity === "HIGH") &&
      (e.state === "LIVE" || e.state === "IMMINENT"),
  );

  // Behavior is driven by the real economic-calendar connection (not headlines):
  // with no calendar connected the read is honestly technicals-only.
  const behavior = deriveNewsBehavior(calendarConnected, events);

  const summary = buildSummary(
    synthetic,
    calendarConnected,
    affecting,
    topSeverity,
    highImpactWindowActive,
  );

  return {
    radar: {
      symbol,
      provider: {
        connected: calendarConnected,
        name: calendarProvider,
        note: calendarConnected
          ? "Live economic-calendar feed connected. Events are mapped to this symbol with severity and countdown."
          : calendarProviderState === "fetch_error"
            ? "Economic-calendar provider is configured but the last fetch failed — events unavailable until the next successful refresh."
            : headlinesConnected
              ? "Live headlines are connected, but no live economic-calendar provider is configured — no scheduled events are shown (none are fabricated)."
              : "No live economic-calendar provider is configured — no scheduled events are shown (none are fabricated). Confirmed headlines and results are not available.",
      },
      events,
      topSeverity,
      highImpactWindowActive,
      summary,
    },
    behavior,
  };
}

function buildSummary(
  synthetic: boolean,
  providerConnected: boolean,
  affecting: readonly NewsRadarEvent[],
  topSeverity: NewsRadarSeverity | null,
  highImpactWindowActive: boolean,
): string {
  if (synthetic) {
    return "This is a synthetic instrument — it is not driven by real-world economic events.";
  }
  if (affecting.length === 0) {
    return providerConnected
      ? "No scheduled economic events are mapped to this symbol right now."
      : "No live economic-calendar provider is connected, so no scheduled events are shown for this symbol.";
  }
  const next = affecting[0]!;
  const mins = Math.round(Math.abs(next.countdownSeconds) / 60);
  const when =
    next.countdownSeconds >= 0
      ? `in about ${mins} min`
      : `about ${mins} min ago`;
  if (highImpactWindowActive) {
    return `High-impact window active: ${next.title} (${next.currency}) ${when}. Expect wider spreads and faster moves.`;
  }
  const sevWord =
    topSeverity === "CRITICAL" || topSeverity === "HIGH"
      ? "High-impact"
      : topSeverity === "MEDIUM"
        ? "Medium-impact"
        : "Low-impact";
  return `${sevWord} event mapped: ${next.title} (${next.currency}) ${when}.`;
}
