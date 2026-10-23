// ── MARKET INTELLIGENCE — COMPOSING DISPLAY CONTRACT (Task #652, Phase 2) ──────
//
// SHARED, PURE composition of the six "Truth" child inputs (Direction, Pivot,
// Entry, OrderFlow, Timing, Confluence) plus the existing Pattern & Trendline
// truths into ONE `MarketIntelligenceSnapshot`, and a `StrategyVerdict` that maps
// a snapshot to an honest, DISPLAY-ONLY readiness label per analysis mode
// (research / backtest / forward_test / live_read).
//
// This module is PURE: no IO, no DB, no HTTP, no clock, no role/privilege input.
// Same inputs ⇒ same snapshot/verdict.
//
// ── SAFETY: THIS IS THE STRONGEST DISPLAY SURFACE — STILL DISPLAY-ONLY ───────
// `readiness: "ready_candidate"` is the highest label and STILL means "worth
// showing as a candidate", NOT permission to trade. There is deliberately NO
// execution-permission field anywhere in the snapshot or verdict
// (`allowExecution`, `canExecute`, `readyNow`, `commandExecutionAllowed`,
// `brokerDispatch`, `killSwitch`, `tradePermission` — none exist). The Auto-Bot
// and every caller must AND this with the real, separate 18-gate live-execution
// pipeline; the snapshot alone can never dispatch a broker order. Backtest /
// forward-test modes can NEVER produce `ready_candidate` (live truths absent).

import type { DirectionTruthVerdict } from "./directionTruthContract";
import type { PivotTruthVerdict } from "./pivotTruthContract";
import type { EntryTruthVerdict } from "./entryTruthContract";
import type { OrderFlowTruthVerdict } from "./orderFlowTruthContract";
import type { TimingTruthVerdict } from "./timingTruthContract";
import type { ConfluenceVerdict, FactorAlignment, ConfluenceFactorKey } from "./confluenceTruthContract";
import { resolveConfluence } from "./confluenceTruthContract";
import type { PatternTruthVerdict } from "./patternTruthContract";
import type { TrendlineTruthVerdict } from "./trendlineTruthContract";

/** The analysis mode the snapshot was produced under. Display-only. */
export type IntelligenceMode = "research" | "backtest" | "forward_test" | "live_read";

/** Honest, DISPLAY-ONLY readiness ladder. NOT an execution permission. */
export type IntelligenceReadiness =
  | "research_only" // study only — feed/sufficiency not satisfied for a setup
  | "context_only" // partial truth — context, not actionable
  | "watchlist" // worth watching
  | "conditional" // a setup exists but is conditional
  | "ready_candidate" // strongest label — a candidate worth close attention
  | "blocked"; // a hard truth blocks the setup

export type IntelligenceBias = "bullish" | "bearish" | "neutral" | "conflict" | "unknown";

export type IntelligenceQuality = "high" | "medium" | "low" | "none";

/** Feed/sufficiency truth carried into every snapshot. */
export interface IntelligenceFeedTruth {
  feedConfirmed: boolean;
  feedStale: boolean;
  sufficiencyAllowsSetup: boolean;
  chartReadConfidenceLow: boolean;
  candleCount: number;
  minimumRequiredCandles: number;
}

export interface IntelligenceRiskContext {
  rrAcceptable: boolean;
  currentRR: number | null;
  minimumRR: number;
  targetRoom: "enough_room" | "limited_room" | "no_room" | "unknown";
}

/** The composed read. Holds every child verdict; carries NO execution field. */
export interface MarketIntelligenceSnapshot {
  symbol: string;
  timeframe: string;
  /** Caller-supplied bucket/feed time (NOT a wall clock read in this module). */
  asOf: string | null;
  mode: IntelligenceMode;
  feed: IntelligenceFeedTruth;
  direction: DirectionTruthVerdict;
  pivot: PivotTruthVerdict;
  entry: EntryTruthVerdict;
  orderFlow: OrderFlowTruthVerdict;
  timing: TimingTruthVerdict;
  pattern: PatternTruthVerdict | null;
  trendline: TrendlineTruthVerdict | null;
  confluence: ConfluenceVerdict;
  risk: IntelligenceRiskContext;
  finalBias: IntelligenceBias;
  confidence: number;
  quality: IntelligenceQuality;
  warnings: string[];
  /** A short composed prose read for assistants/UX. Never a trade command. */
  explanation: string;
}

