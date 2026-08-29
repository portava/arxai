// ── Ruby Structural Chart Read — SHARED service (Task #602 follow-on) ─────────
//
// THE single structural-read pipeline. Both the Scanner "Ruby Chart Read" panel
// (POST /me/assistant/read-chart) AND Ruby CHAT (the `readChartStructure` tool)
// call this one function, so the two surfaces can never disagree: same symbol +
// same timeframe ⇒ byte-identical `chartRead` payload and `readLayer`.
//
// Before this extraction the chat path collapsed to a weak market-context answer
// ("no primary timeframe / key levels not available"), while the panel produced
// the real directional STRUCTURAL read. Unifying on this service removes that
// second, weaker interpretation path.
//
// ⚠️ SAFETY — DISPLAY-ONLY, NEVER AN EXECUTION INPUT.
// This module owns ONLY the read/display pipeline. It deliberately does NOT:
//   - touch HTTP/SSE (callers own res.json),
//   - build the per-user safety envelope or the AACI block (callers add those),
//   - write a Decision Receipt (callers decide whether to record),
//   - gate the symbol universe (callers run resolveAssistantMarket / the
//     gateAssistantSymbolOr Top-250 gate first).
// `readLayer` is a DISPLAY tier (see rubyReadLayers.ts). It is NEVER an execution
// gate, NEVER weakens the live (16/23-gate) pipeline, and MUST NOT be imported by
// any execution/safety module (live command pipeline, dispatch gate,
// synthetic-floor, stop-loss policy, import-boundary guards).

import {
  analyzeChartStructure,
  quickTrend,
  type StructureBias,
  type DraftPlan,
} from "./chartStructure.js";
import { type ChartTimeframe, normalizeChartTimeframe } from "../data/chart/timeframes.js";
import {
  buildRubyChartContext,
  buildGatedTrustLine,
  buildStructuralReadTrustLine,
} from "../data/chart/rubyChartContext.js";
import { getChartFeedStatus } from "../data/chart/chartDataService.js";
import { deriveRubyReadLayers, resolveFeedUnconfirmed, type RubyReadLayer } from "./rubyReadLayers.js";
import { scrubUserCopyDeep } from "@workspace/domain/security";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";
import { neutralizeFeedCopy, neutralizeFeedCopyDeep } from "../honesty/feedTruthCopy.js";
import {
  evaluateTradeHealthReadiness,
  requiredClosedBarsForTimeframe,
} from "@workspace/domain/market";
import { buildPatternTruthVerdict } from "../data/chart/patternTruthService.js";
import { applyPatternLearning } from "./patternLearningRuntime.js";
import { buildTrendlineTruthVerdict } from "../data/chart/trendlineTruthService.js";
import { applyTrendlineLearning } from "./trendlineLearningRuntime.js";
import { buildMarketIntelligenceSnapshot } from "../data/chart/marketIntelligenceService.js";
import { buildGoldStrategyRead } from "./goldStrategyRead.js";
import { buildFvgStrategyRead, withholdFvgLevels } from "./fvgStrategyRead.js";
import type { Candle } from "../data/types.js";

/**
 * CHART PATTERN TRUTH (Task #617) — display-only narration for the Ruby read.
 * Runs the deterministic detector + the shared pattern contract over the candles
 * RubyChartContext already owns and returns the neutralized human explanation
 * plus the display-only status flags. Returns `null` when no pattern was detected
 * or the detector failed closed — the read is then left untouched. The pattern
 * is a CHILD INPUT: it never gates the read layer, the live setup, or execution.
 */
