// Phase 4 — RubyChartContext: verified, gate-checked context for Ruby chart reads.
//
// Assembles the sole structured input for Ruby's deterministic chart reads from
// Phase 3 gate outputs (ChartTruthScore, ChartReadScore, ChartGateOutput,
// BrokerPriceAlignment) and the already-built ChartIntelligenceState. Ruby
// reads THIS structure rather than raw chart/candle component state.
//
// Phase 4 final: also fetches and owns the raw Candle[] so the read-chart
// endpoint uses this as its sole data source (no split-source divergence).
//
// SAFETY: READ-ONLY. Never places, modifies, or closes a trade. Never an
// execution gate. Never weakens the 16-gate live pipeline.

import { buildChartIntelligenceState, type ChartIntelligenceState } from "./chartIntelligence.js";
import type { ChartGateOutput } from "./chartGateOutput.js";
import { mirrorTrustSegment, type BrokerPriceAlignment } from "./brokerPriceAlignment.js";
import type { ChartTimeframe } from "./timeframes.js";
import { buildChartHandshake, type ChartHandshakeVerdict } from "./chartHandshake.js";
import { getMarketData } from "../../data/dataManager.js";
import { hasRecentDerivTickFor } from "../providers/derivProvider.js";
import { higherTimeframeOf } from "../../assistant/chartStructure.js";
import type { Candle } from "../../data/types.js";
import type { MarketDataSufficiencyVerdict } from "@workspace/domain/market";
import { evaluateSufficiencyFromChartState } from "./chartSufficiency.js";

/** Canonical trust basis for this Ruby chart read. */
export type RubyChartReadBasis =
  | "VERIFIED"   // Chart Truth ≥ 75, fresh feed, mirror clean, AACI handshake PASS
  | "PARTIAL"    // Trust ≥ 75 but freshness, mirror, or AACI handshake degraded
  | "SYNCING"    // Chart Truth < 75 — no directional read allowed
  | "INSUFFICIENT"; // No usable candles or provider not connected

const MIN_BARS_FULL_READ = 50;

export interface RubyChartContext {
  symbol: string;
  displaySymbol: string;
  timeframe: string;

  /** Canonical trust basis — drives whether Ruby may give a directional read. */
  basis: RubyChartReadBasis;

  /** True when confidentReadAllowed from Phase 3 gate. */
  confidentReadAllowed: boolean;

  /** True when the current candle is still forming (not yet closed). */
  hasFormingCandle: boolean;

  /** Count of fully-closed bars analysed. */
  closedBarsCount: number;

  /**
   * True when history is thin (< MIN_BARS_FULL_READ) — read is advisory only
   * and a limited-history note should be surfaced.
   */
  limitedHistory: boolean;

  liveDelayed: boolean;

  /**
   * ONE DATA-SUFFICIENCY TRUTH — the shared, read-only verdict the scanner +
   * chart consume too, so Ruby can never say "candles syncing / cannot verify"
   * while the scanner shows a confident setup for the same symbol+timeframe.
   * When status is "insufficient"/"blocked", `basis` is forced to "INSUFFICIENT"
   * and `blockReason` carries this verdict's humanReason. Downgrade-only.
   */
  sufficiency: MarketDataSufficiencyVerdict;

  /**
   * Compact human trust line, always present.
   * e.g. "Verified M5 candles · Live feed · Mirror synced"
   * or   "Candles syncing · Feed stale · Mirror degraded"
   */
  trustLine: string;

  /**
   * Honest block reason (primary) when confidentReadAllowed is false, else null.
   * Never contains internal gate codes; suitable for user display after scrubbing.
   */
  blockReason: string | null;

  /**
   * AACI chart handshake overall verdict, derived from the Phase 3 gate output.
   * "PASS" is required for basis === "VERIFIED". "WARN" → PARTIAL, "FAIL" → SYNCING.
   */
  aaciChartHandshakeOverall: ChartHandshakeVerdict;

  /** Phase 3 gate output — consumers may inspect individual gate flags. */
  gateOutput: ChartGateOutput;

  /** Underlying intelligence state — full context for engine consumers. */
  state: ChartIntelligenceState;

  /**
   * Primary-timeframe candles fetched from the same provider chain as the
   * intelligence state. These are the canonical candles for structural reads —
   * the read-chart endpoint must NOT fetch candles separately; use these.
   */
  candles: Candle[];

  /**
   * Higher-timeframe candles for HTF bias, or [] when no HTF applies.
   * Same source as candles above.
   */
  htfCandles: Candle[];
}

