// ── ONE TRADE-HEALTH / READINESS DISPLAY CONTRACT (Phase 3) ──────────────────
//
// SINGLE SOURCE OF TRUTH for "how should this symbol/timeframe's read + setup be
// PRESENTED right now, and which trade AFFORDANCES may the UI offer?". Scanner,
// Ruby (chat + chart), the chart panel, the trade ticket, the manual ticket,
// backtest cards, alerts, and AI-setup cards all consume THIS verdict so they can
// never contradict each other (e.g. the scanner header says "historical only /
// feed not confirmed" while Ruby's footer says "Live-confirmed · execution-ready"
// for the same symbol+timeframe).
//
// It COMPOSES `evaluateMarketDataSufficiency` (the closed-bar/feed verdict) and
// layers the read-layer / freshness / structure / setup-health bands plus the
// display-only affordance CEILINGS on top. It does NOT recompute sufficiency —
// composing, not forking, is what keeps "one truth".
//
// This module is PURE: no IO, no DB, no HTTP, no clock, no role/privilege input.
// Same inputs ⇒ same verdict, so two callers feeding identical inputs ALWAYS
// agree.
//
// ── SAFETY: READ-SIDE DISPLAY ONLY ──────────────────────────────────────────
// The verdict can only BLOCK or DOWNGRADE what the user SEES — it never grants,
// relaxes, or shortcuts trade eligibility. It is NOT an execution gate: it never
// authorizes a trade, never relaxes the synthetic floor / 18-gate dispatch / SL
// policy / kill switch / per-user arming + approval, and takes NO owner/admin
// privilege input that could upgrade a display flag. The affordance flags
// (`mayShowTradeButton`, `mayShowOneClickButton`, `mayDescribeSetup`,
// `mayOfferLiveExecutionRequest`) are display CEILINGS only — every caller must
// AND them with the REAL gate/permission state (`canTrade`, live-gate, mode).
// They can hide an affordance, never reveal one the execution stack forbids.
//
// A ci:guards import-boundary check (check-display-contract-import-boundary.ts)
// fails the build if any execution/safety module imports this contract or any of
// its affordance flags. Display surfaces consume it freely; execution/safety
// surfaces must never see it.

import {
  evaluateMarketDataSufficiency,
  MIN_SUFFICIENT_CLOSED_BARS,
  type MarketDataSufficiencyStatus,
} from "./marketDataSufficiency";
import { normalizeReadinessTimeframe } from "./readinessTimeframes";
import type { SymbolFeedVerdict } from "../safety-contracts/syntheticLiveFloor";

/**
 * How much of a confident read the caller actually has. Callers map their own
 * read-layer concept (e.g. the assistant's FULL / STRUCTURAL_ONLY layers) into
 * this canonical enum — the pure domain contract never imports an api-server
 * module, so the mapping lives at the caller.
 *   FULL            → a complete, current read may stand.
 *   STRUCTURAL_ONLY → only a closed-candle structural read (feed not confirmed
 *                     for live entry); can never be live-confirmed.
 *   INSUFFICIENT    → not enough to read (fail-closed default).
 */
export type TradeReadLayer = "FULL" | "STRUCTURAL_ONLY" | "INSUFFICIENT";

/** How fresh the underlying data is, as a user-facing display band. */
export type TradeDataFreshnessBand =
  | "LIVE_CONFIRMED" // approved + LIVE feed + enough closed bars + FULL read
  | "LIVE_DELAYED" // enough bars, but the live feed is delayed
  | "AWAITING" // approved + waiting for a current feed / more bars
  | "HISTORICAL_ONLY" // bars present, but feed not confirmed for live entry
  | "UNKNOWN"; // not an approved market / nothing to say

/** Caller-supplied structural-read confidence, as a display band. */
export type TradeStructureConfidenceBand = "HIGH" | "MEDIUM" | "LOW" | "UNAVAILABLE";

/**
 * Caller-supplied setup / position-management health (callers map their own
 * trade-health score into this band). Only INVALIDATED / AT_RISK reduce
 * affordances; UNKNOWN (not evaluated — common at entry surfaces) never blocks.
 */
export type TradeSetupHealthBand =
  | "HEALTHY"
  | "WATCHING"
  | "AT_RISK"
  | "INVALIDATED"
  | "UNKNOWN";

/**
 * The highest-precedence reason the display is downgraded, or `null` when a full
 * live-confirmed read stands. Stable machine code (same input ⇒ same code) so
 * surfaces match without parsing prose. NOT an execution-gate reason — it
 * describes only why a DISPLAY affordance is withheld.
 */
