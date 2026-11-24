import type { DecisionCandidate } from "@workspace/domain/self-trade";
import type { ForecastPaperGrade, ForecastPaperInstruction } from "@workspace/domain/structural";
import { resolveDerivSymbol } from "../data/providers/derivProvider.js";
import { publicPaperBrackets } from "../tradeEngine/publicPaperBrackets.js";
import { hasPaperQuoteCoverage } from "../tradeEngine/paperQuoteCoverage.js";
import type { AtiMt5QuoteOrigin } from "../data/atiMt5QuoteOrigin.js";
import type { AtiDerivQuoteFrame, AtiDerivQuoteOrigin } from "../data/atiDerivQuotes.js";
import { gradeAtiDerivReplay, type AtiDerivReplayWitness } from "./atiDerivQuoteReplay.js";
import { gradeAtiMt5Replay, type AtiMt5ReplayQuote, type AtiMt5ReplayWitness } from "./atiMt5QuoteReplay.js";
import { measuredRoundTripCosts, type AtiMeasuredCostProfile } from "./atiMeasuredCosts.js";
import { guardianComparisonPolicy, replayGuardianPair, type AtiGuardianGrade } from "./atiGuardian.js";
import type { ReplaySampleObserver, EntryReplayPolicy, SampledBracketPath } from "../tradeEngine/paperLevels.js";
import { ATI_DEFAULT_CHALLENGER, ATI_RETEST_WAIT_MS, atiCounterargumentPolicy, type AtiRetestPlan } from "./atiCounterargument.js";
import { gradeRetestLeg, type AtiRetestComparison } from "./atiRetestGrading.js";

export const ATI_SHADOW_GRADE_VERSION = "deriv-quote-bracket-1h-v1";
export const ATI_DERIV_ARCHIVE_GRADE_VERSION = "deriv-archived-quote-bracket-1h-v2";
export const ATI_MT5_GRADE_VERSION = "mt5-sampled-quote-bracket-1h-v1";
export const ATI_RETEST_GRADE_VERSION = "ati-retest-pair-1h-v1";
export const ATI_SHADOW_HOLD_WINDOW_MS = 60 * 60_000;
export const ATI_SHADOW_DECISION_SCOPE = "SOURCE_BOUND_SINGLE_AGENT_BEFORE_FLEET_SUPERVISION";
export const atiShadowDefinition = Object.freeze({
  timeframe: "M5", barMs: 5 * 60_000, baselineVersion: "self-trade-source-bound-v1",
  challengerVersion: ATI_DEFAULT_CHALLENGER,
});

export interface AtiAssumedCosts {
  adverseSlippagePerFillPriceUnits: number;
  feePerFillPriceUnits: number;
}

interface PairPnl {
  baselineR: number;
  challengerR: number;
}

export type AtiShadowGrade =
  | AtiGuardianGrade
  | AtiRetestComparison
  | { state: "UNRESOLVED"; reason: "UNSUPPORTED_QUOTE_SOURCE" | "MT5_REPLAY_ORIGIN_UNVERIFIED" | "DERIV_REPLAY_ORIGIN_UNVERIFIED" |
      "INVALID_PLAN" | "ENTRY_UNVERIFIED" | "QUOTE_HISTORY_INCOMPLETE" | "HOLD_WINDOW_ENDED" }
  | {
      state: "SIMULATED_FILL";
      quoteSource: "deriv_public" | "mt5_broker";
      mt5Replay?: AtiMt5ReplayWitness;
      derivReplay?: AtiDerivReplayWitness;
      observedPath?: SampledBracketPath;
      entry: number;
      exit: number;
      exitObservedAt: number;
      exitReason: "TARGET" | "STOP";
      baselineSizeRatio: number;
      challengerSizeRatio: number;
      riskPriceUnits: number;
      pnlRiskBasis?: "FROZEN_PLANNED_STOP_DISTANCE";
      quoteSidePnl: PairPnl;
      pnlWithAssumedCosts: PairPnl | null;
      pnlWithMeasuredCosts?: PairPnl | null;
      pnlWithMeasuredSlippage?: PairPnl | null;
    };

export function isAtiEntryDecision(outcome: string) {
  return outcome === "APPROVED" || outcome === "APPROVED_REDUCED";
}