export function buildTrustLine(
  gate: ChartGateOutput,
  alignment: BrokerPriceAlignment,
  timeframe: string,
  hasForming: boolean,
  aaciOverall: ChartHandshakeVerdict,
): string {
  const parts: string[] = [];

  if (gate.confidentReadAllowed) {
    parts.push(`Verified ${timeframe} candles`);
  } else {
    parts.push(`${timeframe} candles syncing`);
  }

  if (gate.autonomousChartActionAllowed) {
    parts.push("Live feed");
  } else {
    parts.push("Feed stale");
  }

  // Mirror segment reflects the REAL broker-alignment granularity (tight/normal
  // → synced, wide → drifting, unknown → no claim, seam/alignment-failed →
  // degraded) instead of the binary tradeConfirmationAllowed gate, so the line
  // never claims "Mirror synced" while the price is drifting or unverifiable.
  const mirror = mirrorTrustSegment(gate.tradeConfirmationAllowed, alignment);
  if (mirror) {
    parts.push(mirror);
  }

  if (aaciOverall === "PASS") {
    parts.push("AACI verified");
  } else if (aaciOverall === "WARN") {
    parts.push("AACI warning");
  } else {
    parts.push("AACI unverified");
  }

  if (hasForming) {
    parts.push("Forming candle active");
  }

  return parts.join(" · ");
}

/**
 * Truthful trust line for a GATED read (basis !== "VERIFIED").
 *
 * The success-path `buildTrustLine` is composed from the raw Phase-3 gate flags
 * (confidentReadAllowed / autonomousChartActionAllowed / tradeConfirmationAllowed)
 * which can disagree with the feed truth that drives `toBasis`. For example a W1
 * read can have every gate flag true (so `buildTrustLine` reads
 * "Verified W1 candles · Live feed · …") while the feed is delayed
 * (`state.aiUsable === false`) → `toBasis` returns INSUFFICIENT. Reusing the
 * success-path line on a gated read therefore claims verification and a live
 * feed the read does not have.
 *
 * This builder derives the line from the ACTUAL feed state, so a gated read can
 * NEVER emit "Verified …" or "Live feed". It is intentionally separate from
 * `buildTrustLine`, which is left untouched for the verified success path.
 */
export function buildGatedTrustLine(
  timeframe: string,
  feed: { available: boolean; stale: boolean; aiUsable: boolean; basis: RubyChartReadBasis },
): string {
  let feedPart: string;
  if (!feed.available) {
    feedPart = "feed unavailable";
  } else if (feed.stale) {
    feedPart = "feed stale";
  } else if (!feed.aiUsable) {
    feedPart = "feed delayed";
  } else {
    // The feed itself is fresh/usable but the read is still gated for a
    // non-feed reason (truth still syncing, or mirror/AACI handshake degraded
    // on a PARTIAL basis). Never claim verification or liveness.
    feedPart = feed.basis === "PARTIAL" ? "mirror syncing" : "awaiting sync";
  }
  return `${timeframe} candles syncing · ${feedPart} · read gated`;
}

/**
 * Truthful trust line for a STRUCTURAL_ONLY read — enough CLOSED history to read
 * DIRECTION, but the exact live trade setup is WITHHELD (the live feed isn't
 * confirmed for entry, or the shared sufficiency verdict won't allow the setup
 * yet). This is the footer the Scanner "Ruby Chart Read" panel and Ruby CHAT
 * both show, so it must mirror the Scanner header's feed limitation
 * ("Historical only · Feed not confirmed · Limited read") and can NEVER claim a
 * verified/live-confirmed/execution-ready feed.
 *
 * It is intentionally separate from {@link buildTrustLine} (the verified
 * success-path line, which CAN say "Verified · Live feed · AACI verified") and
 * from {@link buildGatedTrustLine} (the INSUFFICIENT "candles syncing" line —
 * appropriate when there isn't even enough history to read structure).
 */
export function buildStructuralReadTrustLine(
  timeframe: string,
  opts: { canUseCurrentCandleForEntry: boolean },
): string {
  // canUseCurrentCandleForEntry is true ONLY on a confirmed LIVE feed. When it
  // is false the read is from closed candles on an unconfirmed/delayed feed, so
  // name that limitation explicitly; otherwise the feed is live but the exact
  // setup is still withheld (sufficiency not met). Neither variant may use any
  // verified/live-confirmed token.
  if (opts.canUseCurrentCandleForEntry) {
    return `${timeframe} closed-candle structural read · Exact setup withheld · Entry confirmation pending`;
  }
  return `Historical/closed-candle ${timeframe} structural read · Feed not confirmed for live entry · Entry confirmation pending`;
}