export type TradeDisplayBlockedReason =
  | "NOT_APPROVED_MARKET"
  | "NOT_ENOUGH_BARS"
  | "FEED_NOT_LIVE_CONFIRMED"
  | "STRUCTURE_LOW"
  | "SETUP_NOT_PERMITTED"
  | "LIVE_GATE_BLOCKED"
  | "UNKNOWN"
  | null;

export interface EvaluateTradeHealthReadinessInput {
  symbol: string;
  timeframe: string;
  /** Freshness of the underlying feed, from the shared SymbolFeedVerdict scale. */
  freshnessVerdict: SymbolFeedVerdict;
  /** Number of fully-closed candles the caller currently has. */
  availableClosedCandles: number;
  /** Optional override of the closed-bar floor (defaults to MIN_SUFFICIENT_CLOSED_BARS). */
  minimumRequiredCandles?: number;
  /** Canonical read layer the caller resolved. Default INSUFFICIENT (fail-closed). */
  readLayer?: TradeReadLayer;
  /** Structural-read confidence band the caller resolved. Default UNAVAILABLE. */
  structureConfidence?: TradeStructureConfidenceBand;
  /** Setup/position health band (for management surfaces). Default UNKNOWN. */
  setupHealth?: TradeSetupHealthBand;
  /**
   * The caller's ALREADY-DECIDED execution-gate outcome, FOR DISPLAY DOWNGRADE
   * ONLY. `true` ⇒ the relevant execution gate is currently refusing, so the UI
   * must not offer a trade/one-click/live-request affordance. The contract NEVER
   * computes this (never decides pass/fail) — it only folds a known refusal into
   * the display so a button can't appear when execution would refuse. Default
   * `false`; the data gate already fails closed via readLayer / bars / feed.
   */
  executionGateBlocked?: boolean;
}

export interface TradeHealthReadinessVerdict {
  /** Echoed sufficiency status (blocked | insufficient | partial | sufficient). */
  status: MarketDataSufficiencyStatus;
  /** True only when the symbol is an approved ARX market. */
  isApprovedMarket: boolean;
  /** The read layer applied (echoed for transparency). */
  readLayer: TradeReadLayer;
  /** The freshness verdict that fed this evaluation (echoed for transparency). */
  feedVerdict: SymbolFeedVerdict;
  /** User-facing freshness band (downgraded by read layer + sufficiency). */
  dataFreshness: TradeDataFreshnessBand;
  /** User-facing structure-confidence band (capped: never HIGH unless live-confirmed). */
  structureConfidence: TradeStructureConfidenceBand;
  /** User-facing setup-health band (echoed). */
  setupHealth: TradeSetupHealthBand;
  /** Highest-precedence display-downgrade reason, or null when a full live read stands. */
  executionBlockedReason: TradeDisplayBlockedReason;
  /** Short label for the read state (safe across surfaces). */
  displayLabel: string;
  /**
   * Plain-English, user-safe one-liner — identical across surfaces for identical
   * inputs. Free of "Verified / Live feed / Live-confirmed / Execution-ready /
   * AACI verified" UNLESS the read is genuinely live-confirmed.
   */
  userFacingTrustLine: string;
  // ── DISPLAY-ONLY affordance CEILINGS ──────────────────────────────────────
  // MUST NOT be imported by any execution/safety module (CI-fenced). Every
  // caller ANDs these with the REAL gate/permission state; they can only hide an
  // affordance, never grant one. True ONLY on a genuinely live-confirmed, full,
  // non-invalidated read with no display-block reason.
  /** UI may present a concrete directional setup (entry/SL/TP narrative). */
  mayDescribeSetup: boolean;
  /** UI may render a place-order button (caller still ANDs canTrade / mode). */
  mayShowTradeButton: boolean;
  /** UI may render the one-click (armed instant) affordance (caller ANDs armed). */
  mayShowOneClickButton: boolean;
  /**
   * UI may OFFER the live-execution-request affordance. This OFFERS the request,
   * it does NOT grant it — the backend still runs every gate. Caller ANDs
   * live-mode + approval.
   */
  mayOfferLiveExecutionRequest: boolean;
}

/** Never claim a HIGH structure read unless the feed is live-confirmed. */
function deriveStructureBand(
  provided: TradeStructureConfidenceBand,
  status: MarketDataSufficiencyStatus,
  liveConfirmedRead: boolean,
): TradeStructureConfidenceBand {
  if (status === "blocked" || status === "insufficient") return "UNAVAILABLE";
  if (!liveConfirmedRead && provided === "HIGH") return "MEDIUM";
  return provided;
}

