// Indices + Synthetic Center backend — honest not-connected state.
//
// FEATURE TRUTH AUDIT (P0-4). This module previously fabricated market data and
// served it, unlabeled, to auto-refreshing pages:
//
//   - VIX was invented: `14 + Math.random() * 8`, then published as
//     `vixEstimate` AND used to derive the "Risk-On / Risk-Off" regime;
//   - the US 10Y bond yield was invented: `4.45 + (Math.random() - 0.5) * 0.3`,
//     then published as `bondYield10Y` and used to derive a yield bias;
//   - per-index CONFIDENCE was invented: `... + Math.random() * 10`;
//   - `currentLevel` was a hardcoded 2024-era index level jittered by
//     `(Math.random() - 0.5) * level * 0.002` and rendered as the index's
//     current price;
//   - `dollarStrength` and `fedExpectation` were hardcoded constants ("Strong",
//     "Neutral") presented as current macro readings;
//   - `getSyntheticAnalysis()` published hardcoded ATR values (64.2, 82.5, 4.8)
//     and trend labels ("Uptrend", "Sideways") as live synthetic-market
//     readings, plus a "Recommended Lot Size" derived from them.
//
// The pages refreshed every 30s, so invented numbers visibly "moved" like a
// live feed and a trader had no way to tell them from real data. ARX has one
// rule here and `pages/stocks-center.tsx` already follows it: **ARX never
// displays fabricated signals.** The resolution is an honest not-connected
// state, NOT a "SIMULATED" badge on invented numbers.
//
// No equity-index or synthetic-index market-data provider is wired to these
// endpoints. Until one is, they report `providerConnected: false` with empty
// data and a `safetyNote`. Nothing here invents a number.
//
// `session` is retained deliberately: it comes from the UTC clock via
// strategyEngine's `detectSession`, so it is a fact rather than a fabrication.

import { detectSession } from "./strategyEngine.js";

export interface IndicesIntelligenceResult {
  /** False until a real index market-data provider is configured. */
  providerConnected: false;
  /** User-safe explanation of why the data set is empty. */
  safetyNote: string;
  /** Clock-derived session label — a fact, not a market-data reading. */
  session: string;
  /** Always empty while no provider is connected. Never partially populated. */
  indices: [];
}

export interface SyntheticAnalysisResult {
  /** False until a real synthetic-index market-data provider is configured. */
  providerConnected: false;
  safetyNote: string;
  /** Always empty while no provider is connected. */
  symbols: [];
}

export const INDICES_PROVIDER_NOT_CONNECTED_NOTE =
  "No live equity-index market-data provider is connected. ARX does not display fabricated " +
  "market data, so index levels, VIX, bond yields, bias and confidence are withheld rather " +
  "than estimated.";

export const SYNTHETIC_PROVIDER_NOT_CONNECTED_NOTE =
  "No live synthetic-index analytics provider is connected. ARX does not display fabricated " +
  "market data, so ATR, trend and volatility readings are withheld rather than estimated. " +
  "Synthetic instruments remain fully tradable on the Scanner, which uses real broker data.";

/**
 * Indices intelligence. Returns the honest not-connected state.
 *
 * INVARIANT: no randomness, no hardcoded index levels, no hardcoded macro
 * readings, no invented confidence. Wire a real provider instead of restoring
 * any of those.
 */
export function getIndicesIntelligence(): IndicesIntelligenceResult {
  return {
    providerConnected: false,
    safetyNote: INDICES_PROVIDER_NOT_CONNECTED_NOTE,
    session: detectSession(),
    indices: [],
  };
}

/**
 * Synthetic-index analysis. Returns the honest not-connected state.
 *
 * INVARIANT: no hardcoded ATR / trend / volatility readings, and no lot-size
 * recommendation derived from them.
 */
export function getSyntheticAnalysis(): SyntheticAnalysisResult {
  return {
    providerConnected: false,
    safetyNote: SYNTHETIC_PROVIDER_NOT_CONNECTED_NOTE,
    symbols: [],
  };
}
