// ARX Smart Chart Intelligence — read-only normalization adapter.
//
// PURPOSE
//   Assemble the EXISTING chart-intelligence outputs into ONE normalized
//   envelope (SmartChartIntelligence) that Ruby, the chart UI, Scanner, and
//   future review/replay surfaces can consume without each re-deriving truth
//   from disconnected state.
//
// THIS FILE IS ADDITIVE AND READ-ONLY. It:
//   • imports the existing RubyChartContext (which already carries the Phase-3
//     gate output + the full ChartIntelligenceState) and reshapes it,
//   • NEVER recomputes Chart Truth, Chart Read, candle truth, structure, or any
//     engine — it only maps already-computed values,
//   • NEVER invents data: any input not supplied by the caller (scanner / timing
//     brain / news / open position / risk-AACI-security / broad flow) is
//     reported as an explicit `unavailable` / `not_verified` state and listed in
//     `unavailableInputs`,
//   • NEVER mutates its inputs (all reads; the returned object is fresh),
//   • preserves the truth gate as authoritative: when the chart-truth gate
//     blocks a confident read, bias→"unknown", confidence→null, and bestAction
//     is capped to a non-actionable state regardless of how strong the rest of
//     the engine output looks.
//
// It performs NO I/O and NO async work, so it cannot add latency to or trigger
// a chart rerender; callers pass already-fetched context in.
//
// Broad flow (Phase 14): there is NO broad-flow signal on ChartIntelligenceState
// in this codebase. The adapter therefore reports broadFlow as
// status:"not_verified", verified:false UNLESS a caller explicitly supplies a
// verified broad-flow read. This is deliberate — the adapter must not imply a
// broad-market confirmation that the system cannot prove.

import type { RubyChartContext } from "./rubyChartContext.js";
import type { ChartIntelligenceState } from "./chartIntelligence.js";
import type { ChartGateOutput } from "./chartGateOutput.js";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

// ── Public contract ─────────────────────────────────────────────────────────

export type SmartChartTruthStatus =
  | "verified" | "healthy" | "watch" | "degraded" | "blocked" | "unavailable";

export type SmartChartBias =
  | "bullish" | "bearish" | "range" | "neutral" | "conflict" | "unknown";

export type SmartChartMarketStage =
  | "compression" | "wake_up" | "early_move" | "active_move" | "pullback"
  | "retest" | "continuation" | "late" | "exhausted" | "reversal_risk"
  | "range_bound" | "invalidated" | "unknown";

export type SmartChartBestAction =
  | "trade_now" | "prepare_buy" | "prepare_sell" | "wait_for_pullback"
  | "wait_for_retest" | "wait_for_candle_close" | "watch_only" | "avoid"
  | "protect_open_trade" | "ask_ruby" | "open_scanner" | "no_trade"
  | "unavailable";

export interface SmartChartKeyLevels {
  support: number[];
  resistance: number[];
  liquidityTargets: number[];
  invalidationLevel?: number | null;
  entryZones?: Array<{
    side: "buy" | "sell";
    idealLow?: number; idealHigh?: number;
    lateAbove?: number; lateBelow?: number;
  }>;
}

export interface SmartChartScannerAgreement {
  status: "aligned" | "conflict" | "pending" | "unavailable";
  scannerSignal?: string;
  scannerConfidence?: number;
  reason?: string;
}

export interface SmartChartTimingBrain {
  heatScore?: number;
  tradeabilityScore?: number;
  heatState?: string;
  moveStage?: string;
  trapProbability?: number;
  roomToMove?: number;
  entryPermission?: string;
  timingGrade?: string;
  verified: boolean;
}

export interface SmartChartNewsContext {
  riskLevel?: "low" | "medium" | "high" | "critical" | "unknown";
  phase?: string;
  nextEventLabel?: string;
  timeToEventMs?: number;
  affected?: boolean;
  verified: boolean;
}

export interface SmartChartBroadFlow {
  status: "confirming" | "conflicting" | "mixed" | "unavailable" | "not_verified";
  explanation?: string;
  verified: boolean;
}

export interface SmartChartOpenPositionContext {
  hasOpenPosition: boolean;
  direction?: "buy" | "sell";
  entryPrice?: number;
  currentPl?: number;
  managementAction?: "hold" | "protect" | "no_addons" | "exit_or_reduce" | "watch" | "unavailable";
  conflictWithChart?: boolean;
  verified: boolean;
}

export interface SmartChartRiskAaciSecurity {
  riskStatus?: "ok" | "reduced" | "blocked" | "unknown";
  aaciStatus?: "synced" | "watch" | "conflict" | "blocked" | "unknown";
  securityStatus?: "ok" | "warn" | "blocked" | "unknown";
  tradeActionAllowed: boolean;
  blockedReason?: string;
}