function deriveDataFreshness(
  status: MarketDataSufficiencyStatus,
  feed: SymbolFeedVerdict,
  readLayer: TradeReadLayer,
): TradeDataFreshnessBand {
  if (status === "blocked") return "UNKNOWN";
  if (status === "insufficient") return "AWAITING";
  // A closed-candle-only read can never be live-confirmed even when bars + feed
  // would otherwise qualify (the footer-honesty rule).
  if (readLayer === "STRUCTURAL_ONLY") return "HISTORICAL_ONLY";
  if (status === "sufficient" && readLayer === "FULL") return "LIVE_CONFIRMED";
  if (status === "partial") return feed === "LIVE_DELAYED" ? "LIVE_DELAYED" : "AWAITING";
  // sufficient bars + feed but read layer not FULL/STRUCTURAL (INSUFFICIENT).
  return "HISTORICAL_ONLY";
}

interface BlockedReasonInput {
  status: MarketDataSufficiencyStatus;
  liveConfirmedRead: boolean;
  structureConfidence: TradeStructureConfidenceBand;
  setupInvalidated: boolean;
  executionGateBlocked: boolean;
}

/** First (highest-precedence) reason the top affordance is withheld, else null. */
function deriveBlockedReason(i: BlockedReasonInput): TradeDisplayBlockedReason {
  if (i.status === "blocked") return "NOT_APPROVED_MARKET";
  if (i.status === "insufficient") return "NOT_ENOUGH_BARS";
  if (!i.liveConfirmedRead) return "FEED_NOT_LIVE_CONFIRMED";
  if (i.structureConfidence === "LOW") return "STRUCTURE_LOW";
  if (i.setupInvalidated) return "SETUP_NOT_PERMITTED";
  if (i.executionGateBlocked) return "LIVE_GATE_BLOCKED";
  return null;
}

function deriveDisplayLabel(
  status: MarketDataSufficiencyStatus,
  dataFreshness: TradeDataFreshnessBand,
  reason: TradeDisplayBlockedReason,
): string {
  if (status === "blocked") return "Not available";
  if (status === "insufficient") return "Building history";
  switch (dataFreshness) {
    case "LIVE_CONFIRMED":
      return reason === "LIVE_GATE_BLOCKED" ? "Live read · execution gated" : "Live-confirmed";
    case "LIVE_DELAYED":
      return "Delayed feed";
    case "HISTORICAL_ONLY":
      return "Historical read only";
    case "AWAITING":
      return "Awaiting live feed";
    default:
      return "Unconfirmed";
  }
}

interface TrustLineInput {
  status: MarketDataSufficiencyStatus;
  dataFreshness: TradeDataFreshnessBand;
  readLayer: TradeReadLayer;
  liveConfirmedRead: boolean;
  structureConfidence: TradeStructureConfidenceBand;
  setupHealth: TradeSetupHealthBand;
  executionBlockedReason: TradeDisplayBlockedReason;
  timeframe: string;
}

function deriveTrustLine(i: TrustLineInput): string {
  const tf = i.timeframe?.trim() || "this timeframe";
  if (i.status === "blocked")
    return "This market isn't on the approved list, so it can't be analyzed.";
  if (i.status === "insufficient")
    return `Not enough closed ${tf} candles yet to support a read.`;
  if (!i.liveConfirmedRead) {
    // Explicitly NOT live-confirmed — must avoid every "confident/live" token.
    if (i.dataFreshness === "LIVE_DELAYED")
      return `Delayed ${tf} feed — read uses the last confirmed candles, not the current one.`;
    if (i.readLayer === "STRUCTURAL_ONLY" || i.dataFreshness === "HISTORICAL_ONLY")
      return `Historical/closed-candle ${tf} structural read — feed not confirmed for live entry.`;
    return `Waiting for a current live ${tf} feed before confirming this read.`;
  }
  // Live-confirmed read: a "live-confirmed" claim is now honest.
  if (i.structureConfidence === "LOW")
    return `Live ${tf} feed, but chart structure is unclear — exact setup withheld.`;
  if (i.setupHealth === "INVALIDATED")
    return `Live ${tf} feed, but this setup is invalidated.`;
  if (i.executionBlockedReason === "LIVE_GATE_BLOCKED")
    return `Live-confirmed ${tf} read — live execution is currently gated by your account checks.`;
  return `Live-confirmed ${tf} read with enough recent closed candles.`;
}

/**
 * Derive the DISPLAY-ONLY affordance ceilings from the already-decided read
 * facts. PRIVATE: like `deriveReadabilityPermissions` in marketDataSufficiency,
 * this helper name is fenced by the CI import-boundary guard so no execution/
 * safety module can pull it. Same facts ⇒ same flags.
 */
