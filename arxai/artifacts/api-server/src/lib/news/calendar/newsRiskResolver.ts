// News-risk resolution against the REAL economic calendar.
//
// The single seam between "which events actually exist" and "what does that mean
// for this symbol". Every HTTP surface that wants a news-risk verdict but has no
// event set of its own goes through here, so the honesty contract is enforced in
// one place:
//
//   provider connected      ⇒ score the real events (an empty window is a real
//                             "no events" read → calendarAvailable:true)
//   provider missing/errored ⇒ newsRiskUnavailable — no countdown, no event,
//                             never blockTrading, calendarAvailable:false
//
// Nothing here fabricates events. The previous behaviour — `scoreNewsRisk(symbol)`
// defaulting to `getMockEvents(2)` — let an unconfigured deployment publish
// "HIGH impact FOMC Rate Decision in 23m — trading blocked" from invented data.
//
// Read/risk-context only: imports nothing from the execution path, MT5 bridge,
// broker dispatch, or any safety gate.

import type { EconomicEvent } from "./economicEvents.js";
import {
  isSyntheticNewsSymbol,
  newsRiskUnavailable,
  scoreNewsRisk,
  type NewsRisk,
} from "./newsRiskScorer.js";
import { getEconomicCalendarResult } from "./economicCalendarService.js";
import { toMockShapeEvents } from "./calendarAdapters.js";

/** The scorer only reasons about a ±90m window; 2 days is ample headroom. */
const DEFAULT_DAYS_AHEAD = 2;

export interface ResolvedNewsRiskEvents {
  /** True only when a calendar provider is configured AND reachable. */
  available: boolean;
  /** Real events in scorer shape. Always `[]` when `available` is false. */
  events: EconomicEvent[];
  /** Operator-readable status ("…provider missing", "…provider error", etc). */
  reason: string;
  /** Provider label for diagnostics/UI. */
  provider: string;
}

/**
 * Resolve the real calendar once. Callers enriching many symbols should call
 * this a single time and hand `events` to `scoreNewsRisk` per symbol rather than
 * resolving per row (the underlying service caches for 5 min, but one read keeps
 * every row in a batch on one consistent snapshot).
 */
export async function resolveNewsRiskEvents(
  opts: { daysAhead?: number } = {},
): Promise<ResolvedNewsRiskEvents> {
  const daysAhead = opts.daysAhead ?? DEFAULT_DAYS_AHEAD;
  try {
    const result = await getEconomicCalendarResult({ daysAhead });
    if (!result.connected) {
      return { available: false, events: [], reason: result.message, provider: result.provider };
    }
    return {
      available: true,
      events: toMockShapeEvents(result.events),
      reason: result.message,
      provider: result.provider,
    };
  } catch {
    // getEconomicCalendarResult is documented never to throw, but a resolver on
    // the honesty path must not turn an unexpected failure into a fake "clear".
    return {
      available: false,
      events: [],
      reason: "Economic calendar unavailable — news risk could not be read.",
      provider: "unknown",
    };
  }
}

/** Score one symbol against the real calendar, honest when it is unreadable. */
export async function resolveNewsRiskForSymbol(
  symbol: string,
  opts: { daysAhead?: number } = {},
): Promise<NewsRisk> {
  // Synthetics are unaffected by macro news — no provider read is needed and the
  // verdict is genuinely known, so short-circuit before touching the calendar.
  if (isSyntheticNewsSymbol(symbol)) return scoreNewsRisk(symbol, []);
  const resolved = await resolveNewsRiskEvents(opts);
  return newsRiskFrom(symbol, resolved);
}

/** Apply an already-resolved event set to one symbol (batch enrichment path). */
export function newsRiskFrom(symbol: string, resolved: ResolvedNewsRiskEvents): NewsRisk {
  if (!resolved.available) return newsRiskUnavailable(symbol, resolved.reason);
  return scoreNewsRisk(symbol, resolved.events);
}
