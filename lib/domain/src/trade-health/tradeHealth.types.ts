// Live Trade Health & Management — TYPES (Task #198).
//
// Pure, self-contained contract for the post-entry trade-health monitor. Once a
// trade is open, this module classifies it (healthy / weakening / danger /
// invalidated), tracks take-profit progress and stop-loss distance, and emits
// break-even, partial-close, conflict, correlation, and overtrading GUIDANCE.
//
// SAFETY (inviolable):
// - Pure types only. No IO, DB, HTTP, Date.now, or randomness in this module.
// - GUIDANCE ONLY. Nothing here closes, modifies, or places a trade. Auto-close
//   stays ALERT_ONLY. The 16-gate live pipeline + kill switch remain the only
//   things that can stop or change a trade.
// - HONEST. When an input is missing (no stop-loss, no take-profit, no live
//   price, no original signal) the output degrades honestly — an `unknown`
//   progress, a NOT_AVAILABLE check, a plain "based on floating P/L only" note —
//   never a fabricated number and never sim/mock/paper data treated as real.
// - No internal enum token (UPPER_SNAKE) ever appears in a user-facing string
//   (headline, reason, note, message, summary, or label).

import type { HandshakeOverallStatus } from "../handshake/handshake.types";
import type { SmartChartLayer } from "../smart-chart/smartChart.types";

// ── Health classification ────────────────────────────────────────────────────

/** Post-entry health of a single open position. */
export type TradeHealthState = "healthy" | "weakening" | "danger" | "invalidated";

export type TradeSide = "BUY" | "SELL";

/** Account context a position belongs to (drives plain-English copy only). */
export type TradeAccountMode = "DEMO" | "LIVE";

/**
 * Minimal projection of one open position the engine needs. Every price is a
 * real broker-derived number or null — the caller never fabricates one.
 */
export interface OpenPositionInput {
  /** Stable per-position identity (broker ticket or row id, as a string). */
  ticket: string;
  symbol: string;
  side: TradeSide;
  lotSize: number;
  entryPrice: number | null;
  /** Broker's current mark price (null when the feed has not reported one). */
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Floating (unrealized) P/L from the broker, null when unknown. */
  floatingPnl: number | null;
  /** When the position opened, ms epoch (null when unknown). */
  openedAtMs: number | null;
  /** Age of the price/sync in ms (null when unknown → honest freshness). */
  priceAgeMs: number | null;
  accountMode: TradeAccountMode;
  /** True when the broker's real fill price + slippage were recorded. */
  fillRecorded?: boolean;
}

/**
 * Narrow projection of the ORIGINAL Ruby signal that opened (or relates to) the
 * position's symbol — used for invalidation context and setup alternatives. Null
 * when the trade did not come from Ruby or no current read exists.
 */
export interface OriginalSignalInput {
  symbol: string;
  direction: TradeSide | null;
  hasSufficientData: boolean;
  /** Structural invalidation price for the thesis (null when unknown). */
  invalidationPrice: number | null;
  /** Aggressive (chase) zone — usually the live entry zone. */
  entryZone: { from: number; to: number } | null;
  /** Better (wait-for-retest) zone. */
  retestZone: { from: number; to: number } | null;
  /** Safest (deeper watch) zone. */
  watchZone: { from: number; to: number } | null;
}

// ── Progress / distance ──────────────────────────────────────────────────────

export interface TpProgress {
  /** True only when entry, take-profit and a live price are all usable. */
  known: boolean;
  /** 0..100 progress toward take-profit (null when unknown). */
  progressPct: number | null;
  /** Plain-English detail — never an internal enum token. */
  note: string;
}

export interface SlDistance {
  /** True only when stop-loss and a live price are usable. */
  known: boolean;
  /** Absolute price distance from the live price to the stop (null unknown). */
  distancePrice: number | null;
  /** 0..100 of the entry→stop buffer still remaining (null unknown). */
  bufferRemainingPct: number | null;
  /** Plain-English detail — never an internal enum token. */
  note: string;
}

// ── Guidance ─────────────────────────────────────────────────────────────────

export interface BreakEvenSuggestion {
  /** True only when moving the stop to entry is actually justified. */
  suggested: boolean;
  /** Plain-English guidance — never an internal enum token. */
  note: string;
}

export interface PartialCloseSuggestion {
  /** True only when taking partial profit is actually justified. */
  suggested: boolean;
  /** Plain-English guidance — never an internal enum token. */
  note: string;
}

export type TradeStyle = "scalp" | "intraday" | "swing" | "unknown";

export interface TradeStyleMatch {
  detectedStyle: TradeStyle;
  /** Plain-English detail — never an internal enum token. */
  note: string;
}

