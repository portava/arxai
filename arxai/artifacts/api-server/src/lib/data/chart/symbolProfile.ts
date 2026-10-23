// ARX Candle Truth Engine — Symbol Profile Directory (Phase 1)
//
// Provides per-symbol metadata consumed by the truth engine and candle
// normalization layer. Used to:
//   - Validate price precision (candles that look flat on a chart often have
//     wrong decimal scaling — e.g. a provider returning XAUUSD with the wrong
//     number of decimal places)
//   - Set outlier-detection thresholds (wick detection, spike detection)
//   - Confirm which timeframes are supported for this asset class
//   - Describe the market session (when bars should exist vs be absent)
//   - State the price basis (BID / MID / LAST / SYNTHETIC)
//   - Document OHLC availability (true bars vs tick-aggregate vs line-only)
//
// Source hierarchy (authority order):
//   1. Static in-code table — covers all known ARX symbols and common families.
//      These values are correct for the supported market families and are
//      reviewed against live data.
//   2. Per-asset-class defaults — when a symbol is unknown, derived from class.
//   (Runtime per-user DB overrides for digits/point from arx_symbol_specs are
//    applied by the caller on top of this profile when a DB row is available.)
//
// SAFETY: read-only, pure, no side effects, no DB calls, no network.

import type { AssetClass } from "../marketDataRouter.js";
import type { ChartTimeframe } from "./timeframes.js";
import type { PriceBasis } from "./candleNormalization.js";

// ── Documented candle source per market family (Steps 1–2 of the mission) ──
//
// FOREX (EURUSD, GBPUSD, …):
//   Source chain: mt5_broker (reserved, inactive) → assistant_real
//   Active provider: TwelveData REST API (TWELVEDATA_API_KEY) | Polygon (POLYGON_API_KEY)
//     | Finnhub (FINNHUB_API_KEY) | AlphaVantage (ALPHA_VANTAGE_API_KEY) | no feed
//   Data mode: LIVE when a key is configured; NO_FEED otherwise.
//   Price basis: MID (exchange last/midpoint; TwelveData uses composite bid-ask midpoint).
//   OHLC type: TRUE_OHLC — providers return O/H/L/C bars, not tick aggregates.
//   Update method: REST poll per chart request; no server-side push subscription.
//   Freshness: newest bar may trail by 1–2 intervals (polling, not streaming).
//   Supported TFs: M1–D1 (free tier limits — TwelveData free ≈ 800 req/day;
//     minute data may be absent for exotic pairs on free tier).
//   Symbol mapping: "EURUSD" → "EUR/USD" in TwelveData; see symbolNormalizer.ts.
//   Known limitations:
//     - Free TwelveData tier returns ≤800 candles/day total across all requests.
//     - AlphaVantage free tier: 5 req/min, no true intraday OHLC for forex.
//     - No server-side caching of historical candles between requests.
//
// METALS (XAUUSD, XAGUSD):
//   Same chain as FOREX. Symbol mapped as XAUUSD → provider-native symbol.
//   Price basis: MID (spot gold/silver mid price; NOT futures, NOT bid).
//   OHLC type: TRUE_OHLC when provider has it (TwelveData, Polygon have D1/H1
//     for gold; minute data sparser).
//   1D wick investigation finding (Step 8 — see candleTruthEngine.ts):
//     XAUUSD D1 bars near ~$1900–$2100 are REAL HISTORICAL DATA from 2023.
//     Gold was in that range before the 2024–2025 rally to ~$3200–$4300.
//     These bars are NOT bad ticks; they are legitimate price history.
//     The "abnormal downside wick" appearance is a Y-axis auto-scale issue
//     (Phase 2 scope). Quality flag applied: HISTORICAL_PERIOD_SHIFT when a
//     bar's price cluster is >40% below the recent 30-bar median.
//
// INDICES (US30, NAS100, SPX500, GER40, UK100, JP225):
//   Same chain as FOREX. TwelveData maps US30 → "DJI", NAS100 → "IXIC".
//   Price basis: LAST (index points; no bid/ask — indices are calculated values).
//   OHLC type: TRUE_OHLC.
//   Session: US indices — Mon–Fri 09:30–16:00 ET; gaps on weekends/holidays.
//   Known limitations: weekend/holiday gaps appear as "missing candles" in
//     the gap detector. The truth engine excludes non-trading-hours from the
//     gap count when session-aware mode is enabled (see missingCandleCount
//     in TimeframeTruthResult — currently raw count, session filtering: Phase 3).
//
// SYNTHETIC (V75, V25, BOOM500, CRASH500, STEP):
//   Source chain: mt5_broker (reserved) → deriv (WebSocket).
//   Active provider: Deriv WebSocket (DERIV_APP_ID required).
//   Data mode: LIVE when DERIV_APP_ID configured and connected; NO_FEED otherwise.
//   Price basis: SYNTHETIC (Deriv's own volatility algorithm; no real underlying).
//   OHLC type: TRUE_OHLC (Deriv generates real O/H/L/C OHLC bars).
//   Update method: WebSocket tick subscription + historical candle fetch.
//   Freshness: live ticks stream continuously when connected; bars complete on
//     bucket close.
//   Session: 24/7 — synthetic indices never close (no weekend/holiday gaps).
//   1-second variants (V10_1S, V25_1S …): same feed; tick rate much higher.
//   Known limitations: latency when re-subscribing after WS reconnect.
//
// CRYPTO (BTCUSDT, ETHUSDT, …):
//   Same chain as FOREX via assistant_real. Price basis: LAST.
//   Session: 24/7 — crypto never closes; missing candles are data gaps, not hours.
//
// STOCKS (AAPL, TSLA, MSFT, …):
//   Same chain as FOREX via assistant_real. Price basis: LAST.
//   Session: exchange-dependent (NYSE/NASDAQ: Mon–Fri 09:30–16:00 ET).
//
// MT5 BROKER SLOT (all asset classes, chain position 0):
//   Currently INACTIVE. EA v1.27 sends heartbeat + account + positions only.
//   No tick push implemented. The slot is reserved so that when EA v1.28+
//   starts pushing quotes, broker-primary routing activates with zero router
//   changes. Until then: mt5Provider.isConnected() returns false, the slot
//   fails fast with MT5_BROKER_FEED_NOT_ACTIVE, and the router falls through.