interface GradeInput {
  observedAt: number;
  source: string | null;
  symbol: string;
  baseline: DecisionCandidate;
  challengerOutcome: string;
  assumedCosts: AtiAssumedCosts | null;
  measuredCosts?: AtiMeasuredCostProfile | null;
  retestPlan?: AtiRetestPlan;
  usePlannedRisk?: boolean;
  guardian?: boolean;
  mt5Replay?: { origin: AtiMt5QuoteOrigin; quote: AtiMt5ReplayQuote | null; rows: Parameters<typeof gradeAtiMt5Replay>[0] };
  // Undefined is a pre-archive observation. Null is a new observation with no verified anchor.
  derivReplay?: { origin: AtiDerivQuoteOrigin; quote: AtiMt5ReplayQuote | null; rows: readonly AtiDerivQuoteFrame[] } | null;
}

export function frozenAtiBracket(baseline: DecisionCandidate): (ForecastPaperInstruction & { action: "BUY" | "SELL" }) | null {
  const { side, thesis } = baseline;
  if (!side || !thesis?.entryZone || thesis.side !== side) return null;
  const reference = thesis.entryZone.from / 2 + thesis.entryZone.to / 2;
  const stop = thesis.stopLoss;
  const target = thesis.takeProfits?.[0]?.from;
  if (target == null || ![reference, stop, target].every((price) => Number.isFinite(price) && price > 0)) return null;
  if (side === "BUY" ? !(stop < reference && reference < target) : !(target < reference && reference < stop)) return null;
  return { action: side, reference, stop, target, reason: baseline.reason };
}

/** Grade only settled quote paths, or record explicitly unresolved coverage.
 * Actual execution, account P&L and broker costs have their own evidence. */