export interface StrategyVerdict {
  symbol: string;
  timeframe: string;
  mode: IntelligenceMode;
  readiness: IntelligenceReadiness;
  bias: IntelligenceBias;
  confidence: number;
  quality: IntelligenceQuality;
  /** The single most binding reason for the readiness label. */
  primaryReason: string;
  /** Ordered, human-readable checklist of what is/ isn't satisfied. */
  checklist: { label: string; satisfied: boolean; detail: string }[];
  warnings: string[];
}

const QUALITY_RANK: Record<IntelligenceQuality, number> = { none: 0, low: 1, medium: 2, high: 3 };

function minQuality(a: IntelligenceQuality, b: IntelligenceQuality): IntelligenceQuality {
  return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b;
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const CONTEXT_ONLY_CONF_CAP = 35;

export interface ComposeSnapshotInput {
  symbol: string;
  timeframe: string;
  asOf: string | null;
  mode: IntelligenceMode;
  feed: IntelligenceFeedTruth;
  direction: DirectionTruthVerdict;
  pivot: PivotTruthVerdict;
  entry: EntryTruthVerdict;
  orderFlow: OrderFlowTruthVerdict;
  timing: TimingTruthVerdict;
  pattern: PatternTruthVerdict | null;
  trendline: TrendlineTruthVerdict | null;
  risk: IntelligenceRiskContext;
  /** Backtest/forward stats, passed straight through to confluence (conf only). */
  reliability: {
    backtestWinRate: number | null;
    forwardWinRate: number | null;
    backtestSamples: number | null;
    forwardSamples: number | null;
  };
}

/** Map child verdicts to confluence factor alignment vs the final bias. */
function toFactorAlignment(
  bias: IntelligenceBias,
  input: ComposeSnapshotInput,
): Record<ConfluenceFactorKey, FactorAlignment> {
  const want: "buy" | "sell" | null = bias === "bullish" ? "buy" : bias === "bearish" ? "sell" : null;

  const dir = input.direction.scalpDirection;
  const dirAlign: FactorAlignment =
    dir === "wait"
      ? "missing"
      : dir === "mixed"
        ? "neutral"
        : want == null
          ? "neutral"
          : (dir === "buy" && want === "buy") || (dir === "sell" && want === "sell")
            ? "aligned"
            : "conflicting";

  const pivotAlign: FactorAlignment =
    input.pivot.scannerTruthImpact.supportive
      ? "aligned"
      : input.pivot.scannerTruthImpact.edgeAdjustment < 0
        ? "conflicting"
        : input.pivot.pivotBias === "neutral"
          ? "missing"
          : "neutral";

  const entryAlign: FactorAlignment =
    input.entry.entryStatus === "not_available"
      ? "missing"
      : input.entry.entryStatus === "invalidated" ||
          input.entry.entryStatus === "missed" ||
          input.entry.entryStatus === "too_late"
        ? "conflicting"
        : input.entry.entryStatus === "confirmed_candidate"
          ? "aligned"
          : "neutral";

  const ofAlign: FactorAlignment =
    input.orderFlow.supportsDirection === "unknown"
      ? "missing"
      : input.orderFlow.supportsDirection === "yes"
        ? "aligned"
        : input.orderFlow.supportsDirection === "no"
          ? "conflicting"
          : "neutral";

  const timingAlign: FactorAlignment =
    input.timing.timingStatus === "good"
      ? "aligned"
      : input.timing.timingStatus === "news_blocked" ||
          input.timing.timingStatus === "spread_blocked" ||
          input.timing.timingStatus === "late" ||
          input.timing.timingStatus === "exhausted"
        ? "conflicting"
        : "neutral";

  const patternAlign: FactorAlignment = input.pattern == null
    ? "missing"
    : input.pattern.scannerTruthImpact.supportive
      ? "aligned"
      : input.pattern.scannerTruthImpact.edgeAdjustment < 0
        ? "conflicting"
        : "neutral";

  const trendlineAlign: FactorAlignment = input.trendline == null
    ? "missing"
    : input.trendline.scannerTruthImpact.supportive
      ? "aligned"
      : input.trendline.scannerTruthImpact.edgeAdjustment < 0
        ? "conflicting"
        : "neutral";

  // S/R folds pivot + trendline; pattern is its own factor.
  const srAlign: FactorAlignment =
    pivotAlign === "aligned" || trendlineAlign === "aligned"
      ? "aligned"
      : pivotAlign === "conflicting" || trendlineAlign === "conflicting"
        ? "conflicting"
        : pivotAlign === "missing" && trendlineAlign === "missing"
          ? "missing"
          : "neutral";

  const rrAlign: FactorAlignment = input.risk.rrAcceptable ? "aligned" : "conflicting";

  return {
    direction: dirAlign,
    pivot: pivotAlign,
    support_resistance: srAlign,
    trendline: trendlineAlign,
    pattern: patternAlign,
    order_flow: ofAlign,
    timing: timingAlign,
    risk_reward: rrAlign,
  };
}

function resolveBias(input: ComposeSnapshotInput): IntelligenceBias {
  const d = input.direction.scalpDirection;
  const of = input.orderFlow.supportsDirection;
  if (input.direction.conflict) return "conflict";
  if (d === "wait" || d === "mixed") return "neutral";
  const dirBias: IntelligenceBias = d === "buy" ? "bullish" : "bearish";
  // Order flow contradiction → conflict surface (still display-only).
  if (of === "no") return "conflict";
  return dirBias;
}

/**
 * Compose the ONE shared snapshot. Confluence is recomputed here from the child
 * verdicts so the snapshot's score is internally consistent. Confidence is the
 * confluence confidence, bounded again by feed truth. NO execution field is set.
 */
export function composeMarketIntelligenceSnapshot(
  input: ComposeSnapshotInput,
): MarketIntelligenceSnapshot {
  const contextOnly =
    !input.feed.feedConfirmed || input.feed.feedStale || !input.feed.sufficiencyAllowsSetup;

  const finalBias = resolveBias(input);
  const factors = toFactorAlignment(finalBias, input);

  const confluence = resolveConfluence(
    {
      factors,
      hardCaps: {
        rrAcceptable: input.risk.rrAcceptable,
        directionConflict: input.direction.conflict || finalBias === "conflict",
        orderFlowContradicts: input.orderFlow.supportsDirection === "no",
        timingLateOrExhausted:
          input.timing.timingStatus === "late" || input.timing.timingStatus === "exhausted",
        timingBlocked:
          input.timing.timingStatus === "news_blocked" ||
          input.timing.timingStatus === "spread_blocked",
      },
      reliability: input.reliability,
    },
    {
      feedConfirmed: input.feed.feedConfirmed,
      feedStale: input.feed.feedStale,
      sufficiencyAllowsSetup: input.feed.sufficiencyAllowsSetup,
      chartReadConfidenceLow: input.feed.chartReadConfidenceLow,
    },
  );

  let confidence = confluence.confidence;
  if (contextOnly) confidence = Math.min(confidence, CONTEXT_ONLY_CONF_CAP);
  confidence = clampConfidence(confidence);

  const quality = minQuality(
    confluence.quality,
    contextOnly ? "low" : "high",
  );

  const warnings = dedupe([
    ...input.direction.warnings,
    ...input.pivot.warnings,
    ...input.entry.warnings,
    ...input.orderFlow.warnings,
    ...input.timing.warnings,
    ...(input.pattern?.warnings ?? []),
    ...(input.trendline?.warnings ?? []),
    ...confluence.warnings,
  ]);

  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    asOf: input.asOf,
    mode: input.mode,
    feed: input.feed,
    direction: input.direction,
    pivot: input.pivot,
    entry: input.entry,
    orderFlow: input.orderFlow,
    timing: input.timing,
    pattern: input.pattern,
    trendline: input.trendline,
    confluence,
    risk: input.risk,
    finalBias,
    confidence,
    quality,
    warnings,
    explanation: buildSnapshotExplanation({
      symbol: input.symbol,
      timeframe: input.timeframe,
      finalBias,
      confluence,
      contextOnly,
    }),
  };
}