async function buildRubyPatternNote(args: {
  symbol: string;
  timeframe: ChartTimeframe;
  candles: Candle[];
  feedConfirmed: boolean;
  feedStale: boolean;
  sufficiencyAllowsSetup: boolean;
  /** Per-user learning loop (Task #617 Gap C). Null ⇒ record + nudge skipped. */
  userId: number | null;
}): Promise<{
  patternNote: string;
  patternStatus: string;
  patternConditional: boolean;
  patternContextOnly: boolean;
  // ── ADDITIVE learning-loop fields — present ONLY when the user has accrued
  // enough resolved history for a non-zero (bounded, ceiling-capped) nudge.
  patternConfidenceAdjustment?: number;
  patternAdjustedConfidence?: number;
  patternReliabilityScore?: number | null;
  patternReliabilityMarket?: string;
  patternReliabilitySamples?: number;
} | null> {
  const verdict = buildPatternTruthVerdict({
    symbol: args.symbol,
    timeframe: args.timeframe,
    rawCandles: args.candles,
    feedConfirmed: args.feedConfirmed,
    feedStale: args.feedStale,
    sufficiencyAllowsSetup: args.sufficiencyAllowsSetup,
    chartReadConfidenceLow: false,
    trend: "neutral",
    momentumAligned: false,
    nearSupportResistance: false,
    distanceToSrAtr: null,
    volatilityAtr: null,
  });
  if (!verdict || !verdict.dominantPattern) return null;

  // Learning loop: record this detection (fire-and-forget) and read back the
  // BOUNDED, ceiling-capped confidence nudge from the user's accrued history.
  // Best-effort + fail-open — never blocks or throws into the read.
  const learning = await applyPatternLearning({
    userId: args.userId,
    symbol: args.symbol,
    timeframe: args.timeframe,
    verdict,
    feedStatusAtDetection: args.feedConfirmed
      ? "LIVE_CONFIRMED"
      : args.feedStale
        ? "STALE"
        : "UNCONFIRMED",
  });

  return {
    patternNote: neutralizeFeedCopy(verdict.rubyExplanation),
    patternStatus: verdict.status,
    patternConditional: verdict.scannerTruthImpact.conditional,
    patternContextOnly: verdict.scannerTruthImpact.contextOnly,
    ...(learning
      ? {
          patternConfidenceAdjustment: learning.confidenceAdjustment,
          patternAdjustedConfidence: learning.adjustedConfidence,
          patternReliabilityScore: learning.reliabilityScore,
          patternReliabilityMarket: learning.marketClass,
          patternReliabilitySamples: learning.resolvedSamples,
        }
      : {}),
  };
}

/**
 * TRENDLINE TRUTH (Task #649) — display-only narration for the Ruby read.
 * Runs the deterministic trendline detector + the shared trendline contract over
 * the candles RubyChartContext already owns and returns the neutralized human
 * explanation plus the display-only status flags. Returns `null` when no
 * trendline was detected or the detector failed closed — the read is then left
 * untouched. The trendline is a CHILD INPUT: it never gates the read layer, the
 * live setup, or execution.
 */
async function buildRubyTrendlineNote(args: {
  symbol: string;
  timeframe: ChartTimeframe;
  candles: Candle[];
  feedConfirmed: boolean;
  feedStale: boolean;
  sufficiencyAllowsSetup: boolean;
  /** Per-user learning loop (Task #649). Null ⇒ record + nudge skipped. */
  userId: number | null;
}): Promise<{
  trendlineNote: string;
  trendlineStatus: string;
  trendlineConditional: boolean;
  trendlineContextOnly: boolean;
  // ── ADDITIVE learning-loop fields — present ONLY when the user has accrued
  // enough resolved history for a non-zero (bounded, ceiling-capped) nudge.
  trendlineConfidenceAdjustment?: number;
  trendlineAdjustedConfidence?: number;
  trendlineReliabilityScore?: number | null;
  trendlineReliabilityMarket?: string;
  trendlineReliabilitySamples?: number;
} | null> {
  const verdict = buildTrendlineTruthVerdict({
    symbol: args.symbol,
    timeframe: args.timeframe,
    rawCandles: args.candles,
    feedConfirmed: args.feedConfirmed,
    feedStale: args.feedStale,
    sufficiencyAllowsSetup: args.sufficiencyAllowsSetup,
    chartReadConfidenceLow: false,
    trend: "neutral",
    momentumAligned: false,
    nearSupportResistance: false,
    distanceToSrAtr: null,
    volatilityAtr: null,
  });
  if (!verdict || !verdict.dominantTrendline) return null;

  // Learning loop: record this detection (fire-and-forget) and read back the
  // BOUNDED, ceiling-capped confidence nudge from the user's accrued history.
  // Best-effort + fail-open — never blocks or throws into the read.
  const learning = await applyTrendlineLearning({
    userId: args.userId,
    symbol: args.symbol,
    timeframe: args.timeframe,
    verdict,
    feedStatusAtDetection: args.feedConfirmed
      ? "LIVE_CONFIRMED"
      : args.feedStale
        ? "STALE"
        : "UNCONFIRMED",
  });

  return {
    trendlineNote: neutralizeFeedCopy(verdict.rubyExplanation),
    trendlineStatus: verdict.status,
    trendlineConditional: verdict.scannerTruthImpact.conditional,
    trendlineContextOnly: verdict.scannerTruthImpact.contextOnly,
    ...(learning
      ? {
          trendlineConfidenceAdjustment: learning.confidenceAdjustment,
          trendlineAdjustedConfidence: learning.adjustedConfidence,
          trendlineReliabilityScore: learning.reliabilityScore,
          trendlineReliabilityMarket: learning.marketClass,
          trendlineReliabilitySamples: learning.resolvedSamples,
        }
      : {}),
  };
}