function toBasis(
  gate: ChartGateOutput,
  state: ChartIntelligenceState,
  aaciOverall: ChartHandshakeVerdict,
): RubyChartReadBasis {
  if (!state.aiUsable || state.stale) return "INSUFFICIENT";
  if (!gate.confidentReadAllowed) return "SYNCING";
  // All three conditions must pass for VERIFIED:
  // - freshness (autonomousChartActionAllowed)
  // - mirror sync (tradeConfirmationAllowed)
  // - AACI chart handshake PASS
  if (!gate.autonomousChartActionAllowed || !gate.tradeConfirmationAllowed || aaciOverall !== "PASS") {
    return "PARTIAL";
  }
  return "VERIFIED";
}

/**
 * Build a RubyChartContext for the given symbol/timeframe. This is the SOLE
 * canonical source for Ruby chart reads:
 * - Builds/caches the intelligence state (no provider re-probe within 3s)
 * - Evaluates the AACI chart handshake from the Phase 3 gate output
 * - Fetches primary and HTF candles so endpoints use this context only
 *
 * Always returns an honest context: if no candles are available the basis is
 * INSUFFICIENT and blockReason explains why. Never fabricates readiness.
 */
export async function buildRubyChartContext(
  symbol: string,
  timeframe: ChartTimeframe,
  limit = 300,
): Promise<RubyChartContext> {
  const state = await buildChartIntelligenceState(symbol, timeframe, limit);
  const gate = state.gateOutput;

  // Compute AACI chart handshake from the Phase 3 gate — this is the same
  // computation snapshotService uses for the AACI snapshot, so it is
  // equivalent to what AACI consumers see.
  const aaciHandshake = buildChartHandshake(gate, state.chartTruthScore);
  const aaciChartHandshakeOverall = aaciHandshake.overall;

  const hasFormingCandle = state.currentCandle != null;
  const closedBarsCount = state.candleStats.barsAnalyzed;
  const limitedHistory = closedBarsCount < MIN_BARS_FULL_READ && closedBarsCount > 0;
  const liveDelayed =
    state.truthState.quality === "delayed" && hasRecentDerivTickFor(state.symbol);
  let basis = toBasis(gate, state, aaciChartHandshakeOverall);
  const trustLine = buildTrustLine(gate, state.brokerAlignment, timeframe, hasFormingCandle, aaciChartHandshakeOverall);
  let blockReason = gate.primaryBlockReason;

  // ── ONE DATA-SUFFICIENCY TRUTH ─────────────────────────────────────────────
  // The SAME shared verdict the scanner + chart consume. Read-only and
  // downgrade-only: it can only FORCE an insufficient/blocked read to
  // "INSUFFICIENT" — it never raises a gated read to VERIFIED and never touches
  // the freshness / mirror / AACI gates that toBasis already enforces. This is
  // what keeps Ruby and the scanner from contradicting each other on the same
  // symbol+timeframe.
  const sufficiency = evaluateSufficiencyFromChartState(state, timeframe);
  if (sufficiency.status === "insufficient" || sufficiency.status === "blocked") {
    basis = "INSUFFICIENT";
    blockReason = sufficiency.humanReason;
  }

  // Fetch candles from the same provider chain. The intelligence state was
  // built from the same chain (3s-cached), so this is a single coherent
  // source. Both primary and HTF are fetched here so the endpoint never needs
  // a separate getMarketData call.
  const htf = higherTimeframeOf(timeframe);
  const [candles, htfCandles] = await Promise.all([
    getMarketData(symbol, timeframe, limit).catch(() => [] as Candle[]),
    htf ? getMarketData(symbol, htf, 120).catch(() => [] as Candle[]) : Promise.resolve([] as Candle[]),
  ]);

  return {
    symbol: state.symbol,
    displaySymbol: state.displaySymbol,
    timeframe: state.timeframe,
    basis,
    confidentReadAllowed: gate.confidentReadAllowed,
    hasFormingCandle,
    closedBarsCount,
    limitedHistory,
    liveDelayed,
    sufficiency,
    trustLine,
    blockReason,
    aaciChartHandshakeOverall,
    gateOutput: gate,
    state,
    candles,
    htfCandles,
  };
}