export interface SmartChartSpeedEdge {
  signalAgeMs?: number;
  edgeStatus?: "fresh" | "on_time" | "decaying" | "late" | "expired" | "unknown";
  edgeDecay?: number;
}

export interface SmartChartIntelligence {
  intelligenceId: string;
  createdAt: number;

  symbol: string;
  displaySymbol?: string;
  brokerSymbol?: string;
  providerSymbol?: string;
  timeframe: string;

  chartTruthScore: number | null;
  chartReadScore: number | null;
  chartTruthStatus: SmartChartTruthStatus;
  chartReadAllowed: boolean;

  bias: SmartChartBias;
  confidence: number | null;
  marketStage: SmartChartMarketStage;
  bestAction: SmartChartBestAction;

  keyLevels?: SmartChartKeyLevels;
  candleStory?: {
    summary: string;
    lastCandlesAnalyzed?: number;
    formingCandleWarning?: string;
    closedCandleConfirmation?: string;
  };

  scannerAgreement?: SmartChartScannerAgreement;
  timingBrain?: SmartChartTimingBrain;
  newsContext?: SmartChartNewsContext;
  broadFlow?: SmartChartBroadFlow;
  openPositionContext?: SmartChartOpenPositionContext;
  riskAaciSecurity?: SmartChartRiskAaciSecurity;
  speedEdge?: SmartChartSpeedEdge;

  reasons: string[];
  warnings: string[];
  dataConfidenceLine: string;
  unavailableInputs: string[];
}

// ── Optional caller-supplied context ─────────────────────────────────────────
// These signals live in OTHER services (scanner route, timing brain, news,
// meLive positions, risk/AACI/security). The adapter never fetches them — a
// caller that already has a verified value passes it in; anything omitted is
// reported as unavailable. This keeps the adapter pure and non-inventing.

export interface SmartChartExternalContext {
  brokerSymbol?: string;
  providerSymbol?: string;
  scannerAgreement?: SmartChartScannerAgreement;
  timingBrain?: SmartChartTimingBrain;
  newsContext?: SmartChartNewsContext;
  broadFlow?: SmartChartBroadFlow;
  openPositionContext?: SmartChartOpenPositionContext;
  riskAaciSecurity?: SmartChartRiskAaciSecurity;
  /** Provide a fresh clock for deterministic tests. */
  now?: number;
  /** Deterministic id for tests; otherwise derived from symbol+tf+createdAt. */
  intelligenceId?: string;
}

// ── Internal mappers (pure) ──────────────────────────────────────────────────

function truthStatusFromLabel(label: string, confidentReadAllowed: boolean): SmartChartTruthStatus {
  // Chart Truth labels come from chartTruthScore.ts bands. Map onto the public
  // status set; when the confident-read gate is closed we never report better
  // than "blocked" so the read layer cannot present an actionable read.
  if (!confidentReadAllowed) return "blocked";
  const l = label.toLowerCase();
  if (l.includes("verified")) return "verified";
  if (l.includes("healthy")) return "healthy";
  if (l.includes("watch")) return "watch";
  if (l.includes("degraded") || l.includes("poor")) return "degraded";
  if (l.includes("unavailable") || l.includes("empty")) return "unavailable";
  // A passing gate with an unrecognized band is treated as "healthy" (never
  // upgraded to "verified" without an explicit label match).
  return "healthy";
}

function biasFrom(state: ChartIntelligenceState): SmartChartBias {
  // Prefer the decision summary bias (folds evidence); fall back to trend.
  const d = state.decisionState;
  if (d.populated) {
    if (d.vetoed) return "conflict";
    if (d.bias === "bullish") return "bullish";
    if (d.bias === "bearish") return "bearish";
    if (d.bias === "neutral") return "neutral";
  }
  const t = state.marketUnderstanding.trend;
  if (t.populated) {
    if (t.direction === "bullish") return "bullish";
    if (t.direction === "bearish") return "bearish";
    if (t.direction === "ranging") return "range";
    if (t.direction === "mixed") return "conflict";
  }
  return "unknown";
}

function marketStageFrom(state: ChartIntelligenceState): SmartChartMarketStage {
  // Map the setup-lifecycle stage onto the public market-stage vocabulary.
  const s = state.setupState;
  if (!s.populated) return "unknown";
  switch (s.stage) {
    case "idea_forming": return "wake_up";
    case "watchlist": return "compression";
    case "trigger": return "early_move";
    case "confirmation_needed": return "retest";
    case "entry_valid": return "continuation";
    case "trade_active": return "active_move";
    case "management": return "active_move";
    case "exit": return "exhausted";
    case "stale": return "late";
    case "invalid": return "invalidated";
    case "no_setup":
    case "review":
    default: return "range_bound";
  }
}