export type PriceBasisNote =
  | "MID"        // bid-ask midpoint or composite last (forex, metals)
  | "LAST"       // exchange last trade price (indices, stocks, crypto)
  | "BID"        // MT5 broker bid-based OHLC bars
  | "SYNTHETIC"; // Deriv volatility algorithm

export type OhlcSourceType =
  | "true_ohlc"       // provider returns real O/H/L/C bars for the timeframe
  | "tick_aggregated" // server builds OHLC from a tick stream in real-time
  | "line_only"       // provider returns only a price series (close only)
  | "unknown";

export interface SessionProfile {
  alwaysOpen: boolean;     // true for synthetics/crypto (24/7)
  openHourUtc: number | null;   // weekday open hour in UTC
  closeHourUtc: number | null;  // weekday close hour in UTC
  closedOnWeekends: boolean;
  note: string;
}

export interface SymbolProfile {
  symbol: string;
  displayName: string;
  assetClass: AssetClass;
  isSynthetic: boolean;

  // Price encoding
  pricePrecision: number;   // decimal places (e.g. 5 for EURUSD, 2 for XAUUSD, 0 for US30)
  pipSize: number;          // smallest tradeable unit (e.g. 0.0001 for EURUSD, 0.01 for XAUUSD)
  pointSize: number;        // MT5 "point" = pipSize/10 for forex (0.00001), = pipSize for metals/indices
  typicalSpreadPips: number; // typical bid-ask in pips; used as outlier-detection baseline

  // Data source characteristics
  priceBasis: PriceBasis;
  priceBasisNote: PriceBasisNote;
  ohlcSourceType: OhlcSourceType;

  // Timeframe support
  allowedTimeframes: ChartTimeframe[];
  minHistoryDepthHours: number;  // minimum history the provider should return

  // Session
  session: SessionProfile;

  // Outlier detection thresholds (multiples of ATR)
  spikeAtrMultiple: number;        // single-bar spike threshold
  wickRatioThreshold: number;      // wick-to-range ratio for abnormal wick flag
  historicalShiftThreshold: number; // price deviation from recent median (e.g. 0.4 = 40%)
}

// ── Static symbol table ──────────────────────────────────────────────────────