export interface RubyStructuralReadParams {
  /** Backend-resolvable symbol (panel: the raw request symbol; chat: the
   *  downstreamSymbol from resolveAssistantMarket). */
  symbol: string;
  /** Raw timeframe string ("15m" / "H1" / …). Normalized inside; an unmappable
   *  value yields the honest "unsupported timeframe" read. */
  timeframe: string;
  /** Optional user draft — only echoed on a FULL read (exact levels). */
  draft?: DraftPlan | null;
  /** Client-observed: the chart feed was NOT confirmed at read-time. Advisory
   *  only — the server still runs its own authoritative gate. */
  clientFeedUnconfirmed?: boolean;
  /** Authenticated user id, threaded ONLY for the per-user pattern learning loop
   *  (Task #617 Gap C). Null/absent ⇒ no observation recorded, no nudge. */
  userId?: number | null;
  /** Per-user assistant display name for user-facing copy (default Eleanor). */
  assistantName?: string;
}

export interface RubyStructuralReadOutcome {
  /** Fully scrubbed (and neutralized for STRUCTURAL_ONLY) display payload —
   *  identical shape across all read layers. */
  chartRead: Record<string, unknown>;
  /** PRIMARY wire signal — the read tier the panel renders. */
  readLayer: RubyReadLayer;
  /** Canonical timeframe used for the read; null ⇒ the requested timeframe was
   *  unsupported (the caller should fall back to the raw string for AACI). */
  normalizedTimeframe: ChartTimeframe | null;
  /** True only for FULL and STRUCTURAL_ONLY (INSUFFICIENT / unsupported do not
   *  record a Decision Receipt). The caller owns the write. */
  shouldRecordReadDecision: boolean;
  /** Receipt direction — the draft side on a FULL read, null otherwise. */
  recordDirection: "BUY" | "SELL" | null;
  /** DISPLAY-ONLY: the resolved feed-unconfirmed verdict (same signal the Scanner
   *  panel renders). Lets the chat reasoning block mirror the panel's INDEPENDENT
   *  feed-not-confirmed state instead of guessing it from `readLayer`. NEVER an
   *  execution input — the server still runs its own authoritative gate. */
  feedUnconfirmed: boolean;
}

const DISCLAIMER =
  "Decision support only — confirm live readiness and risk before trading.";

/**
 * Produce the directional STRUCTURAL read for `symbol` on `timeframe` from
 * CLOSED historical candles. The exact entry/stop/target/reward:risk are
 * WITHHELD unless the shared sufficiency verdict allows the live setup (FULL).
 *
 * Layers:
 *  - unsupported timeframe → INSUFFICIENT (honest, explicit; normalizedTimeframe null)
 *  - INSUFFICIENT → not enough closed history (or no context) to read structure
 *  - FULL → verified feed AND the exact live setup is allowed (levels shown)
 *  - STRUCTURAL_ONLY → enough structure to read DIRECTION, exact levels withheld
 */
