// Phase 4 — EleanorChartContext: verified, gate-checked context for Eleanor chart reads.
//
// Assembles the sole structured input for Eleanor's deterministic chart reads from
// Phase 3 gate outputs (ChartTruthScore, ChartReadScore, ChartGateOutput,
// BrokerPriceAlignment) and the already-built ChartIntelligenceState. Eleanor
// reads THIS structure rather than raw chart/candle component state.
//
// Phase 4 final: also fetches and owns the raw Candle[] so the read-chart
// endpoint uses this as its sole data source (no split-source divergence).
//
// SAFETY: READ-ONLY. Never places, modifies, or closes a trade. Never an
// execution gate. Never weakens the 16-gate live pipeline.

import { applyRenderEvidence } from "./renderEvidence.js";
import { buildChartIntelligenceState, type ChartIntelligenceState } from "./chartIntelligence.js";
import { truthResultOfState } from "./stateTruthResult.js";
import { candleTrustSegment, feedTrustSegment, gateMirrorBlockCause, type ChartGateOutput } from "./chartGateOutput.js";
import { mirrorTrustSegment, type BrokerPriceAlignment } from "./brokerPriceAlignment.js";
import { isMergeSeamMeasured } from "./chartTruthScore.js";
import type { ChartTimeframe } from "./timeframes.js";
import { buildChartHandshake, type ChartHandshakeVerdict } from "./chartHandshake.js";
import { closedCandlesOfState, evidenceOfState } from "./stateCandleWindow.js";
import { hasRecentDerivTickFor } from "../providers/derivProvider.js";
import { higherTimeframeOf } from "../../assistant/chartStructure.js";
import type { Candle } from "../../data/types.js";
import type { MarketDataSufficiencyVerdict } from "@workspace/domain/market";
import { evaluateSufficiencyFromChartState } from "./chartSufficiency.js";
import { enrichStateWithUserBrokerQuote } from "./userBrokerAlignment.js";
import { sameMarketReadSourceFamily } from "../../truth/marketReadEvidence.js";

/** Canonical trust basis for this Eleanor chart read. */
export type EleanorChartReadBasis =
  | "VERIFIED"   // Chart Truth ≥ 75, fresh feed, mirror clean, AACI handshake PASS
  | "PARTIAL"    // Trust ≥ 75 but freshness, mirror, or AACI handshake degraded
  | "SYNCING"    // Chart Truth < 75 — no directional read allowed
  | "INSUFFICIENT"; // No usable candles or provider not connected

const MIN_BARS_FULL_READ = 50;

export interface EleanorChartContext {
  symbol: string;
  displaySymbol: string;
  timeframe: string;

  /** Canonical trust basis — drives whether Eleanor may give a directional read. */
  basis: EleanorChartReadBasis;

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
   * chart consume too, so Eleanor can never say "candles syncing / cannot verify"
   * while the scanner shows a confident setup for the same symbol+timeframe.
   * When status is "insufficient"/"blocked", `basis` is forced to "INSUFFICIENT"
   * and `blockReason` carries this verdict's humanReason. Downgrade-only.
   */
  sufficiency: MarketDataSufficiencyVerdict;

  /**
   * Compact human trust line, always present.
   * e.g. "M5 candles: Chart Truth 87 (Healthy) · Live feed · Mirror synced"
   * or   "M5 candles syncing · Feed stale · Mirror degraded"
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

  /**
   * The canonical timeframe `htfCandles` were fetched on, or null when this
   * timeframe has no higher timeframe. Consumers must label any HTF-derived
   * statement with it (and must not assume the HTF is daily).
   */
  htfTimeframe: ChartTimeframe | null;
}