function confidenceFrom(state: ChartIntelligenceState): number | null {
  // The readiness score (0-100) is the closest existing "how tradable" figure.
  const r = state.marketUnderstanding.readiness;
  return r.populated && typeof r.score === "number" ? r.score : null;
}

function keyLevelsFrom(state: ChartIntelligenceState): SmartChartKeyLevels | undefined {
  const lv = state.marketUnderstanding.levels;
  if (!lv.populated) return undefined;
  const support = lv.levels.filter((l) => l.kind === "support").map((l) => l.price);
  const resistance = lv.levels.filter((l) => l.kind === "resistance").map((l) => l.price);
  const invalidationLevel = state.setupState.populated ? state.setupState.invalidationPrice : null;
  return {
    support,
    resistance,
    // No separate liquidity-target engine output is surfaced on the state today;
    // report an empty (honest) list rather than fabricating targets.
    liquidityTargets: [],
    invalidationLevel,
  };
}

function candleStoryFrom(
  state: ChartIntelligenceState,
  hasFormingCandle: boolean,
): SmartChartIntelligence["candleStory"] | undefined {
  const sentences = state.marketSentences;
  // marketSentences carries the plain-English candle/structure narrative. Use
  // the real `market` sentence text when the engine is populated; fall back to
  // the candle-intent note. No fabrication — empty when neither is present.
  const summary =
    (sentences.populated && sentences.market.text ? sentences.market.text : null) ??
    state.marketUnderstanding.candleIntent.note ??
    "";
  if (!summary) return undefined;
  const closedConfirm =
    sentences.populated && sentences.bestNextAction.text ? sentences.bestNextAction.text : undefined;
  return {
    summary,
    lastCandlesAnalyzed: state.candleStats.barsAnalyzed,
    formingCandleWarning: hasFormingCandle
      ? "Current candle is still forming — wait for it to close before confirming."
      : undefined,
    closedCandleConfirmation: hasFormingCandle ? undefined : closedConfirm,
  };
}

function speedEdgeFrom(state: ChartIntelligenceState): SmartChartSpeedEdge | undefined {
  const s = state.setupState;
  if (!s.populated) return undefined;
  // Map decay → edge status using the existing setup decay score (0-100, higher
  // = more decayed). No new computation; just a banding of an existing figure.
  let edgeStatus: SmartChartSpeedEdge["edgeStatus"] = "unknown";
  const decay = s.decayScore;
  if (typeof decay === "number") {
    if (s.stage === "stale" || s.stage === "invalid") edgeStatus = "expired";
    else if (decay >= 80) edgeStatus = "late";
    else if (decay >= 50) edgeStatus = "decaying";
    else if (decay >= 20) edgeStatus = "on_time";
    else edgeStatus = "fresh";
  }
  return { edgeStatus, edgeDecay: decay ?? undefined };
}

