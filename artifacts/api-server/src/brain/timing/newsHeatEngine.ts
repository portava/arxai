// News-Adjusted Heat Engine.
//
// Consumes the existing news-risk scorer and economic calendar provider to
// compute: news phase, event-type personality, surprise score (only when
// actual result data is available, never fabricated), and a news-risk
// overlay (additive delta) on heat.
//
// Reuses existing services — does NOT duplicate calendar logic.
// Advisory only. Never an execution gate.

import type { NewsOverlay, NewsPhase } from "@workspace/domain/timing-brain";
import { analyzeNewsRisk } from "../news/newsRiskEngine.js";
import { buildMarketImpactRadar } from "../../lib/news/marketImpactRadar.js";
import { classifySymbol } from "../../lib/data/marketDataRouter.js";

/**
 * Optional dependency injection for testing. Production callers pass nothing and
 * get the real classifier + news-risk engine + market-impact radar. Tests inject
 * deterministic stand-ins so the overlay never depends on the wall clock or a
 * live calendar/headline provider.
 */
export interface NewsHeatDeps {
  classify?: (symbol: string) => string;
  analyzeNewsRiskFn?: typeof analyzeNewsRisk;
  buildRadarFn?: typeof buildMarketImpactRadar;
}

/**
 * The news overlay plus whether a real economic-calendar provider answered.
 * `calendarConnected` is about the PROVIDER, not about whether an event is
 * near: a connected calendar with nothing scheduled is still news data.
 */
export type NewsHeatResult = NewsOverlay & { calendarConnected: boolean };

export async function computeNewsHeat(symbol: string, deps: NewsHeatDeps = {}): Promise<NewsHeatResult> {
  const classify = deps.classify ?? classifySymbol;
  const analyzeNewsRiskFn = deps.analyzeNewsRiskFn ?? analyzeNewsRisk;
  const buildRadarFn = deps.buildRadarFn ?? buildMarketImpactRadar;
  const isSynthetic = classify(symbol) === "synthetic";

  // Synthetic instruments are immune to real-world economic news
  if (isSynthetic) {
    return {
      phase: "NONE",
      eventName: null,
      minutesUntil: null,
      minutesSince: null,
      eventType: "none",
      surpriseScore: null,
      heatAdjustment: 0,
      blocksTrade: false,
      calendarConnected: false,
    };
  }

  // Use the existing news risk engine (schedule-based)
  const category = classify(symbol) === "forex" ? "forex" : "other";
  const newsRisk = analyzeNewsRiskFn(symbol, category);

  // Build market impact radar (real calendar provider — honest empty when disconnected)
  let calendarConnected = false;
  let radarPhase: NewsPhase = "NONE";
  let radarEventName: string | null = null;
  let minutesUntil: number | null = null;
  let minutesSince: number | null = null;
  let heatAdjustment = 0;

  try {
    const { radar } = await buildRadarFn(symbol);
    calendarConnected = radar.provider.connected;

    if (calendarConnected && radar.events.length > 0) {
      const topEvent = radar.events[0]!;
      radarEventName = topEvent.title;
      const secsRemaining = topEvent.countdownSeconds;
      // The radar's state is the authority on whether the release has
      // happened. A date-only release (FRED midnight sentinel) is held
      // UPCOMING/IMMINENT all day while its countdown runs from midnight, so a
      // negative countdown there does NOT mean the release is past: treat it
      // as pre-event with no known minute count.
      const releaseTimeUnconfirmed =
        (topEvent.state === "UPCOMING" || topEvent.state === "IMMINENT") && secsRemaining <= 30;
      if (releaseTimeUnconfirmed) {
        radarPhase = "PRE_EVENT";
      } else if (secsRemaining > 30) {
        minutesUntil = Math.round(secsRemaining / 60);
        radarPhase = minutesUntil <= 30 ? "PRE_EVENT" : "NONE";
      } else if (secsRemaining >= -900) {
        // Within 15 min after start → treat as AT_EVENT
        radarPhase = "AT_EVENT" as const;
        minutesSince = Math.round(Math.abs(secsRemaining) / 60);
      } else {
        minutesSince = Math.round(Math.abs(secsRemaining) / 60);
        radarPhase = minutesSince <= 60 ? "POST_EVENT" : "SETTLED";
      }
      // Only high-impact affects heat significantly
      const isAtEvent = radarPhase === ("AT_EVENT" as typeof radarPhase);
      if (topEvent.severity === "CRITICAL" || topEvent.severity === "HIGH") {
        heatAdjustment = isAtEvent ? 30
          : radarPhase === "PRE_EVENT" ? 15
          : radarPhase === "POST_EVENT" ? 20
          : 5;
      } else if (topEvent.severity === "MEDIUM") {
        heatAdjustment = isAtEvent ? 15 : 5;
      }
    }
  } catch {
    // Fail-open: calendar error → no heat adjustment
  }

  // Fallback: use the schedule-based news risk engine
  if (!calendarConnected) {
    if (newsRisk.majorNewsSoon) {
      radarEventName = newsRisk.nextEvent ?? null;
      if (newsRisk.riskLevel === "Critical" || newsRisk.riskLevel === "High") {
        radarPhase = "PRE_EVENT";
        heatAdjustment = 20;
      } else if (newsRisk.riskLevel === "Medium") {
        radarPhase = "PRE_EVENT";
        heatAdjustment = 8;
      }
    }
  }

  // Determine event type
  let eventType: NewsOverlay["eventType"] = "none";
  if (radarEventName) {
    const lower = radarEventName.toLowerCase();
    if (lower.includes("fomc") || lower.includes("rate") || lower.includes("cpi") || lower.includes("nfp") || lower.includes("payroll")) {
      eventType = "high_impact";
    } else if (lower.includes("pmi") || lower.includes("gdp") || lower.includes("retail") || lower.includes("jobless")) {
      eventType = "medium_impact";
    } else {
      eventType = "low_impact";
    }
  }

  return {
    phase: radarPhase,
    eventName: radarEventName,
    minutesUntil,
    minutesSince,
    eventType,
    surpriseScore: null, // never fabricated — no actual result data available without a real provider
    heatAdjustment,
    blocksTrade: newsRisk.blockTrading,
    calendarConnected,
  };
}