export function buildTrustLine(
  gate: ChartGateOutput,
  alignment: BrokerPriceAlignment,
  timeframe: string,
  hasForming: boolean,
  aaciOverall: ChartHandshakeVerdict,
  opts: {
    /** The served feed's status; "Live feed" needs a clean, confirmed-live feed. */
    feed?: { quality?: string | null; isLive?: boolean | null } | null;
    /** Candle-data rollup (every handshake check except renderer telemetry). */
    aaciSourceOverall?: ChartHandshakeVerdict;
    /**
     * Whether the merge seam was observed (isMergeSeamMeasured). false: the
     * mirror is "not confirmed" even when a bound broker quote is aligned.
     */
    mergeSeamChecked?: boolean;
  } = {},
): string {
  const parts: string[] = [];

  // "Verified" only in the score's own Verified band (see candleTrustSegment).
  parts.push(candleTrustSegment(gate, timeframe));

  // Not stale is not live: a delayed or not-live feed is named as such.
  parts.push(feedTrustSegment(gate.autonomousChartActionAllowed, opts.feed));

  // Mirror segment reflects the REAL broker-alignment granularity (tight/normal
  // → synced, wide → drifting, unknown → no claim, seam/alignment-failed →
  // degraded) instead of the binary tradeConfirmationAllowed gate, so the line
  // never claims "Mirror synced" while the price is drifting or unverifiable.
  const mirror = mirrorTrustSegment(gate.tradeConfirmationAllowed, alignment,
    { ...gateMirrorBlockCause(gate), seamUnchecked: opts.mergeSeamChecked === false });
  if (mirror) {
    parts.push(mirror);
  }

  if (aaciOverall === "PASS") {
    parts.push("AACI verified");
  } else if (aaciOverall === "WARN" && opts.aaciSourceOverall === "PASS") {
    // Only the renderer check is open: it cannot be measured server-side.
    parts.push("AACI candle checks pass · chart rendering not measured");
  } else if (aaciOverall === "WARN") {
    parts.push("AACI warning: some checks not confirmed");
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
  feed: {
    available: boolean; stale: boolean; aiUsable: boolean; basis: EleanorChartReadBasis;
    /** The served feed's quality grade; names why a non-stale feed is not usable. */
    quality?: string | null;
    /** The chart's own reason the series is not live (ChartFeedStatus.notLiveReason). */
    notLiveReason?: "market_closed" | "stored_history" | null;
  },
): string {
  let feedPart: string;
  if (!feed.available) {
    return `${timeframe} candles unavailable · feed unavailable · read gated`;
  } else if ((feed.stale || !feed.aiUsable) && feed.notLiveReason === "market_closed") {
    // The chart says "Market closed ... Not a feed fault": the candles are not
    // syncing and the feed is not stale or delayed — the market is shut.
    return `${timeframe} candles from before the weekend close · market closed · read gated`;
  } else if ((feed.stale || !feed.aiUsable) && feed.notLiveReason === "stored_history") {
    // The chart says "Showing stored MetaTrader 5 broker candles ... not a live feed".
    return `${timeframe} stored candles · not live · read gated`;
  } else if (feed.stale) {
    feedPart = "feed stale";
  } else if (!feed.aiUsable) {
    feedPart = unusableFeedPart(feed.quality);
  } else {
    // The feed itself is clean and current, so nothing is "syncing": the read
    // is gated by another check — Chart Truth below the 75 bar (SYNCING), or
    // a mirror / AACI handshake check that did not pass or could not be
    // measured (PARTIAL). Any other basis was gated by the caller for its own
    // stated reason (e.g. thin history), so no check is blamed here. Never
    // claim verification or liveness.
    const reason =
      feed.basis === "SYNCING" ? " · Chart Truth below 75"
      : feed.basis === "PARTIAL" ? " · not every chart check passed"
      : "";
    return `${timeframe} candles clean${reason} · read gated`;
  }
  return `${timeframe} ${feed.quality === "empty" || feed.quality === "unavailable" ? "candles unavailable" : "candle read withheld"} · ${feedPart} · read gated`;
}

/**
 * Trust-line words for a feed that is not stale but not usable, from its own
 * quality grade: only a "delayed" grade is a delayed feed. Candles with gaps,
 * duplicates or out-of-order bars ("partial"), or that failed their integrity
 * checks ("invalid"), are named as such; an unknown grade is "not confirmed".
 */
function unusableFeedPart(quality: string | null | undefined): string {
  switch (quality) {
    case "delayed": return "feed delayed";
    case "partial": return "candle sequence incomplete";
    case "invalid": return "candles failed integrity checks";
    case "empty":
    case "unavailable": return "no candles";
    default: return "feed not confirmed";
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Refusal reason for a feed that is not stale but not usable, naming what its
 * own quality grade observed (never "delayed" unless the grade is delayed).
 */
function unusableFeedReason(state: ChartIntelligenceState): string {
  const feed = state.truthState;
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
  switch (feed?.quality) {
    case "delayed":
      return "The chart feed is delayed, not live, so I won't draw a tradeable setup. I'll mark levels once it is live.";
    case "partial": {
      const seen = [
        count(feed.missingCandleCount) ? `${plural(count(feed.missingCandleCount), "missing bar")}` : null,
        count(feed.duplicateCount) ? `${plural(count(feed.duplicateCount), "duplicate bar")}` : null,
        count(feed.outOfOrderCount) ? `${plural(count(feed.outOfOrderCount), "out-of-order bar")}` : null,
      ].filter(Boolean);
      return `The chart's candle sequence is incomplete${seen.length ? ` (${seen.join(", ")})` : ""}, so I won't draw a tradeable setup. I'll mark levels once the candles are complete.`;
    }
    case "invalid": {
      const detail = count(feed.invalidOhlcCount)
        ? ` (${plural(count(feed.invalidOhlcCount), "bar")} with invalid OHLC)`
        : truthResultOfState(state)?.mockDataDetected
          ? " (the data looks simulated, not real market data)"
          : typeof feed.warning === "string" && /timestamps could not be confirmed/i.test(feed.warning)
            ? " (candle timestamps could not be confirmed)"
            : "";
      return `The chart's candles failed their integrity checks${detail}, so I won't draw a tradeable setup.`;
    }
    case "empty":
    case "unavailable":
      return "The chart has no candles to read right now, so I won't draw a tradeable setup.";
    default:
      return "The chart feed has not passed its checks, so I won't draw a tradeable setup.";
  }
}

// Candle-data handshake checks a gated read can name, in plain English.
// EleanorReadAllowed (the truth gate) and MirrorSync (a rollup of the merge seam
// and broker alignment) are covered by the explicit gate checks below.
type GatedCheck =
  | "ChartSource" | "OHLCIntegrity" | "TimeframeAccuracy" | "FeedFreshness"
  | "HistoricalLiveMerge" | "BrokerPriceAlignment" | "SelfTradeChartAllowed";
const GATED_CHECK_LABELS: ReadonlyArray<[GatedCheck, string]> = [
  ["ChartSource", "the chart source check"],
  ["OHLCIntegrity", "candle integrity"],
  ["TimeframeAccuracy", "the timeframe history check"],
  ["FeedFreshness", "feed freshness"],
  ["HistoricalLiveMerge", "the seam between closed history and the live candle"],
  ["BrokerPriceAlignment", "the broker price comparison"],
  ["SelfTradeChartAllowed", "the automated-trading chart check"],
];

/**
 * Plain-English reason a read is gated (basis !== "VERIFIED"), naming what was
 * actually not confirmed — the feed (stale / delayed), the candles (truth
 * still syncing) or the specific chart checks that have not passed. Used when
 * the gate itself has no primaryBlockReason (e.g. every gate flag is open but
 * the merge seam is unmeasured), so a refusal never falls back to "the chart
 * feed isn't confirmed" when the feed is. A VERIFIED read keeps the gate's own
 * block reason (normally null).
 */
export function gatedReadReason(
  ctx: Pick<EleanorChartContext, "basis" | "blockReason" | "gateOutput" | "state"> | null,
): string | null {
  if (!ctx) return "The chart could not be loaded, so I won't draw a tradeable setup.";
  if (ctx.blockReason) return ctx.blockReason;
  if (ctx.basis === "VERIFIED") return null;
  const { state, gateOutput: gate } = ctx;
  // A closed market or a stored series is what the chart says it is — never a
  // "stale" or "delayed" feed (same reason the chart message and warning use).
  if (state.stale || !state.aiUsable) {
    const notLive = state.truthState?.notLiveReason ?? null;
    if (notLive === "market_closed") {
      return "The market is in its scheduled weekend close, so there is no live data to draw a tradeable setup from. I'll mark levels once it reopens.";
    }
    if (notLive === "stored_history") {
      return "The chart is showing stored broker candles with no bridge pushing them, so there is no live data to draw a tradeable setup from.";
    }
  }
  if (state.stale) return "The chart feed is stale, so I won't draw a tradeable setup. I'll mark levels once it is live again.";
  if (!state.aiUsable) return unusableFeedReason(state);
  if (!gate.confidentReadAllowed) {
    return `The candles have not passed their checks yet (chart truth ${Math.round(gate.chartTruthScore)} of 100), so I won't draw a tradeable setup.`;
  }
  const pending: string[] = [];
  if (!gate.autonomousChartActionAllowed) pending.push("the feed is not fresh enough for a live setup");
  if (!gate.tradeConfirmationAllowed) pending.push("the chart price has not been confirmed against your broker's quote");
  const handshake = buildChartHandshake(gate, state.chartTruthScore);
  for (const [key, label] of GATED_CHECK_LABELS) {
    const verdict = handshake[key];
    if (verdict === "FAIL") pending.push(`${label} failed`);
    else if (verdict === "WARN") pending.push(`${label} is not confirmed`);
  }
  // The basis keeps the full handshake rollup, so chart rendering can be the
  // only open check: name it instead of a bare "not every check has passed".
  if (handshake.RenderHealth === "FAIL") {
    pending.push("chart rendering failed its check");
  } else if (handshake.RenderHealth === "WARN") {
    const render = state.chartTruthScore?.subMetrics?.find((m) => m.key === "render_accuracy");
    pending.push(render?.evidenceStatus === "measured" ? "chart rendering is not confirmed" : "chart rendering is not measured");
  }
  if (pending.length === 0) return "Not every chart check has passed, so I won't draw a tradeable setup.";
  return `Not every chart check has passed: ${pending.join("; ")}. I won't draw a tradeable setup until they do.`;
}

/**
 * Truthful trust line for a STRUCTURAL_ONLY read — enough CLOSED history to read
 * DIRECTION, but the exact live trade setup is WITHHELD (the live feed isn't
 * confirmed for entry, or the shared sufficiency verdict won't allow the setup
 * yet). This is the footer the Scanner "Eleanor Chart Read" panel and Eleanor CHAT
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
): EleanorChartReadBasis {
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
 * Build a EleanorChartContext for the given symbol/timeframe. This is the SOLE
 * canonical source for Eleanor chart reads:
 * - Builds/caches the intelligence state (no provider re-probe within 3s)
 * - Evaluates the AACI chart handshake from the Phase 3 gate output
 * - Fetches primary and HTF candles so endpoints use this context only
 *
 * Always returns an honest context: if no candles are available the basis is
 * INSUFFICIENT and blockReason explains why. Never fabricates readiness.
 */
export async function buildEleanorChartContext(
  symbol: string,
  timeframe: ChartTimeframe,
  limit = 300,
  opts: { userId?: number | null } = {},
): Promise<EleanorChartContext> {
  let state = await buildChartIntelligenceState(symbol, timeframe, limit);
  // A measured broker comparison needs a quote BOUND to the served series
  // (same provider, bridge and owner; owner == this user; observed, fresh tick
  // time — brokerQuoteBinding.ts). Absent or unbound, the mirror stays
  // unmeasured. Fail-open to the unenriched state.
  if (opts.userId != null) {
    try {
      state = await enrichStateWithUserBrokerQuote(state, { userId: opts.userId, symbol, timeframe, limit });
    } catch {
      // fail-open to the unenriched state: mirror remains unmeasured
    }
    // Render Accuracy is measured only by this user's own chart draw of the
    // served series (renderEvidence.ts). Absent or unbound, it stays unmeasured
    // and VERIFIED stays out of reach — owner ruling 2026-11-09: reads,
    // drawings and predictions must be accurate.
    state = applyRenderEvidence(state, opts.userId);
  }
  const gate = state.gateOutput;

  // Compute AACI chart handshake from the Phase 3 gate — this is the same
  // computation snapshotService uses for the AACI snapshot, so it is
  // equivalent to what AACI consumers see.
  const aaciHandshake = buildChartHandshake(gate, state.chartTruthScore);
  const aaciChartHandshakeOverall = aaciHandshake.overall;

  const hasFormingCandle = state.currentCandle != null;
  const candles = closedCandlesOfState(state);
  const closedBarsCount = candles.length;
  const limitedHistory = closedBarsCount < MIN_BARS_FULL_READ && closedBarsCount > 0;
  const liveDelayed =
    state.truthState.quality === "delayed" && hasRecentDerivTickFor(state.symbol);
  // Basis keeps the FULL handshake overall (renderer telemetry included), the
  // stricter rule this line runs: VERIFIED needs every check, measured. The
  // trust line names the candle-data rollup separately so it can say the
  // candle checks passed while rendering is not measured.
  let basis = toBasis(gate, state, aaciChartHandshakeOverall);
  const trustLine = buildTrustLine(gate, state.brokerAlignment, timeframe, hasFormingCandle, aaciChartHandshakeOverall,
    { feed: state.truthState, aaciSourceOverall: aaciHandshake.sourceOverall,
      mergeSeamChecked: isMergeSeamMeasured(truthResultOfState(state)) });
  let blockReason = gate.primaryBlockReason;

  // ── ONE DATA-SUFFICIENCY TRUTH ─────────────────────────────────────────────
  // The SAME shared verdict the scanner + chart consume. Read-only and
  // downgrade-only: it can only FORCE an insufficient/blocked read to
  // "INSUFFICIENT" — it never raises a gated read to VERIFIED and never touches
  // the freshness / mirror / AACI gates that toBasis already enforces. This is
  // what keeps Eleanor and the scanner from contradicting each other on the same
  // symbol+timeframe.
  const sufficiency = evaluateSufficiencyFromChartState(state, timeframe);
  if (sufficiency.status === "insufficient" || sufficiency.status === "blocked") {
    basis = "INSUFFICIENT";
    blockReason = sufficiency.humanReason;
  }

  // Read the exact window that produced the state, frozen at its last closed
  // bar. A second provider request can include a forming bar or switch source.
  // HTF context is independently closed and cannot see beyond this read's stamp.
  const htf = higherTimeframeOf(timeframe);
  const htfState = htf ? await buildChartIntelligenceState(symbol, htf, 120).catch(() => null) : null;
  const htfCandles = htfState && sameMarketReadSourceFamily(evidenceOfState(state), evidenceOfState(htfState))
    ? closedCandlesOfState(htfState, state.latestClosedCandle?.closeTime) : [];
  if (closedBarsCount !== state.candleStats.barsAnalyzed) {
    basis = "INSUFFICIENT";
    blockReason = "The closed candle window could not be bound to this chart read.";
  }

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
    htfTimeframe: htf,
  };
}