const FOREX_SESSION: SessionProfile = {
  alwaysOpen: false,
  openHourUtc: 0,
  closeHourUtc: 22, // approximate; forex is near-24h but closes Friday ~22:00 UTC
  closedOnWeekends: true,
  note: "Forex: Mon 00:00 UTC – Fri 22:00 UTC approximately; no weekend bars expected.",
};

const STOCK_US_SESSION: SessionProfile = {
  alwaysOpen: false,
  openHourUtc: 13,  // 09:30 ET = 13:30 UTC (approx)
  closeHourUtc: 20, // 16:00 ET = 20:00 UTC
  closedOnWeekends: true,
  note: "US equities: 09:30–16:00 ET (Mon–Fri). Extended hours data may differ by provider.",
};

const SYNTHETIC_SESSION: SessionProfile = {
  alwaysOpen: true,
  openHourUtc: null,
  closeHourUtc: null,
  closedOnWeekends: false,
  note: "Synthetic indices: 24/7, no session gaps expected.",
};

const CRYPTO_SESSION: SessionProfile = {
  alwaysOpen: true,
  openHourUtc: null,
  closeHourUtc: null,
  closedOnWeekends: false,
  note: "Crypto: 24/7, no session gaps. Missing candles are data gaps, not market closure.",
};

const ALL_TIMEFRAMES: ChartTimeframe[] = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];