export function gradeAtiShadowPair(input: GradeInput, now: number): AtiShadowGrade | null {
  if (now <= input.observedAt) return null;
  const { symbol, baseline, observedAt, mt5Replay, derivReplay } = input;
  const mt5 = input.source === "mt5_broker";
  if (mt5 && !mt5Replay) return { state: "UNRESOLVED", reason: "MT5_REPLAY_ORIGIN_UNVERIFIED" };
  const market = input.source === "deriv_public" && resolveDerivSymbol(symbol);
  if (!mt5 && (!market || !hasPaperQuoteCoverage("deriv_public", market.symbol)))
    return { state: "UNRESOLVED", reason: "UNSUPPORTED_QUOTE_SOURCE" };
  if (market && (derivReplay === null || (derivReplay && derivReplay.origin.symbol !== market.derivId)))
    return { state: "UNRESOLVED", reason: "DERIV_REPLAY_ORIGIN_UNVERIFIED" };

  const plan = frozenAtiBracket(baseline);
  const entryExpiry = Date.parse(baseline.setupExpiresAt ?? "");
  if (!plan || !Number.isFinite(entryExpiry) || entryExpiry <= observedAt)
    return { state: "UNRESOLVED", reason: "INVALID_PLAN" };

  const end = observedAt + ATI_SHADOW_HOLD_WINDOW_MS;
  const asOf = Math.min(now, end);
  const replay = (expiry: number, policy?: EntryReplayPolicy, observe?: ReplaySampleObserver) => mt5Replay && mt5
    ? gradeAtiMt5Replay(mt5Replay.rows, mt5Replay.origin, mt5Replay.quote, symbol, plan, observedAt, asOf, expiry, policy, observe)
    : market && derivReplay ? gradeAtiDerivReplay(derivReplay.rows, derivReplay.origin, derivReplay.quote, plan, observedAt, asOf, expiry, policy, observe)
      : market ? publicPaperBrackets.gradeTicket(market.derivId, plan, observedAt, asOf, entryExpiry, true) : { state: "UNVERIFIED" as const };
  function comparisonCosts() {
    const measured = mt5 && input.measuredCosts ? measuredRoundTripCosts(input.measuredCosts, plan!.action) : null;
    const assumed = input.assumedCosts;
    return { assumed: assumed ? 2 * (assumed.adverseSlippagePerFillPriceUnits + assumed.feePerFillPriceUnits) : null,
      measuredSlippage: measured?.slippage ?? null, measured: measured?.slippageCommissionAndFee ?? null };
  }
  if (input.guardian) {
    if (market && !derivReplay) return { state: "UNRESOLVED", reason: "DERIV_REPLAY_ORIGIN_UNVERIFIED" };
    if (!isAtiEntryDecision(baseline.outcome) || input.challengerOutcome !== baseline.outcome || input.retestPlan)
      return { state: "UNRESOLVED", reason: "INVALID_PLAN" };
    const sizeRatio = baseline.outcome === "APPROVED_REDUCED" ? 0.5 : 1;
    const pair = replayGuardianPair(baseline.thesis!, sizeRatio, comparisonCosts());
    const raw = replay(entryExpiry, {}, pair.observe);
    const result = pair.result();
    const noFill = "noFill" in raw && raw.noFill?.tapeHash ? { ...raw.noFill, tapeHash: raw.noFill.tapeHash } : null;
    const status = result.baseline.exit && result.challenger.exit ? "SETTLED_PAIR" : noFill ? "NO_FILL" : "UNRESOLVED";
    if (status === "UNRESOLVED" && now < end) return null;
    return { ...result, state: "GUARDIAN_COMPARISON", status, policyVersion: guardianComparisonPolicy.version,
      quoteSource: mt5 ? "mt5_broker" : "deriv_public", mt5Mode: mt5 ? mt5Replay!.origin.mode : null, sizeRatio, noFill,
      reason: noFill?.reason ?? (status === "UNRESOLVED" ? raw.state === "OPEN" ? "HOLD_WINDOW_ENDED" : "QUOTE_HISTORY_INCOMPLETE" : null) };
  }
  const retest = input.retestPlan;
  if (retest) {
    if (market && !derivReplay) return { state: "UNRESOLVED", reason: "DERIV_REPLAY_ORIGIN_UNVERIFIED" };
    const zone = baseline.thesis!.entryZone!;
    const baselineSize = baseline.outcome === "APPROVED_REDUCED" ? 0.5 : 1;
    if (input.challengerOutcome !== "WAIT" || retest.expiresAtMs <= observedAt ||
        retest.expiresAtMs > Math.min(entryExpiry, observedAt + ATI_RETEST_WAIT_MS) || retest.sizeRatio > baselineSize ||
        retest.band.from !== Math.min(zone.from, zone.to) || retest.band.to !== Math.max(zone.from, zone.to)) {
      return { state: "UNRESOLVED", reason: "INVALID_PLAN" };
    }
    const plannedRisk = Math.abs(plan.reference - plan.stop);
    const legInput = { side: plan.action, stop: plan.stop, plannedRisk, costs: comparisonCosts(), decisionAt: observedAt, asOf, complete: now >= end };
    const baselineLeg = gradeRetestLeg(replay(entryExpiry, {}), { ...legInput, sizeRatio: baselineSize });
    const challengerLeg = gradeRetestLeg(replay(retest.expiresAtMs, { band: retest.band,
      maximumSpreadFractionOfStop: atiCounterargumentPolicy.spreadVetoFractionOfStop }), { ...legInput, sizeRatio: retest.sizeRatio });
    return baselineLeg && challengerLeg ? { state: "RETEST_COMPARISON", quoteSource: mt5 ? "mt5_broker" : "deriv_public",
      mt5Mode: mt5Replay?.origin.mode ?? null, plannedRiskPriceUnits: plannedRisk, baseline: baselineLeg, challenger: challengerLeg } : null;
  }
  const grade = replay(entryExpiry);
  if (grade.state === "TARGET" || grade.state === "STOP")
    return settledPair(input, plan, grade, asOf);
  if (grade.state === "SKIPPED") return { state: "UNRESOLVED", reason: "ENTRY_UNVERIFIED" };
  if (mt5 && grade.state === "UNVERIFIED") return { state: "UNRESOLVED", reason: "QUOTE_HISTORY_INCOMPLETE" };
  if (now < end) return null;
  return { state: "UNRESOLVED", reason: grade.state === "OPEN" ? "HOLD_WINDOW_ENDED" : "QUOTE_HISTORY_INCOMPLETE" };
}