// ── Shared trade-health DISPLAY fields (Trade Health / Eligibility contract) ──
// Composes the SAME readiness verdict resolveScannerTruth composes on the Scanner
// side, so Ruby's chart read and the Scanner surface the IDENTICAL display label /
// trust line for one symbol + timeframe + read layer. ADDITIVE + DISPLAY-ONLY:
// these fields sit BESIDE the existing trustLine/basis and never gate execution —
// the contract can only downgrade/explain, never grant a trade affordance.
function tradeHealthDisplayFields(args: {
  symbol: string;
  timeframe: string;
  freshnessVerdict: Parameters<typeof evaluateTradeHealthReadiness>[0]["freshnessVerdict"];
  availableClosedCandles: number;
  readLayer: RubyReadLayer;
}): { tradeHealthLabel: string; tradeHealthTrustLine: string; tradeHealthFreshness: string } {
  const verdict = evaluateTradeHealthReadiness({
    symbol: args.symbol,
    timeframe: args.timeframe,
    freshnessVerdict: args.freshnessVerdict,
    availableClosedCandles: args.availableClosedCandles,
    // Feed the SAME per-timeframe floor the Scanner uses (thr.minCandles) so the
    // shared label/affordances agree in the thin-history window — without this,
    // Ruby fell back to the bare MIN_SUFFICIENT_CLOSED_BARS (5) and could read
    // "Live-confirmed" while the Scanner said "Building history". Display-only,
    // downgrade-only: a larger floor can never grant eligibility.
    minimumRequiredCandles: requiredClosedBarsForTimeframe(args.timeframe),
    readLayer: args.readLayer,
  });
  return {
    tradeHealthLabel: verdict.displayLabel,
    tradeHealthTrustLine: verdict.userFacingTrustLine,
    tradeHealthFreshness: verdict.dataFreshness,
  };
}