function bestActionFrom(
  bias: SmartChartBias,
  stage: SmartChartMarketStage,
  readAllowed: boolean,
  hasOpenConflict: boolean,
): SmartChartBestAction {
  // Truth gate is authoritative — a blocked read is never actionable.
  if (!readAllowed) return "watch_only";
  if (hasOpenConflict) return "protect_open_trade";
  switch (stage) {
    case "invalidated": return "avoid";
    case "exhausted": return "watch_only";
    case "late": return "wait_for_pullback";
    case "retest": return "wait_for_retest";
    case "compression":
    case "wake_up": return bias === "bullish" ? "prepare_buy" : bias === "bearish" ? "prepare_sell" : "watch_only";
    case "early_move":
    case "continuation": return bias === "bullish" || bias === "bearish" ? "wait_for_candle_close" : "watch_only";
    case "active_move": return "watch_only"; // do not chase an active move by default
    case "range_bound": return "watch_only";
    case "reversal_risk": return "watch_only";
    default: return "ask_ruby";
  }
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Assemble a normalized SmartChartIntelligence from an existing RubyChartContext
 * (which already embeds the authoritative Phase-3 gate output + full intelligence
 * state) plus any caller-supplied external context. Pure, read-only, no I/O.
 */
export function buildSmartChartIntelligence(
  ctx: RubyChartContext,
  external: SmartChartExternalContext = {},
): SmartChartIntelligence {
  const createdAt = external.now ?? Date.now();
  const gate: ChartGateOutput = ctx.gateOutput;
  const state: ChartIntelligenceState = ctx.state;

  const chartReadAllowed = gate.confidentReadAllowed === true;
  const chartTruthStatus = truthStatusFromLabel(gate.truthLabel, chartReadAllowed);

  const reasons: string[] = [];
  const warnings: string[] = [];
  const unavailableInputs: string[] = [];

  // ── Truth-gated read assembly ──────────────────────────────────────────────
  let bias: SmartChartBias;
  let confidence: number | null;
  let marketStage: SmartChartMarketStage;
  let bestAction: SmartChartBestAction;

  const openConflict =
    external.openPositionContext?.verified === true &&
    external.openPositionContext.conflictWithChart === true;

  if (!chartReadAllowed) {
    // Chart Truth gate closed → no directional read, no confidence, capped action.
    bias = "unknown";
    confidence = null;
    marketStage = "unknown";
    bestAction = openConflict ? "protect_open_trade" : "watch_only";
    if (ctx.blockReason) reasons.push(ctx.blockReason);
    else reasons.push(`Chart data is syncing. ${DEFAULT_ASSISTANT_NAME} will read once candles are verified.`);
  } else {
    bias = biasFrom(state);
    confidence = confidenceFrom(state);
    marketStage = marketStageFrom(state);
    bestAction = bestActionFrom(bias, marketStage, true, openConflict);
    if (state.marketUnderstanding.note) reasons.push(state.marketUnderstanding.note);
  }

  if (ctx.limitedHistory) {
    warnings.push("Limited candle history — read is advisory only.");
  }
  if (ctx.hasFormingCandle) {
    warnings.push("Current candle is still forming — confirmation pending until it closes.");
  }

  // ── External context (never invented) ──────────────────────────────────────
  const scannerAgreement: SmartChartScannerAgreement =
    external.scannerAgreement ?? { status: "unavailable" };
  if (!external.scannerAgreement) unavailableInputs.push("scannerAgreement");

  const timingBrain: SmartChartTimingBrain =
    external.timingBrain ?? { verified: false };
  if (!external.timingBrain) unavailableInputs.push("timingBrain");

  const newsContext: SmartChartNewsContext =
    external.newsContext ?? { verified: false, riskLevel: "unknown" };
  if (!external.newsContext) unavailableInputs.push("newsContext");

  // Broad flow is NOT a chart-state input in this codebase — always report
  // not_verified unless a caller supplies a verified read.
  const broadFlow: SmartChartBroadFlow =
    external.broadFlow && external.broadFlow.verified === true
      ? external.broadFlow
      : { status: "not_verified", verified: false, explanation: "Broad market flow is not wired to a verified source." };
  if (!(external.broadFlow && external.broadFlow.verified === true)) {
    unavailableInputs.push("broadFlow");
  }

  const openPositionContext: SmartChartOpenPositionContext =
    external.openPositionContext ?? { hasOpenPosition: false, verified: false };
  if (!external.openPositionContext) unavailableInputs.push("openPositionContext");

  const riskAaciSecurity: SmartChartRiskAaciSecurity =
    external.riskAaciSecurity ?? {
      riskStatus: "unknown", aaciStatus: "unknown", securityStatus: "unknown",
      tradeActionAllowed: false, blockedReason: "Trade-safety context not evaluated for this read.",
    };
  if (!external.riskAaciSecurity) unavailableInputs.push("riskAaciSecurity");

  // ── Honest data-confidence line ────────────────────────────────────────────
  // Reuse the already-scrubbed trust line from RubyChartContext (user-safe; no
  // internal gate codes). When the gate is closed this already reads "syncing".
  const dataConfidenceLine = ctx.trustLine;

  return {
    intelligenceId: external.intelligenceId ?? `sci_${ctx.symbol}_${ctx.timeframe}_${createdAt}`,
    createdAt,

    symbol: ctx.symbol,
    displaySymbol: ctx.displaySymbol,
    brokerSymbol: external.brokerSymbol,
    providerSymbol: external.providerSymbol,
    timeframe: ctx.timeframe,

    chartTruthScore: typeof gate.chartTruthScore === "number" ? gate.chartTruthScore : null,
    chartReadScore: typeof gate.chartReadScore === "number" ? gate.chartReadScore : null,
    chartTruthStatus,
    chartReadAllowed,

    bias,
    confidence,
    marketStage,
    bestAction,

    keyLevels: chartReadAllowed ? keyLevelsFrom(state) : undefined,
    candleStory: chartReadAllowed ? candleStoryFrom(state, ctx.hasFormingCandle) : undefined,

    scannerAgreement,
    timingBrain,
    newsContext,
    broadFlow,
    openPositionContext,
    riskAaciSecurity,
    speedEdge: chartReadAllowed ? speedEdgeFrom(state) : undefined,

    reasons,
    warnings,
    dataConfidenceLine,
    unavailableInputs,
  };
}