function deriveTradeHealthReadinessPermissions(args: {
  liveConfirmedRead: boolean;
  structureConfidence: TradeStructureConfidenceBand;
  setupInvalidated: boolean;
  setupAtRisk: boolean;
  executionGateBlocked: boolean;
}): {
  mayDescribeSetup: boolean;
  mayShowTradeButton: boolean;
  mayShowOneClickButton: boolean;
  mayOfferLiveExecutionRequest: boolean;
} {
  // Describing a concrete setup is read-honesty: it needs a full, live-confirmed,
  // non-invalidated read with at least non-LOW structure. It is NOT gated by the
  // execution gate (you may honestly describe a setup whose live execution is
  // currently blocked).
  const mayDescribeSetup =
    args.liveConfirmedRead && !args.setupInvalidated && args.structureConfidence !== "LOW";
  // A trade button additionally requires the relevant execution gate to not be a
  // KNOWN refusal (so a button never appears when execution would refuse).
  const mayShowTradeButton = mayDescribeSetup && !args.executionGateBlocked;
  // One-click is stricter — never offered on an at-risk setup.
  const mayShowOneClickButton = mayShowTradeButton && !args.setupAtRisk;
  // Offering a live-execution REQUEST has the same data/setup ceiling as the
  // trade button; the caller ANDs live-mode + approval downstream.
  const mayOfferLiveExecutionRequest = mayShowTradeButton;
  return {
    mayDescribeSetup,
    mayShowTradeButton,
    mayShowOneClickButton,
    mayOfferLiveExecutionRequest,
  };
}

/**
 * Evaluate the ONE shared trade-health / readiness DISPLAY verdict.
 *
 * Composes `evaluateMarketDataSufficiency`, then layers freshness / structure /
 * setup-health bands and the display-only affordance ceilings. The affordance
 * flags are true ONLY on a genuinely live-confirmed, FULL, non-invalidated read
 * with no display-block reason — display can only downgrade, never grant.
 */
export function evaluateTradeHealthReadiness(
  input: EvaluateTradeHealthReadinessInput,
): TradeHealthReadinessVerdict {
  const sufficiency = evaluateMarketDataSufficiency({
    symbol: input.symbol,
    timeframe: input.timeframe,
    freshnessVerdict: input.freshnessVerdict,
    availableClosedCandles: input.availableClosedCandles,
    minimumRequiredCandles: input.minimumRequiredCandles ?? MIN_SUFFICIENT_CLOSED_BARS,
  });

  const readLayer = input.readLayer ?? "INSUFFICIENT";
  const setupHealth = input.setupHealth ?? "UNKNOWN";
  const executionGateBlocked = input.executionGateBlocked === true;
  const status = sufficiency.status;

  // The data-truth gate: `sufficient` already requires an approved market, a LIVE
  // feed, and enough closed bars; a FULL read layer is the final requirement.
  const liveConfirmedRead = status === "sufficient" && readLayer === "FULL";

  const dataFreshness = deriveDataFreshness(status, input.freshnessVerdict, readLayer);
  const structureConfidence = deriveStructureBand(
    input.structureConfidence ?? "UNAVAILABLE",
    status,
    liveConfirmedRead,
  );
  const setupInvalidated = setupHealth === "INVALIDATED";
  const setupAtRisk = setupHealth === "AT_RISK";

  const executionBlockedReason = deriveBlockedReason({
    status,
    liveConfirmedRead,
    structureConfidence,
    setupInvalidated,
    executionGateBlocked,
  });

  const permissions = deriveTradeHealthReadinessPermissions({
    liveConfirmedRead,
    structureConfidence,
    setupInvalidated,
    setupAtRisk,
    executionGateBlocked,
  });

  const displayLabel = deriveDisplayLabel(status, dataFreshness, executionBlockedReason);
  const userFacingTrustLine = deriveTrustLine({
    status,
    dataFreshness,
    readLayer,
    liveConfirmedRead,
    structureConfidence,
    setupHealth,
    executionBlockedReason,
    // Normalize to ONE display token ("M15"→"15m") so Ruby (canonical codes) and
    // the Scanner (UI aliases) emit an IDENTICAL trust line for the same tf.
    timeframe: normalizeReadinessTimeframe(input.timeframe),
  });

  return {
    status,
    isApprovedMarket: sufficiency.isApprovedMarket,
    readLayer,
    feedVerdict: input.freshnessVerdict,
    dataFreshness,
    structureConfidence,
    setupHealth,
    executionBlockedReason,
    displayLabel,
    userFacingTrustLine,
    ...permissions,
  };
}