const SYMBOL_TABLE: SymbolProfile[] = [
  // ── Forex Majors ──────────────────────────────────────────────────────────
  {
    symbol: "EURUSD", displayName: "Euro / US Dollar", assetClass: "forex", isSynthetic: false,
    pricePrecision: 5, pipSize: 0.0001, pointSize: 0.00001, typicalSpreadPips: 1.2,
    priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 30,
    session: FOREX_SESSION,
    spikeAtrMultiple: 6, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.3,
  },
  {
    symbol: "GBPUSD", displayName: "British Pound / US Dollar", assetClass: "forex", isSynthetic: false,
    pricePrecision: 5, pipSize: 0.0001, pointSize: 0.00001, typicalSpreadPips: 1.5,
    priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 30,
    session: FOREX_SESSION,
    spikeAtrMultiple: 6, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.3,
  },
  {
    symbol: "USDJPY", displayName: "US Dollar / Japanese Yen", assetClass: "forex", isSynthetic: false,
    pricePrecision: 3, pipSize: 0.01, pointSize: 0.001, typicalSpreadPips: 1.0,
    priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 30,
    session: FOREX_SESSION,
    spikeAtrMultiple: 6, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.3,
  },
  {
    symbol: "USDCHF", displayName: "US Dollar / Swiss Franc", assetClass: "forex", isSynthetic: false,
    pricePrecision: 5, pipSize: 0.0001, pointSize: 0.00001, typicalSpreadPips: 1.5,
    priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 30,
    session: FOREX_SESSION,
    spikeAtrMultiple: 6, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.3,
  },
  {
    symbol: "USDCAD", displayName: "US Dollar / Canadian Dollar", assetClass: "forex", isSynthetic: false,
    pricePrecision: 5, pipSize: 0.0001, pointSize: 0.00001, typicalSpreadPips: 1.5,
    priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 30,
    session: FOREX_SESSION,
    spikeAtrMultiple: 6, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.3,
  },
  {
    symbol: "AUDUSD", displayName: "Australian Dollar / US Dollar", assetClass: "forex", isSynthetic: false,
    pricePrecision: 5, pipSize: 0.0001, pointSize: 0.00001, typicalSpreadPips: 1.5,
    priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 30,
    session: FOREX_SESSION,
    spikeAtrMultiple: 6, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.3,
  },
  {
    symbol: "NZDUSD", displayName: "New Zealand Dollar / US Dollar", assetClass: "forex", isSynthetic: false,
    pricePrecision: 5, pipSize: 0.0001, pointSize: 0.00001, typicalSpreadPips: 1.8,
    priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 30,
    session: FOREX_SESSION,
    spikeAtrMultiple: 6, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.3,
  },
  {
    symbol: "EURJPY", displayName: "Euro / Japanese Yen", assetClass: "forex", isSynthetic: false,
    pricePrecision: 3, pipSize: 0.01, pointSize: 0.001, typicalSpreadPips: 1.5,
    priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 30,
    session: FOREX_SESSION,
    spikeAtrMultiple: 6, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.3,
  },
  {
    symbol: "GBPJPY", displayName: "British Pound / Japanese Yen", assetClass: "forex", isSynthetic: false,
    pricePrecision: 3, pipSize: 0.01, pointSize: 0.001, typicalSpreadPips: 2.0,
    priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 30,
    session: FOREX_SESSION,
    spikeAtrMultiple: 6, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.3,
  },
  {
    symbol: "EURGBP", displayName: "Euro / British Pound", assetClass: "forex", isSynthetic: false,
    pricePrecision: 5, pipSize: 0.0001, pointSize: 0.00001, typicalSpreadPips: 1.5,
    priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 30,
    session: FOREX_SESSION,
    spikeAtrMultiple: 6, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.3,
  },

  // ── Metals ────────────────────────────────────────────────────────────────
  // XAUUSD 1D wick finding: bars near ~$1900–$2100 are REAL HISTORICAL DATA
  // from 2023 (pre-rally). The historicalShiftThreshold of 0.4 means a bar
  // priced >40% below the recent 30-bar median receives HISTORICAL_PERIOD_SHIFT.
  // This is NOT a data error — it is legitimate price history. The flag helps
  // the chart layer (Phase 2) know it needs to auto-scale the Y axis.
  {
    symbol: "XAUUSD", displayName: "Gold / US Dollar", assetClass: "metals", isSynthetic: false,
    pricePrecision: 2, pipSize: 0.01, pointSize: 0.01, typicalSpreadPips: 30,
    priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
    minHistoryDepthHours: 24 * 30,
    session: FOREX_SESSION,
    spikeAtrMultiple: 5, wickRatioThreshold: 0.75, historicalShiftThreshold: 0.4,
  },
  {
    symbol: "XAGUSD", displayName: "Silver / US Dollar", assetClass: "metals", isSynthetic: false,
    pricePrecision: 4, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 20,
    priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
    minHistoryDepthHours: 24 * 30,
    session: FOREX_SESSION,
    spikeAtrMultiple: 5, wickRatioThreshold: 0.75, historicalShiftThreshold: 0.4,
  },

  // ── Indices ───────────────────────────────────────────────────────────────
  {
    symbol: "US30", displayName: "US 30 (Dow Jones)", assetClass: "indices", isSynthetic: false,
    pricePrecision: 0, pipSize: 1, pointSize: 1, typicalSpreadPips: 3,
    priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
    minHistoryDepthHours: 24 * 30,
    session: STOCK_US_SESSION,
    spikeAtrMultiple: 5, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.35,
  },
  {
    symbol: "NAS100", displayName: "NASDAQ 100", assetClass: "indices", isSynthetic: false,
    pricePrecision: 0, pipSize: 1, pointSize: 1, typicalSpreadPips: 3,
    priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
    minHistoryDepthHours: 24 * 30,
    session: STOCK_US_SESSION,
    spikeAtrMultiple: 5, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.35,
  },
  {
    symbol: "SPX500", displayName: "S&P 500", assetClass: "indices", isSynthetic: false,
    pricePrecision: 1, pipSize: 0.1, pointSize: 0.1, typicalSpreadPips: 3,
    priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
    minHistoryDepthHours: 24 * 30,
    session: STOCK_US_SESSION,
    spikeAtrMultiple: 5, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.35,
  },
  {
    symbol: "GER40", displayName: "Germany 40 (DAX)", assetClass: "indices", isSynthetic: false,
    pricePrecision: 0, pipSize: 1, pointSize: 1, typicalSpreadPips: 3,
    priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
    minHistoryDepthHours: 24 * 30,
    session: { alwaysOpen: false, openHourUtc: 7, closeHourUtc: 21, closedOnWeekends: true, note: "German index: ~07:00–21:00 UTC Mon–Fri." },
    spikeAtrMultiple: 5, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.35,
  },
  {
    symbol: "UK100", displayName: "UK 100 (FTSE)", assetClass: "indices", isSynthetic: false,
    pricePrecision: 0, pipSize: 1, pointSize: 1, typicalSpreadPips: 3,
    priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
    minHistoryDepthHours: 24 * 30,
    session: { alwaysOpen: false, openHourUtc: 7, closeHourUtc: 19, closedOnWeekends: true, note: "UK index: ~07:00–19:00 UTC Mon–Fri." },
    spikeAtrMultiple: 5, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.35,
  },
  {
    symbol: "JP225", displayName: "Japan 225 (Nikkei)", assetClass: "indices", isSynthetic: false,
    pricePrecision: 0, pipSize: 1, pointSize: 1, typicalSpreadPips: 3,
    priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
    minHistoryDepthHours: 24 * 30,
    session: { alwaysOpen: false, openHourUtc: 0, closeHourUtc: 8, closedOnWeekends: true, note: "Japan index: ~00:00–08:00 UTC Mon–Fri." },
    spikeAtrMultiple: 5, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.35,
  },

  // ── Synthetics ────────────────────────────────────────────────────────────
  {
    symbol: "V10", displayName: "Volatility 10 Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.5,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 8, wickRatioThreshold: 0.9, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "V25", displayName: "Volatility 25 Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.5,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 8, wickRatioThreshold: 0.9, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "V50", displayName: "Volatility 50 Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.5,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 8, wickRatioThreshold: 0.9, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "V75", displayName: "Volatility 75 Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.5,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 8, wickRatioThreshold: 0.9, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "V100", displayName: "Volatility 100 Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 2, pipSize: 0.01, pointSize: 0.01, typicalSpreadPips: 0.5,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 8, wickRatioThreshold: 0.9, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "V10_1S", displayName: "Volatility 10 (1s) Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.3,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 10, wickRatioThreshold: 0.9, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "V25_1S", displayName: "Volatility 25 (1s) Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.3,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 10, wickRatioThreshold: 0.9, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "V50_1S", displayName: "Volatility 50 (1s) Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.3,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 10, wickRatioThreshold: 0.9, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "V75_1S", displayName: "Volatility 75 (1s) Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.3,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 10, wickRatioThreshold: 0.9, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "V100_1S", displayName: "Volatility 100 (1s) Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 2, pipSize: 0.01, pointSize: 0.01, typicalSpreadPips: 0.3,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 10, wickRatioThreshold: 0.9, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "BOOM500", displayName: "Boom 500 Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.5,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 12, wickRatioThreshold: 0.95, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "BOOM1000", displayName: "Boom 1000 Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.5,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 12, wickRatioThreshold: 0.95, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "CRASH500", displayName: "Crash 500 Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.5,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 12, wickRatioThreshold: 0.95, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "CRASH1000", displayName: "Crash 1000 Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.5,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 12, wickRatioThreshold: 0.95, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "STEP", displayName: "Step Index", assetClass: "synthetic", isSynthetic: true,
    pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.3,
    priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 7,
    session: SYNTHETIC_SESSION,
    spikeAtrMultiple: 5, wickRatioThreshold: 0.85, historicalShiftThreshold: 0.5,
  },

  // ── Common crypto ─────────────────────────────────────────────────────────
  {
    symbol: "BTCUSDT", displayName: "Bitcoin / USDT", assetClass: "crypto", isSynthetic: false,
    pricePrecision: 2, pipSize: 0.01, pointSize: 0.01, typicalSpreadPips: 10,
    priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 30,
    session: CRYPTO_SESSION,
    spikeAtrMultiple: 6, wickRatioThreshold: 0.85, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "ETHUSDT", displayName: "Ethereum / USDT", assetClass: "crypto", isSynthetic: false,
    pricePrecision: 2, pipSize: 0.01, pointSize: 0.01, typicalSpreadPips: 5,
    priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ALL_TIMEFRAMES, minHistoryDepthHours: 24 * 30,
    session: CRYPTO_SESSION,
    spikeAtrMultiple: 6, wickRatioThreshold: 0.85, historicalShiftThreshold: 0.5,
  },

  // ── US stocks ─────────────────────────────────────────────────────────────
  {
    symbol: "AAPL", displayName: "Apple Inc.", assetClass: "stocks", isSynthetic: false,
    pricePrecision: 2, pipSize: 0.01, pointSize: 0.01, typicalSpreadPips: 2,
    priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
    minHistoryDepthHours: 24 * 30,
    session: STOCK_US_SESSION,
    spikeAtrMultiple: 5, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.4,
  },
  {
    symbol: "TSLA", displayName: "Tesla Inc.", assetClass: "stocks", isSynthetic: false,
    pricePrecision: 2, pipSize: 0.01, pointSize: 0.01, typicalSpreadPips: 5,
    priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
    minHistoryDepthHours: 24 * 30,
    session: STOCK_US_SESSION,
    spikeAtrMultiple: 5, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.5,
  },
  {
    symbol: "MSFT", displayName: "Microsoft Corp.", assetClass: "stocks", isSynthetic: false,
    pricePrecision: 2, pipSize: 0.01, pointSize: 0.01, typicalSpreadPips: 2,
    priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc",
    allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
    minHistoryDepthHours: 24 * 30,
    session: STOCK_US_SESSION,
    spikeAtrMultiple: 5, wickRatioThreshold: 0.8, historicalShiftThreshold: 0.4,
  },
];