/**
 * Map a snapshot to a DISPLAY-ONLY readiness label for a given mode. Backtest and
 * forward_test can NEVER reach `ready_candidate` — live truths (fresh feed,
 * timing, order flow) are absent by definition, so those modes cap at
 * `conditional`. This is the spine of spec tests 18–20: a snapshot can never
 * become an execution permission, and historical/forward stats never create
 * "ready now".
 */
export function deriveStrategyVerdict(snapshot: MarketIntelligenceSnapshot): StrategyVerdict {
  const contextOnly =
    !snapshot.feed.feedConfirmed || snapshot.feed.feedStale || !snapshot.feed.sufficiencyAllowsSetup;
  const action = snapshot.confluence.finalAction;

  let readiness: IntelligenceReadiness;
  if (action === "blocked") readiness = "blocked";
  else if (contextOnly) readiness = "context_only";
  else if (!snapshot.feed.sufficiencyAllowsSetup) readiness = "research_only";
  else {
    switch (action) {
      case "ready_candidate":
        readiness = "ready_candidate";
        break;
      case "conditional":
        readiness = "conditional";
        break;
      case "watch":
        readiness = "watchlist";
        break;
      case "wait":
        readiness = "watchlist";
        break;
      case "no_trade":
      default:
        readiness = "research_only";
        break;
    }
  }

  // HARD MODE CAP: only a live read can ever surface a ready candidate.
  // research/backtest/forward_test cap at `conditional` no matter the score.
  if (snapshot.mode !== "live_read" && readiness === "ready_candidate") {
    readiness = "conditional";
  }
  if (snapshot.mode === "backtest" || snapshot.mode === "forward_test") {
    if (readiness === "ready_candidate") readiness = "conditional";
  }

  const checklist: StrategyVerdict["checklist"] = [
    {
      label: "Live-confirmed feed",
      satisfied: snapshot.feed.feedConfirmed && !snapshot.feed.feedStale,
      detail: snapshot.feed.feedStale
        ? "Feed is delayed."
        : snapshot.feed.feedConfirmed
          ? "Feed is live-confirmed."
          : "Feed is not live-confirmed.",
    },
    {
      label: "Sufficient candles",
      satisfied: snapshot.feed.sufficiencyAllowsSetup,
      detail: `${snapshot.feed.candleCount}/${snapshot.feed.minimumRequiredCandles} candles.`,
    },
    {
      label: "Direction clear",
      satisfied: snapshot.finalBias === "bullish" || snapshot.finalBias === "bearish",
      detail: `Bias: ${snapshot.finalBias}.`,
    },
    {
      label: "Entry trigger confirmed",
      satisfied: snapshot.entry.entryStatus === "confirmed_candidate",
      detail: `Entry: ${snapshot.entry.entryStatus}.`,
    },
    {
      label: "Order flow supports",
      satisfied: snapshot.orderFlow.supportsDirection === "yes",
      detail: `Order flow (${snapshot.orderFlow.dataTier}): ${snapshot.orderFlow.supportsDirection}.`,
    },
    {
      label: "Timing approves",
      satisfied: snapshot.timing.timingApproved,
      detail: `Timing: ${snapshot.timing.timingStatus}.`,
    },
    {
      label: "Reward:risk acceptable",
      satisfied: snapshot.risk.rrAcceptable,
      detail:
        snapshot.risk.currentRR != null
          ? `RR ~${snapshot.risk.currentRR} (min ${snapshot.risk.minimumRR}).`
          : "RR unknown.",
    },
  ];

  return {
    symbol: snapshot.symbol,
    timeframe: snapshot.timeframe,
    mode: snapshot.mode,
    readiness,
    bias: snapshot.finalBias,
    confidence: snapshot.confidence,
    quality: snapshot.quality,
    primaryReason: buildPrimaryReason(snapshot, readiness),
    checklist,
    warnings: snapshot.warnings,
  };
}