export async function buildRubyStructuralRead(
  params: RubyStructuralReadParams,
): Promise<RubyStructuralReadOutcome> {
  const { symbol, timeframe } = params;
  const draft = params.draft ?? null;
  const clientFeedUnconfirmed = params.clientFeedUnconfirmed === true;
  const assistantName = params.assistantName ?? DEFAULT_ASSISTANT_NAME;

  // Normalize the requested timeframe to a canonical ARX code at the entry point.
  // The scanner sends lower-case aliases ("15m", "1h"); chart intelligence and
  // the candle-interval math are canonical-only. An unmappable timeframe is an
  // honest, explicit "unsupported timeframe" — never silently coerced.
  const tf = normalizeChartTimeframe(timeframe);
  if (!tf) {
    return {
      chartRead: scrubUserCopyDeep({
        symbol,
        timeframe,
        gated: true,
        ...tradeHealthDisplayFields({
          symbol,
          timeframe,
          freshnessVerdict: "AWAITING",
          availableClosedCandles: 0,
          readLayer: "INSUFFICIENT",
        }),
        // Display-only read layers (Task #602) — never an execution input.
        readLayer: "INSUFFICIENT",
        liveSetupWithheld: true,
        canReadStructure: false,
        canShowLiveTradeSetup: false,
        canUseCurrentCandleForEntry: false,
        basis: "INSUFFICIENT",
        headline: "That timeframe isn't supported for a chart read.",
        trustLine: `${timeframe}: unsupported timeframe`,
        blockedReason: `Unsupported timeframe "${timeframe}" — pick a standard chart timeframe (e.g. M15, H1, D1).`,
        reasonCode: null,
        chartTruthScore: null,
        chartReadScore: null,
        hasFormingCandle: false,
        dataQuality: "insufficient",
        disclaimer: DISCLAIMER,
      }),
      readLayer: "INSUFFICIENT",
      normalizedTimeframe: null,
      shouldRecordReadDecision: false,
      recordDirection: null,
      feedUnconfirmed: true,
    };
  }

  // buildRubyChartContext is the canonical verified input: it fetches/caches the
  // intelligence state, runs the truth + freshness + mirror gate checks, and
  // classifies into a basis. A throw is a fail-safe → treated as INSUFFICIENT.
  //
  // SERVER-AUTHORITATIVE FEED VERDICT: in parallel we resolve the SAME
  // ChartFeedStatus the Scanner chart header badge renders (getChartFeedStatus
  // with the live forming tip, exactly like GET /api/chart/candles) and derive
  // feed-confirmation from its `aiUsable` (true ONLY when quality === "clean").
  // The Scanner PANEL passes its observed feed verdict via `clientFeedUnconfirmed`,
  // but Ruby CHAT never does (the LLM has no feed observation) — so without this
  // the chat read would reach a FULL "Verified · Live feed · AACI verified"
  // footer while the panel/header honestly show "Historical only · Feed not
  // confirmed · Limited read". Computing the verdict here makes the two surfaces
  // agree regardless of what the caller passed. DISPLAY-ONLY — never execution.
  let rubyCtx: Awaited<ReturnType<typeof buildRubyChartContext>> | null = null;
  let feedStatus: Awaited<ReturnType<typeof getChartFeedStatus>> | null = null;
  try {
    [rubyCtx, feedStatus] = await Promise.all([
      buildRubyChartContext(symbol, tf, 200),
      // The SAME getChartFeedStatus(symbol, tf, true) the chart header badge
      // renders. Independently fail-safe: a thrown probe resolves to null and
      // resolveFeedUnconfirmed treats null as UNCONFIRMED (fail-closed).
      getChartFeedStatus(symbol, tf, true).catch(() => null),
    ]);
  } catch {
    // fail-safe — rubyCtx stays null (INSUFFICIENT branch below); feedStatus
    // stays null ⇒ resolveFeedUnconfirmed treats the feed as unconfirmed.
  }

  // Downgrade-only OR of the client's observation and the server-authoritative
  // ChartFeedStatus verdict (the SAME signal the Scanner header badge renders),
  // so Ruby CHAT and the Scanner panel can never disagree on the feed verdict.
  const feedUnconfirmed = resolveFeedUnconfirmed(clientFeedUnconfirmed, feedStatus);

  // Derive the three DISPLAY-ONLY read layers from the shared chart-context
  // signals. `readLayer` is the PRIMARY wire signal; the booleans are for
  // transparency. These NEVER gate execution.
  const layers = deriveRubyReadLayers({
    closedBarsCount: rubyCtx?.closedBarsCount ?? 0,
    freshnessVerdict: rubyCtx?.sufficiency.freshnessVerdict ?? null,
    canShowTradeSetup: rubyCtx?.sufficiency.canShowTradeSetup ?? false,
    clientFeedUnconfirmed: feedUnconfirmed,
  });

  // ── Layer INSUFFICIENT — not enough closed history (or no context) to read
  // structure at all. A non-VERIFIED feed WITH enough closed bars falls through
  // to the STRUCTURAL_ONLY read below.
  if (!rubyCtx || !layers.canReadStructure) {
    // ONE DATA-SUFFICIENCY TRUTH: thin closed-bar data outranks feed freshness.
    const sufficiencyBlocks =
      rubyCtx?.sufficiency.status === "insufficient" ||
      rubyCtx?.sufficiency.status === "blocked";
    const liveDelayedRead = rubyCtx?.liveDelayed === true && !sufficiencyBlocks;
    const blockedReason = liveDelayedRead
      ? `${tf} chart: live tick is active but the latest candle is delayed — directional read withheld until the current bar confirms.`
      : rubyCtx?.blockReason
        ?? rubyCtx?.sufficiency.humanReason
        ?? (rubyCtx?.basis === "PARTIAL"
          ? `${tf} chart: truth verified but ${rubyCtx.gateOutput.autonomousChartActionAllowed ? "mirror degraded" : "feed stale"} — directional read withheld.`
          : "Chart intelligence unavailable — cannot verify chart data.");
    const headline = liveDelayedRead
      ? "The feed is live but the latest candle is delayed. I'll give a full read once the current bar confirms."
      : rubyCtx?.basis === "PARTIAL"
        ? "Chart data is partially verified. I'll give a full read once the feed and mirror are healthy."
        : "Not enough closed candle history yet to read structure on this timeframe. I'll read it once more candles load.";
    return {
      chartRead: scrubUserCopyDeep({
        symbol,
        timeframe: tf,
        gated: true,
        ...tradeHealthDisplayFields({
          symbol,
          timeframe: tf,
          freshnessVerdict: rubyCtx?.sufficiency.freshnessVerdict ?? "AWAITING",
          availableClosedCandles: rubyCtx?.closedBarsCount ?? 0,
          readLayer: "INSUFFICIENT",
        }),
        readLayer: "INSUFFICIENT",
        liveSetupWithheld: true,
        canReadStructure: false,
        canShowLiveTradeSetup: false,
        canUseCurrentCandleForEntry: layers.canUseCurrentCandleForEntry,
        basis: rubyCtx?.basis ?? "INSUFFICIENT",
        headline,
        // HONESTY: never reuse rubyCtx.trustLine here — the success-path trust
        // line is composed from raw gate flags and can read "Verified · Live
        // feed" even when this branch is gated. Derive from the ACTUAL feed state.
        trustLine: buildGatedTrustLine(tf, {
          available: rubyCtx != null,
          stale: rubyCtx?.state.stale ?? false,
          aiUsable: rubyCtx?.state.aiUsable ?? false,
          basis: rubyCtx?.basis ?? "INSUFFICIENT",
        }),
        blockedReason,
        // READABILITY CONTRACT: emit the SAME shared reasonCode the scanner and
        // opportunity map surface, so every surface withholds for one reason.
        reasonCode: rubyCtx?.sufficiency.reasonCode ?? null,
        chartTruthScore: rubyCtx?.gateOutput.chartTruthScore ?? null,
        chartReadScore: rubyCtx?.gateOutput.chartReadScore ?? null,
        hasFormingCandle: rubyCtx?.hasFormingCandle ?? false,
        dataQuality: "insufficient",
        disclaimer: DISCLAIMER,
      }),
      readLayer: "INSUFFICIENT",
      normalizedTimeframe: tf,
      shouldRecordReadDecision: false,
      recordDirection: null,
      feedUnconfirmed: true,
    };
  }

  // Enough closed history to read structure. Use candles already owned by
  // RubyChartContext — no separate provider fetch; rubyCtx is the sole source.
  const candles = rubyCtx.candles;
  let htfBias: StructureBias = "No clear edge";
  if (rubyCtx.htfCandles.length >= 10) htfBias = quickTrend(rubyCtx.htfCandles);

  // ── MARKET INTELLIGENCE (Task #652) — ADDITIVE, DISPLAY-ONLY child input ─────
  // Composes the six pure "Truth" verdicts (Pivot/Direction/Entry/OrderFlow/
  // Timing/Confluence) + Pattern/Trendline into ONE snapshot from the SAME
  // RubyChartContext (mt5_broker-aware). Fail-closed to null. The snapshot carries
  // NO execution-permission field; it can only downgrade/explain what is SHOWN and
  // never grants a trade affordance. It rides inside the scrubbed (and, on
  // STRUCTURAL_ONLY, neutralized) payload alongside patternRead/trendlineRead.
  const intel = buildMarketIntelligenceSnapshot(rubyCtx);
  const intelRead = intel
    ? { marketIntelligenceRead: { snapshot: intel.snapshot, verdict: intel.verdict } }
    : {};

  // ── GOLD STRATEGY MODE (Task #657) — ADDITIVE, DISPLAY-ONLY child input ──────
  // Activates ONLY for gold symbols. Composes the pure gold domain layer over the
  // candles RubyChartContext already owns: honest macro ("unavailable" — no macro
  // provider wired here) + ATR-derived risk state. It can DESCRIBE/WARN/CAP only;
  // it carries no trade affordance, never grants READY_NOW, and never weakens the
  // feed/sufficiency/Trade-Health/live gates. Null for non-gold symbols.
  const goldRead = buildGoldStrategyRead({ symbol, candles: rubyCtx.candles });
  const goldBlock = goldRead ? { goldStrategyRead: goldRead } : {};

  // ── HTF TREND FVG PULLBACK (Task #675) — ADDITIVE, DISPLAY-ONLY child input ──
  // Fetches H4 + H1 + M5 candles (fail-open) and runs the pure FVG engine.
  // The block carries advisory explanation + chart overlay descriptors only; it can
  // DESCRIBE/WARN/HIGHLIGHT but never grants a trade affordance, never produces
  // READY_NOW, and never weakens any feed/sufficiency/Trade-Health/live gate.
  // Absent (null) when the symbol has no multi-TF candle data.
  let fvgH4Candles: Candle[] = [];
  let fvgH1Candles: Candle[] = [];
  let fvgM5Candles: Candle[] = [];
  let fvgIsSimulator = false;
  const fvgStaleTimeframes: string[] = [];
  try {
    const { routeCandles: rcFvg } = await import("../data/marketDataRouter.js");
    const [h4r, h1r, m5r] = await Promise.allSettled([
      rcFvg(symbol, "H4", 220),
      rcFvg(symbol, "H1", 220),
      rcFvg(symbol, "M5", 100),
    ]);
    const isMockProvider = (p: string | null) =>
      p != null && (p === "assistant_real:mock" || p.endsWith(":mock") || p === "mock");
    const hasStaleAttempt = (v: { attempts: { reason: string | null }[] }) =>
      v.attempts.some((a) => a.reason?.includes("STALE"));
    // Detect simulator: mock provider returns ok=true with candles but is never live.
    if (h4r.status === "fulfilled" && h4r.value.ok && isMockProvider(h4r.value.primaryProvider)) fvgIsSimulator = true;
    if (h1r.status === "fulfilled" && h1r.value.ok && isMockProvider(h1r.value.primaryProvider)) fvgIsSimulator = true;
    if (m5r.status === "fulfilled" && m5r.value.ok && isMockProvider(m5r.value.primaryProvider)) fvgIsSimulator = true;
    // Detect stale: any provider attempt reported a STALE reason — flag the TF.
    if (h4r.status === "fulfilled" && hasStaleAttempt(h4r.value)) fvgStaleTimeframes.push("H4");
    if (h1r.status === "fulfilled" && hasStaleAttempt(h1r.value)) fvgStaleTimeframes.push("H1");
    if (m5r.status === "fulfilled" && hasStaleAttempt(m5r.value)) fvgStaleTimeframes.push("M5");
    fvgH4Candles = h4r.status === "fulfilled" && h4r.value.ok ? h4r.value.candles : [];
    fvgH1Candles = h1r.status === "fulfilled" && h1r.value.ok ? h1r.value.candles : [];
    fvgM5Candles = m5r.status === "fulfilled" && m5r.value.ok ? m5r.value.candles : [];
  } catch { /* fail-open: fvg block absent */ }
  const fvgRead = buildFvgStrategyRead({
    symbol,
    m5Candles: fvgM5Candles,
    h1Candles: fvgH1Candles,
    h4Candles: fvgH4Candles,
    isSimulator: fvgIsSimulator,
    staleTimeframes: fvgStaleTimeframes,
  });
  const fvgBlock = fvgRead ? { fvgStrategyRead: fvgRead } : {};
  // Feed-unconfirmed (STRUCTURAL_ONLY) variant: the FVG engine's staleness check
  // is INDEPENDENT of the primary read's feed verdict, so strip its numeric
  // levels before they can ship on a structural read (downgrade-only display
  // filter — never alters direction, never touches a gate).
  const fvgBlockWithheld = fvgRead
    ? { fvgStrategyRead: withholdFvgLevels(fvgRead) }
    : {};

  // ── Layer FULL — verified feed AND the shared sufficiency verdict allows the
  // exact live trade setup (entry/SL/TP echoed from the user's draft when present).
  if (rubyCtx.basis === "VERIFIED" && layers.canShowLiveTradeSetup) {
    const read = analyzeChartStructure(candles, { htfBias, draft: draft ?? null, assistantName });
    const trustLine = rubyCtx.trustLine;
    const patternNote = await buildRubyPatternNote({
      symbol,
      timeframe: tf,
      candles,
      feedConfirmed: true,
      feedStale: false,
      sufficiencyAllowsSetup: true,
      userId: params.userId ?? null,
    });
    const trendlineNote = await buildRubyTrendlineNote({
      symbol,
      timeframe: tf,
      candles,
      feedConfirmed: true,
      feedStale: false,
      sufficiencyAllowsSetup: true,
      userId: params.userId ?? null,
    });
    const chartReadPayload = scrubUserCopyDeep({
      symbol,
      timeframe: tf,
      ...read,
      ...(patternNote ? { patternRead: patternNote } : {}),
      ...(trendlineNote ? { trendlineRead: trendlineNote } : {}),
      ...intelRead,
      ...goldBlock,
      ...fvgBlock,
      gated: false,
      ...tradeHealthDisplayFields({
        symbol,
        timeframe: tf,
        freshnessVerdict: rubyCtx.sufficiency.freshnessVerdict ?? "AWAITING",
        availableClosedCandles: rubyCtx.closedBarsCount,
        readLayer: "FULL",
      }),
      readLayer: "FULL",
      liveSetupWithheld: false,
      canReadStructure: true,
      canShowLiveTradeSetup: true,
      canUseCurrentCandleForEntry: layers.canUseCurrentCandleForEntry,
      trustLine,
      basis: rubyCtx.basis,
      chartTruthScore: rubyCtx.gateOutput.chartTruthScore,
      chartReadScore: rubyCtx.gateOutput.chartReadScore,
      hasFormingCandle: rubyCtx.hasFormingCandle,
      reasonCode: rubyCtx.sufficiency.reasonCode,
      disclaimer: DISCLAIMER,
    });
    return {
      chartRead: chartReadPayload,
      readLayer: "FULL",
      normalizedTimeframe: tf,
      shouldRecordReadDecision: true,
      recordDirection: draft?.side ?? null,
      feedUnconfirmed,
    };
  }

  // ── Layer STRUCTURAL_ONLY (Task #602) — enough closed history to read
  // DIRECTION, but the live feed is unconfirmed/delayed, or the shared
  // sufficiency verdict won't allow the exact setup yet. Produce the directional
  // read and EXPLICITLY WITHHOLD exact entry/stop/target/reward:risk. The
  // structure analyzer never emits numeric levels, and we force `draft: null` so
  // no level echo can leak.
  const read = analyzeChartStructure(candles, { htfBias, draft: null, assistantName });
  const withheldReason =
    rubyCtx.sufficiency.humanReason ??
    rubyCtx.blockReason ??
    "Live trade setup withheld until the feed confirms.";
  read.cautions = [
    ...read.cautions,
    `Exact entry, stop, and target levels withheld — ${withheldReason}`,
  ];
  if (!layers.canUseCurrentCandleForEntry) {
    read.cautions = [
      ...read.cautions,
      "Read is from closed candles only — current-candle/entry confirmation pending.",
    ];
  }
  const structuralPattern = await buildRubyPatternNote({
    symbol,
    timeframe: tf,
    candles,
    feedConfirmed: false,
    feedStale: rubyCtx.basis !== "VERIFIED",
    sufficiencyAllowsSetup: false,
    userId: params.userId ?? null,
  });
  const structuralTrendline = await buildRubyTrendlineNote({
    symbol,
    timeframe: tf,
    candles,
    feedConfirmed: false,
    feedStale: rubyCtx.basis !== "VERIFIED",
    sufficiencyAllowsSetup: false,
    userId: params.userId ?? null,
  });
  const structuralPayload = scrubUserCopyDeep({
    symbol,
    timeframe: tf,
    ...read,
    ...(structuralPattern ? { patternRead: structuralPattern } : {}),
    ...(structuralTrendline ? { trendlineRead: structuralTrendline } : {}),
    ...intelRead,
    ...goldBlock,
    ...fvgBlockWithheld,
    gated: false,
    ...tradeHealthDisplayFields({
      symbol,
      timeframe: tf,
      freshnessVerdict: rubyCtx.sufficiency.freshnessVerdict ?? "AWAITING",
      availableClosedCandles: rubyCtx.closedBarsCount,
      readLayer: "STRUCTURAL_ONLY",
    }),
    readLayer: "STRUCTURAL_ONLY",
    liveSetupWithheld: true,
    canReadStructure: true,
    canShowLiveTradeSetup: false,
    canUseCurrentCandleForEntry: layers.canUseCurrentCandleForEntry,
    // Honest trust line that mirrors the Scanner panel/header feed limitation —
    // a structural read never claims "Verified · Live feed · AACI verified"
    // while the exact live setup is withheld. Names the closed-candle /
    // feed-not-confirmed-for-entry limitation explicitly.
    trustLine: buildStructuralReadTrustLine(tf, {
      canUseCurrentCandleForEntry: layers.canUseCurrentCandleForEntry,
    }),
    basis: rubyCtx.basis,
    blockedReason: withheldReason,
    chartTruthScore: rubyCtx.gateOutput.chartTruthScore,
    chartReadScore: rubyCtx.gateOutput.chartReadScore,
    hasFormingCandle: rubyCtx.hasFormingCandle,
    reasonCode: rubyCtx.sufficiency.reasonCode,
    disclaimer: DISCLAIMER,
  });
  return {
    // The exact setup is withheld, so neutralise any confident trade language.
    chartRead: neutralizeFeedCopyDeep(structuralPayload),
    readLayer: "STRUCTURAL_ONLY",
    normalizedTimeframe: tf,
    shouldRecordReadDecision: true,
    recordDirection: null,
    feedUnconfirmed,
  };
}
