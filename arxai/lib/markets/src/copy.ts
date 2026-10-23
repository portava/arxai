// User-safe market copy. These are the ONLY labels a regular user may ever
// see for market availability/status. Never leak internal tokens
// (aiUsable, feedStatus, provider slot, simulator, mt5Provider,
// arx_symbol_specs, route names, internal IDs).

export const ARX_MARKET_COPY = {
  available: "Available",
  delayed: "Delayed",
  noDataYet: "Data not available yet.",
  brokerNotConfirmed: "Broker symbol not confirmed.",
  analysisOnly: "Analysis only",
  notInArx: "That market is not available in ARX right now.",
  waitingForFeed: "Waiting for verified feed.",
  approvedNoData: "That market is approved for ARX, but data is not available yet.",
} as const;

export type ArxMarketCopyKey = keyof typeof ARX_MARKET_COPY;

/** Tokens that must NEVER appear in user-facing market copy. */
export const FORBIDDEN_USER_MARKET_TOKENS: readonly string[] = [
  "aiUsable",
  "feedStatus",
  "simulator",
  "mt5Provider",
  "arx_symbol_specs",
  "providerSlot",
  "mt5_broker",
  "deriv",
  "twelvedata",
  "polygon",
  "alphavantage",
];
