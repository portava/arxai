// FX Center backend — honest not-connected state.
//
// FEATURE TRUTH AUDIT (P0-4). This module previously fabricated market data and
// served it, unlabeled, to an auto-refreshing page:
//
//   - `computeStrength()` added `(Math.random() - 0.5) * 6` to a hardcoded
//     BASE_STRENGTH table and published the result as a live currency-strength
//     score (rendered as a filled strength bar and a 0-100 number);
//   - `getRiskSentiment()` returned a coin flip — `Math.random() > 0.5 ?
//     "Risk-On" : "Neutral"` — during the New York session;
//   - the pair table derived macro bias, technical bias and a CONFIDENCE
//     percentage from those invented strengths.
//
// A trader cannot tell fabricated numbers from real ones, and the page
// refreshed every 30s, so the fake strengths visibly "moved" like a live feed.
// ARX has one rule here and `pages/stocks-center.tsx` already follows it:
// **ARX never displays fabricated signals.** The resolution is an honest
// not-connected state, NOT a "SIMULATED" badge on invented numbers.
//
// No FX macro / currency-strength provider is wired. Until one is, these
// endpoints report `providerConnected: false` with empty data and a
// `safetyNote`. Nothing here invents a number.
//
// `session` is retained deliberately: it is derived from the UTC clock, not
// from market data, so it is a fact rather than a fabrication.

/** The active FX session, derived purely from the UTC clock (not market data). */
export type ForexSession = "Sydney" | "Tokyo" | "London" | "New York" | "Late New York";

export interface ForexIntelligenceResult {
  /** False until a real FX macro provider is configured. Never true today. */
  providerConnected: false;
  /** User-safe explanation of why the data set is empty. */
  safetyNote: string;
  /** Clock-derived session label — a fact, not a market-data reading. */
  session: ForexSession;
  /** Always empty while no provider is connected. Never partially populated. */
  currencies: [];
  /** Always empty while no provider is connected. Never partially populated. */
  pairs: [];
}

export const FOREX_PROVIDER_NOT_CONNECTED_NOTE =
  "No live FX macro or currency-strength provider is connected. ARX does not display " +
  "fabricated market data, so currency strength, pair bias and confidence are withheld " +
  "rather than estimated.";

/** UTC-clock session label. Deterministic; no market data involved. */
export function detectForexSession(now: Date = new Date()): ForexSession {
  const hour = now.getUTCHours();
  if (hour >= 22 || hour < 1) return "Sydney";
  if (hour < 8) return "Tokyo";
  if (hour < 13) return "London";
  if (hour < 17) return "New York";
  return "Late New York";
}

/**
 * FX intelligence. Returns the honest not-connected state.
 *
 * INVARIANT: this function contains no randomness and no hardcoded market
 * levels, biases, strengths or confidence values. It must never be changed to
 * emit an estimated market number — wire a real provider instead.
 */
export function getForexIntelligence(): ForexIntelligenceResult {
  return {
    providerConnected: false,
    safetyNote: FOREX_PROVIDER_NOT_CONNECTED_NOTE,
    session: detectForexSession(),
    currencies: [],
    pairs: [],
  };
}