function buildPrimaryReason(
  snapshot: MarketIntelligenceSnapshot,
  readiness: IntelligenceReadiness,
): string {
  if (readiness === "blocked") return snapshot.timing.confidenceCapReason ?? "Timing blocks the setup.";
  if (readiness === "context_only")
    return snapshot.confluence.confidenceCapReason ?? "Feed is not live-confirmed — context only.";
  if (readiness === "research_only")
    return snapshot.feed.sufficiencyAllowsSetup
      ? "No actionable setup — research only."
      : "Not enough live data for a setup — research only.";
  if (readiness === "ready_candidate")
    return "Multiple independent truths agree on a live feed — a candidate worth close attention (not trade permission).";
  if (readiness === "conditional")
    return snapshot.mode !== "live_read"
      ? `Conditional in ${snapshot.mode.replace(/_/g, " ")} — historical/forward analysis cannot create a live-ready candidate.`
      : "A setup exists but stays conditional until every truth aligns.";
  return "Worth watching — not enough alignment to act.";
}

function buildSnapshotExplanation(args: {
  symbol: string;
  timeframe: string;
  finalBias: IntelligenceBias;
  confluence: ConfluenceVerdict;
  contextOnly: boolean;
}): string {
  const { symbol, timeframe, finalBias, confluence, contextOnly } = args;
  const parts: string[] = [
    `${symbol} ${timeframe}: bias ${finalBias}, confluence ${confluence.finalAction} (score ${confluence.score}).`,
  ];
  if (confluence.alignedFactors.length) parts.push(`Aligned: ${confluence.alignedFactors.join(", ")}.`);
  if (confluence.conflictingFactors.length) parts.push(`Conflicting: ${confluence.conflictingFactors.join(", ")}.`);
  if (contextOnly) parts.push("Feed is not live-confirmed, so this is context only.");
  parts.push("This is a read, not a trade instruction.");
  return parts.join(" ");
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim().length > 0))];
}
