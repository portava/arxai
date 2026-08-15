// @workspace/markets — canonical ARX Top 250 market universe.
//
// Single source of truth for which markets a regular user may see, search,
// scan, chart, or trade. Shared by the API server, the frontend, and scripts.
// Never derived from broker/provider output. Visibility / filtering /
// availability / resolution ONLY — never an execution gate.

export * from "./types.js";
export * from "./copy.js";
export { ARX_TOP_250 } from "./universe.js";
export {
  normalizeMarketInput,
  compactMarketKey,
  findMarketById,
  findMarketByStandardSymbol,
  isApprovedStandardSymbol,
  resolveUserMarketInput,
} from "./resolve.js";
export {
  intersectProviderSymbols,
  availabilityFromDataStatus,
  defaultUnavailable,
  getUserVisibleMarkets,
} from "./visibility.js";
export type { VisibleMarketsOptions } from "./visibility.js";

// ── Market model: trading calendar + expected move ──────────────────────────
// Additive and standalone. Both modules are pure arithmetic over instants and
// numbers the caller supplies: no I/O, no clock reads, and nothing imported
// from the dispatch/gate path. They answer "when is it open" and "how far is it
// likely to move" — they cannot place, size, or authorise a trade.
export {
  getTradingCalendar,
  venueOf,
  isSyntheticInstrument,
  wallClockMinutes,
  FX_WEEK_OPEN_MS,
  FX_WEEK_CLOSE_MS,
} from "./calendar.js";
export type { TradingCalendar, Venue, SessionName } from "./calendar.js";
export {
  synthSigma1min,
  synthVolIndex,
  varOverHorizon,
  sigmaOverHorizon,
  expectedRange,
  expectedNet,
  band,
  annualiseFromMinute,
  RANGE_COEFF,
  NET_COEFF,
  MINUTES_PER_YEAR,
} from "./expectedMove.js";