function settledPair(
  input: GradeInput,
  plan: ForecastPaperInstruction & { action: "BUY" | "SELL" },
  grade: ForecastPaperGrade & { replay?: AtiMt5ReplayWitness; derivReplay?: AtiDerivReplayWitness; path?: SampledBracketPath },
  asOf: number,
): AtiShadowGrade {
  const { entry, exit, observedAt: exitObservedAt } = grade;
  if (entry == null || exit == null || exitObservedAt == null ||
      ![entry, exit, exitObservedAt].every((value) => Number.isFinite(value) && value > 0) ||
      exitObservedAt <= input.observedAt || exitObservedAt > asOf) {
    return { state: "UNRESOLVED", reason: "QUOTE_HISTORY_INCOMPLETE" };
  }
  const direction = plan.action === "BUY" ? 1 : -1;
  const riskPriceUnits = direction * (entry - plan.stop);
  if (riskPriceUnits <= 0) return { state: "UNRESOLVED", reason: "INVALID_PLAN" };
  const pricePnl = direction * (exit - entry);
  const pnlRisk = input.usePlannedRisk ? Math.abs(plan.reference - plan.stop) : riskPriceUnits;
  const baselineSizeRatio = input.baseline.outcome === "APPROVED_REDUCED" ? 0.5 : 1;
  const challengerSizeRatio = !isAtiEntryDecision(input.challengerOutcome) ? 0
    : input.challengerOutcome === "APPROVED_REDUCED" ? Math.min(baselineSizeRatio, 0.5) : baselineSizeRatio;
  const pair = (priceUnits: number) => ({
    baselineR: (priceUnits / pnlRisk) * baselineSizeRatio,
    challengerR: (priceUnits / pnlRisk) * challengerSizeRatio,
  });
  const quoteSidePnl = pair(pricePnl); // executable sides already include spread
  const costs = input.assumedCosts;
  const pnlWithAssumedCosts = costs
    ? pair(pricePnl - 2 * (costs.adverseSlippagePerFillPriceUnits + costs.feePerFillPriceUnits))
    : null;
  const measured = grade.replay && input.measuredCosts ? measuredRoundTripCosts(input.measuredCosts, plan.action) : null;
  function adjustForMeasured(cost: number | null | undefined) {
    if (cost == null) return null;
    const pnl = pair(pricePnl - cost);
    return Object.values(pnl).every(Number.isFinite) ? pnl : null;
  }
  if (![...Object.values(quoteSidePnl), ...Object.values(pnlWithAssumedCosts ?? {})].every(Number.isFinite))
    return { state: "UNRESOLVED", reason: "INVALID_PLAN" };
  return {
    state: "SIMULATED_FILL", quoteSource: grade.replay ? "mt5_broker" : "deriv_public", entry, exit, exitObservedAt,
    ...(grade.replay ? { mt5Replay: grade.replay } : {}),
    ...(grade.derivReplay ? { derivReplay: grade.derivReplay } : {}),
    ...(grade.path ? { observedPath: grade.path } : {}),
    exitReason: grade.state === "STOP" ? "STOP" : "TARGET",
    ...(input.usePlannedRisk ? { pnlRiskBasis: "FROZEN_PLANNED_STOP_DISTANCE" as const } : {}),
    baselineSizeRatio, challengerSizeRatio, riskPriceUnits, quoteSidePnl, pnlWithAssumedCosts,
    ...(grade.replay ? { pnlWithMeasuredSlippage: adjustForMeasured(measured?.slippage),
      pnlWithMeasuredCosts: adjustForMeasured(measured?.slippageCommissionAndFee) } : {}),
  };
}

type SimulatedFill = Extract<AtiShadowGrade, { state: "SIMULATED_FILL" }>;
type PnlBasis = "quoteSidePnl" | "pnlWithAssumedCosts" | "pnlWithMeasuredSlippage" | "pnlWithMeasuredCosts";
type SimulatedPerformance = Pick<SimulatedFill, "exitObservedAt" | "baselineSizeRatio" | "challengerSizeRatio" | PnlBasis>;

type ComparisonLeg = { riskMultiple: number | null; sizeRatio: number; exitAtMs: number | null };
type ComparisonPerformance = { baseline: ComparisonLeg; challenger: ComparisonLeg };
const returnKey = { quoteSidePnl: "quoteSideR", pnlWithAssumedCosts: "assumedR",
  pnlWithMeasuredCosts: "measuredR", pnlWithMeasuredSlippage: "measuredSlippageR" } as const;