// ── Lookup index ─────────────────────────────────────────────────────────────

const BY_SYMBOL = new Map<string, SymbolProfile>(
  SYMBOL_TABLE.map((p) => [p.symbol.toUpperCase(), p]),
);

// ── Per-asset-class defaults ─────────────────────────────────────────────────

function defaultForAssetClass(symbol: string, assetClass: AssetClass): SymbolProfile {
  const base: Omit<SymbolProfile, "symbol" | "displayName" | "assetClass" | "isSynthetic" | "pricePrecision" | "pipSize" | "pointSize" | "typicalSpreadPips" | "priceBasis" | "priceBasisNote" | "ohlcSourceType" | "allowedTimeframes" | "session"> = {
    minHistoryDepthHours: 24 * 30,
    spikeAtrMultiple: 6,
    wickRatioThreshold: 0.8,
    historicalShiftThreshold: 0.4,
  };
  switch (assetClass) {
    case "synthetic":
      return { symbol, displayName: symbol, assetClass, isSynthetic: true, pricePrecision: 3, pipSize: 0.001, pointSize: 0.001, typicalSpreadPips: 0.5, priceBasis: "SYNTHETIC", priceBasisNote: "SYNTHETIC", ohlcSourceType: "true_ohlc", allowedTimeframes: ALL_TIMEFRAMES, session: SYNTHETIC_SESSION, ...base, spikeAtrMultiple: 10 };
    case "forex":
      return { symbol, displayName: symbol, assetClass, isSynthetic: false, pricePrecision: 5, pipSize: 0.0001, pointSize: 0.00001, typicalSpreadPips: 2, priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc", allowedTimeframes: ALL_TIMEFRAMES, session: FOREX_SESSION, ...base };
    case "metals":
      return { symbol, displayName: symbol, assetClass, isSynthetic: false, pricePrecision: 2, pipSize: 0.01, pointSize: 0.01, typicalSpreadPips: 30, priceBasis: "MID", priceBasisNote: "MID", ohlcSourceType: "true_ohlc", allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"], session: FOREX_SESSION, ...base };
    case "indices":
      return { symbol, displayName: symbol, assetClass, isSynthetic: false, pricePrecision: 1, pipSize: 0.1, pointSize: 0.1, typicalSpreadPips: 5, priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc", allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"], session: STOCK_US_SESSION, ...base };
    case "crypto":
      return { symbol, displayName: symbol, assetClass, isSynthetic: false, pricePrecision: 2, pipSize: 0.01, pointSize: 0.01, typicalSpreadPips: 10, priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc", allowedTimeframes: ALL_TIMEFRAMES, session: CRYPTO_SESSION, ...base };
    case "stocks":
      return { symbol, displayName: symbol, assetClass, isSynthetic: false, pricePrecision: 2, pipSize: 0.01, pointSize: 0.01, typicalSpreadPips: 5, priceBasis: "LAST", priceBasisNote: "LAST", ohlcSourceType: "true_ohlc", allowedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"], session: STOCK_US_SESSION, ...base };
    default:
      return { symbol, displayName: symbol, assetClass: "unknown", isSynthetic: false, pricePrecision: 5, pipSize: 0.0001, pointSize: 0.00001, typicalSpreadPips: 5, priceBasis: "UNKNOWN", priceBasisNote: "MID", ohlcSourceType: "unknown", allowedTimeframes: ALL_TIMEFRAMES, session: FOREX_SESSION, ...base };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Return the profile for a symbol, falling back to asset-class defaults. Pure — no I/O. */
export function getSymbolProfile(symbol: string, assetClass?: AssetClass): SymbolProfile {
  const up = (symbol ?? "").trim().toUpperCase();
  const known = BY_SYMBOL.get(up);
  if (known) return known;
  const cls: AssetClass = assetClass ?? "unknown";
  return defaultForAssetClass(up || symbol, cls);
}

/** Source documentation block embedded in truth results (for admin display). */
export function getSourceDocumentation(assetClass: AssetClass): {
  dataMode: string;
  priceBasisNote: string;
  updateMethod: string;
  freshnessNote: string;
  supportedTimeframes: string[];
  knownLimitations: string[];
} {
  switch (assetClass) {
    case "synthetic":
      return {
        dataMode: "LIVE — Deriv WebSocket (DERIV_APP_ID required)",
        priceBasisNote: "SYNTHETIC — Deriv volatility algorithm; no real underlying asset",
        updateMethod: "WebSocket tick stream + on-demand historical candle fetch",
        freshnessNote: "Live ticks stream continuously when connected; bars complete on bucket close",
        supportedTimeframes: ALL_TIMEFRAMES,
        knownLimitations: ["Requires DERIV_APP_ID env var", "No data when Deriv WS disconnected", "Re-subscribe latency after reconnect"],
      };
    case "forex":
      return {
        dataMode: "LIVE — REST API (TwelveData / Polygon / Finnhub / AlphaVantage chain)",
        priceBasisNote: "MID — composite bid-ask midpoint or exchange last price",
        updateMethod: "REST poll per chart request; no server-side push",
        freshnessNote: "Newest bar may trail by 1–2 intervals (polling latency)",
        supportedTimeframes: ALL_TIMEFRAMES,
        knownLimitations: ["Requires at least one market-data API key", "Free-tier rate limits (TwelveData ≈ 800 req/day)", "No server-side candle cache between requests"],
      };
    case "metals":
      return {
        dataMode: "LIVE — REST API (TwelveData / Polygon / Finnhub chain)",
        priceBasisNote: "MID — spot price midpoint (NOT futures, NOT bid-only)",
        updateMethod: "REST poll per chart request; no server-side push",
        freshnessNote: "Minute data sparser than H1/D1 on free tier",
        supportedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
        knownLimitations: [
          "Requires market-data API key",
          "XAUUSD D1 bars ~$1900–$2100 are real 2023 history (pre-rally) — NOT bad ticks",
          "Y-axis scaling of historical bars is a chart render issue (Phase 2 scope)",
        ],
      };
    case "indices":
      return {
        dataMode: "LIVE — REST API (TwelveData maps US30→DJI, NAS100→IXIC, SPX500→SPX)",
        priceBasisNote: "LAST — calculated index point value; no bid/ask",
        updateMethod: "REST poll per chart request",
        freshnessNote: "Weekend/holiday gaps appear as missing candles — these are real closed-market periods",
        supportedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
        knownLimitations: ["Session gaps on weekends/holidays", "Symbol remapping required (US30 ≠ DJI natively)", "Free-tier rate limits apply"],
      };
    case "crypto":
      return {
        dataMode: "LIVE — REST API chain (same as forex)",
        priceBasisNote: "LAST — exchange last trade price",
        updateMethod: "REST poll per chart request",
        freshnessNote: "24/7 — missing candles are data gaps, not market closure",
        supportedTimeframes: ALL_TIMEFRAMES,
        knownLimitations: ["Requires market-data API key", "Provider coverage varies by coin"],
      };
    case "stocks":
      return {
        dataMode: "LIVE — REST API chain (same as forex)",
        priceBasisNote: "LAST — exchange last trade price",
        updateMethod: "REST poll per chart request",
        freshnessNote: "Session gaps on weekends/holidays are expected",
        supportedTimeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
        knownLimitations: ["Session gaps on weekends/holidays", "Free-tier may limit intraday history"],
      };
    default:
      return {
        dataMode: "UNKNOWN — symbol not classified",
        priceBasisNote: "UNKNOWN",
        updateMethod: "n/a",
        freshnessNote: "n/a",
        supportedTimeframes: [],
        knownLimitations: ["Symbol is not in any recognized market family"],
      };
  }
}

export { ALL_TIMEFRAMES };
