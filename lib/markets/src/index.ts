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