export function atiComparisonPerformance(legacy: SimulatedPerformance[], retests: readonly AtiRetestComparison[], basis: PnlBasis, guardians: readonly AtiGuardianGrade[] = []): ComparisonPerformance[] {
  const ordinary = legacy.map((fill) => {
    const pnl = fill[basis];
    return {
      baseline: { riskMultiple: pnl?.baselineR ?? null, sizeRatio: fill.baselineSizeRatio, exitAtMs: fill.exitObservedAt },
      challenger: { riskMultiple: pnl?.challengerR ?? null, sizeRatio: fill.challengerSizeRatio, exitAtMs: fill.exitObservedAt },
    };
  });
  const project = (leg: AtiRetestComparison["baseline"]): ComparisonLeg => leg.state === "SIMULATED_FILL"
    ? { riskMultiple: leg.returns[returnKey[basis]], sizeRatio: leg.sizeRatio, exitAtMs: leg.exitAtMs }
    : { riskMultiple: leg.state === "NO_FILL" ? 0 : null, sizeRatio: 0, exitAtMs: null };
  const guardianReturn = { quoteSidePnl: "quoteSideR", pnlWithAssumedCosts: "assumedNetR",
    pnlWithMeasuredSlippage: "measuredSlippageR", pnlWithMeasuredCosts: "measuredNetR" } as const;
  const managed = guardians.map((grade) => {
    const projectLeg = (leg: AtiGuardianGrade["baseline"]): ComparisonLeg => ({
      riskMultiple: leg.exit?.[guardianReturn[basis]] ?? null, sizeRatio: grade.sizeRatio, exitAtMs: leg.exit?.at ?? null,
    });
    return { baseline: projectLeg(grade.baseline), challenger: projectLeg(grade.challenger) };
  });
  return [...ordinary, ...managed, ...retests.map((grade) => ({ baseline: project(grade.baseline), challenger: project(grade.challenger) }))];
}

function strategyMetrics(legs: ComparisonLeg[]) {
  const byExitTime = new Map<number, number>();
  let settledTrades = 0;
  for (const leg of legs) {
    if (leg.riskMultiple == null || !leg.sizeRatio || leg.exitAtMs == null) continue;
    settledTrades++;
    byExitTime.set(leg.exitAtMs, (byExitTime.get(leg.exitAtMs) ?? 0) + leg.riskMultiple);
  }
  let total = 0, peak = 0, drawdown = 0;
  for (const [, pnl] of [...byExitTime].sort((a, b) => a[0] - b[0])) {
    total += pnl;
    peak = Math.max(peak, total);
    drawdown = Math.max(drawdown, peak - total);
  }
  return {
    settledTrades,
    totalR: settledTrades ? total : null,
    expectancyR: settledTrades ? total / settledTrades : null,
    closedEquityDrawdownR: settledTrades ? drawdown : null,
  };
}

export function summarizeAtiComparison(rows: ComparisonPerformance[], extraCostRPerRoundTrip = 0) {
  function stress(leg: ComparisonLeg): ComparisonLeg {
    if (!extraCostRPerRoundTrip || leg.riskMultiple == null) return leg;
    return { ...leg, riskMultiple: leg.riskMultiple - extraCostRPerRoundTrip * leg.sizeRatio };
  }
  const values = rows.map((row) => ({ baseline: stress(row.baseline), challenger: stress(row.challenger) }));
  let lossesAvoided = 0, winnersSkipped = 0, pairedDifferenceR = 0, settledPairs = 0;
  for (const { baseline, challenger } of values) {
    if (baseline.riskMultiple == null || challenger.riskMultiple == null) continue;
    settledPairs++;
    pairedDifferenceR += challenger.riskMultiple - baseline.riskMultiple;
    if (challenger.sizeRatio === 0 && baseline.riskMultiple < 0) lossesAvoided++;
    if (challenger.sizeRatio === 0 && baseline.riskMultiple > 0) winnersSkipped++;
  }
  return {
    settledPairs,
    baseline: strategyMetrics(values.map((row) => row.baseline)),
    challenger: strategyMetrics(values.map((row) => row.challenger)),
    pairedDifferenceR: settledPairs ? pairedDifferenceR : null,
    lossesAvoided, winnersSkipped,
  };
}

export function summarizeAtiShadowGrades(fills: SimulatedPerformance[], basis: PnlBasis, retests: readonly AtiRetestComparison[] = [], guardians: readonly AtiGuardianGrade[] = []) {
  return summarizeAtiComparison(atiComparisonPerformance(fills, retests, basis, guardians));
}