export type SetupAlternativeKind = "aggressive" | "better" | "safest";

export interface SetupAlternative {
  kind: SetupAlternativeKind;
  /** Plain-English label (e.g. "Aggressive — enter now"). */
  label: string;
  /** Reference price for the alternative entry (null when unknown). */
  price: number | null;
  /** Plain-English detail — never an internal enum token. */
  note: string;
}

// ── Portfolio-level warnings ─────────────────────────────────────────────────

export type ConflictKind = "opposite" | "duplicate" | "over_exposure";

export interface ConflictWarning {
  kind: ConflictKind;
  symbol: string;
  /** Tickets involved in the conflict. */
  tickets: string[];
  /** Plain-English warning — never an internal enum token. */
  note: string;
}

export type CorrelationKind = "currency_cluster" | "risk_cluster";

export interface CorrelationWarning {
  kind: CorrelationKind;
  /** The shared driver in plain English (e.g. "USD", "risk-on sentiment"). */
  driver: string;
  symbols: string[];
  /** Plain-English warning — never an internal enum token. */
  note: string;
}

export type OvertradingKind = "rapid_reentry" | "revenge_sizing" | "news_trading";

export interface OvertradingWarning {
  kind: OvertradingKind;
  /** Plain-English warning — never an internal enum token. */
  note: string;
}

/**
 * Real behavioral inputs the caller supplies from trade history. Each field is
 * optional/null when the caller cannot read it — the engine then emits NO
 * warning for that dimension rather than fabricating one.
 */
export interface OvertradingInput {
  /** Number of trades the user opened in the recent window. */
  recentTradeCount: number | null;
  /** The window the count covers, in minutes. */
  windowMinutes: number | null;
  /** True when the most recent closed trade(s) were losses. */
  recentLosses: boolean | null;
  /** Current lot size relative to the user's recent baseline (e.g. 1.0 = same). */
  lotVsBaseline: number | null;
  /** True when a high-impact news window is live/imminent for an open symbol. */
  tradingThroughNews: boolean | null;
}

// ── Live Trade Health Handshake ──────────────────────────────────────────────

export type TradeHealthCheckStatus = "PASS" | "WARN" | "FAIL" | "NOT_AVAILABLE";

export type TradeHealthCheckKey =
  | "positionInSync"
  | "freshness"
  | "symbolMatch"
  | "tpSlKnown"
  | "currentPriceFresh"
  | "originalSignalAvailable"
  | "fillSlippageStored";

export interface TradeHealthCheck {
  key: TradeHealthCheckKey;
  status: TradeHealthCheckStatus;
  /** Plain-English detail — never an internal enum token. */
  detail: string;
}

export interface TradeHealthHandshake {
  overallStatus: HandshakeOverallStatus;
  checks: TradeHealthCheck[];
  /** Plain-English summary for the panel badge. */
  userFacingMessage: string;
  warnings: string[];
}

// ── Per-position assessment + report ─────────────────────────────────────────

export interface TradeHealthAssessment {
  ticket: string;
  symbol: string;
  side: TradeSide;
  accountMode: TradeAccountMode;
  /**
   * True when this position's symbol matches the chart's selected symbol (same
   * `normalizeSymbol` comparison the `symbolMatch` handshake check uses). Lets a
   * surface split "this symbol" from account-wide exposure WITHOUT re-deriving
   * symbol matching — the server is the single source of truth. False whenever
   * there is no chart symbol to compare against.
   */
  matchesChartSymbol: boolean;
  /** Real broker entry price (null when not synced) — anchors the overlay. */
  entryPrice: number | null;
  state: TradeHealthState;
  /** Plain-English one-line headline for the state. */
  headline: string;
  /** Plain-English reasons behind the state (never internal tokens). */
  reasons: string[];
  /** True when the state warrants an alert (weakening / danger / invalidated). */
  alert: boolean;
  tpProgress: TpProgress;
  slDistance: SlDistance;
  breakEven: BreakEvenSuggestion;
  partialClose: PartialCloseSuggestion;
  styleMatch: TradeStyleMatch;
  alternatives: SetupAlternative[];
  handshake: TradeHealthHandshake;
}

export interface TradeHealthReport {
  /** ISO timestamp this report was evaluated. */
  evaluatedAt: string;
  assessments: TradeHealthAssessment[];
  conflicts: ConflictWarning[];
  correlations: CorrelationWarning[];
  overtrading: OvertradingWarning[];
  /** Active trade-health chart overlays (fills the Phase 4 overlay slot). */
  overlays: SmartChartLayer[];
  /** Plain-English portfolio summary. */
  summary: string;
}
