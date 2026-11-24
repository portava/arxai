import { createHash } from "node:crypto";
import { stableStringify } from "@workspace/features/event-chain";
import { runMonteCarloValidation } from "@workspace/domain/validation-command-center";
import { chronologicalFoldBounds } from "@workspace/domain/backtest/research";
import { z } from "zod/v4";
import { ATI_DERIV_ARCHIVE_GRADE_VERSION, ATI_MT5_GRADE_VERSION, ATI_RETEST_GRADE_VERSION, ATI_SHADOW_GRADE_VERSION,
  ATI_SHADOW_HOLD_WINDOW_MS as holdMs, atiComparisonPerformance, atiShadowDefinition, isAtiEntryDecision,
  summarizeAtiComparison } from "./atiShadowGrading.js";
import { ATI_RETEST_CHALLENGER, ATI_RETEST_WAIT_MS, atiChallengerVersion, atiCounterargumentEvidence, atiCounterargumentPolicy, atiRetestPlan,
  counterargumentOutcome, isAtiCounterargumentChallenger } from "./atiCounterargument.js";
import { ATI_GUARDIAN_GRADE_VERSION, atiGuardianGrade, guardianComparisonPolicy, type AtiGuardianGrade } from "./atiGuardian.js";
import { atiRetestComparison, type AtiRetestComparison, type AtiRetestLeg } from "./atiRetestGrading.js";
import { ATI_REGIME_INSTRUMENT_CHALLENGER, atiInstrumentProfile, atiObservedRegime, atiRegimeAssessment, atiRegimeOutcome,
  atiRegimePolicy, boundAtiRegimeAssessment, scoreAtiRegimeTransitions, summarizeAtiRegimeTransitions,
  type AtiInstrumentProfile, type AtiRegimeTransitions } from "./atiRegimeInstrument.js";

import { ATI_FLEET_BASELINE, ATI_FLEET_SYMBOL, cleanFleetVersion } from "./atiFleetDefinition.js";

export const ATI_RESEARCH_VERSION = "ati-paired-shadow-study-v1";
export const ATI_WALK_FORWARD_VERSION = "ati-paired-shadow-walk-forward-v2";
const { barMs } = atiShadowDefinition;
const monteCarlo = Object.freeze({ minimumTrades: 10, simulations: 128, seed: 0x415449,
  slippageJitterR: 0.05, spreadJitterR: 0.03, latencyDelayJitter01: 0.02 });
const boundary = z.number().int().positive().multipleOf(barMs);
const market = z.discriminatedUnion("source", [
  z.object({ source: z.literal("deriv_public"), mode: z.null() }).strict(),
  z.object({ source: z.literal("mt5_broker"), mode: z.enum(["DEMO", "LIVE"]) }).strict(),
]);
const assumedCosts = z.object({
  adverseSlippagePerFillPriceUnits: z.number().nonnegative(),
  feePerFillPriceUnits: z.number().nonnegative(),
}).strict();

export const atiResearchInput = z.object({
  requestId: z.uuid().transform((id) => id.toLowerCase()),
  symbol: z.string().trim().min(1).max(40),
  setup: z.enum(["TREND_CONTINUATION", "BREAKOUT_RETEST", "REVERSAL", "LIQUIDITY_SWEEP", "RANGE_FADE"]),
  hypothesis: z.string().trim().min(10).max(1000),
  replicates: z.object({
    runId: z.uuid().transform(id => id.toLowerCase()), datasetHash: z.hash("sha256"), resultHash: z.hash("sha256"),
  }).strict().optional(),
  market,
  startsAtMs: boundary,
  developmentEndsAtMs: boundary,
  validationEndsAtMs: boundary,
  holdoutEndsAtMs: boundary,
  baselineVersion: z.enum([atiShadowDefinition.baselineVersion, ATI_FLEET_BASELINE]).optional(),
  challengerVersion: atiChallengerVersion.optional(),
  walkForward: z.object({
    folds: z.number().int().min(2).max(12),
    embargoBars: z.number().int().nonnegative(),
    minPassingFolds: z.number().int().positive(),
  }).strict().optional(),
  costs: z.discriminatedUnion("basis", [
    z.object({ basis: z.literal("ASSUMED"), assumptions: assumedCosts }).strict(),
    z.object({ basis: z.literal("MEASURED_SLIPPAGE_COMMISSION_FEE") }).strict(),
  ]),
  criteria: z.object({
    minCaptureFraction: z.number().gt(0).lte(1),
    minSettledFraction: z.number().gt(0).lte(1),
    minSettledPairs: z.number().int().positive(),
    minChangedPairs: z.number().int().positive(),
    minMeanImprovementR: z.number().gt(0),
    maxDrawdownIncreaseR: z.number().nonnegative(),
    extraStressCostRPerRoundTrip: z.number().gt(0),
  }).strict(),
}).strict().refine((spec) => {
  const boundaries = [spec.startsAtMs, spec.developmentEndsAtMs, spec.validationEndsAtMs, spec.holdoutEndsAtMs];
  const walk = spec.walkForward;
  const validationBars = (spec.validationEndsAtMs - spec.developmentEndsAtMs) / barMs;
  return spec.holdoutEndsAtMs - spec.startsAtMs <= 30 * 24 * holdMs &&
    boundaries.slice(1).every((end, i) => end - boundaries[i]! > holdMs) &&
    (!walk || (walk.minPassingFolds <= walk.folds && Math.floor(validationBars / walk.folds) * barMs > holdMs &&
      spec.startsAtMs < spec.developmentEndsAtMs - holdMs - walk.embargoBars * barMs)) &&
    (spec.market.source === "mt5_broker" || spec.costs.basis === "ASSUMED");
}, "Use ordered M5 boundaries and leave room for the one-hour label horizon in each phase.")
  .refine(spec => spec.baselineVersion !== ATI_FLEET_BASELINE ||
    (spec.symbol === ATI_FLEET_SYMBOL && spec.market.source === "deriv_public" &&
      (spec.challengerVersion ?? atiShadowDefinition.challengerVersion) === atiShadowDefinition.challengerVersion),
  "Fleet research supports the V75 public feed and the timeframe-conflict challenger.");

export type AtiResearchInput = z.infer<typeof atiResearchInput>;
const buildIdentity = z.object({ revision: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  sourceState: z.enum(["clean", "modified", "unknown"]) }).strict();
type BuildIdentity = z.infer<typeof buildIdentity>;

export function researchPhases(spec: AtiResearchInput) {
  return [
    { name: "DEVELOPMENT", startMs: spec.startsAtMs, endMs: spec.developmentEndsAtMs },
    { name: "VALIDATION", startMs: spec.developmentEndsAtMs, endMs: spec.validationEndsAtMs },
    { name: "FINAL_HOLDOUT", startMs: spec.validationEndsAtMs, endMs: spec.holdoutEndsAtMs },
  ] as const;
}

export function researchRegistration(runId: string, ownerId: number, agentId: number, registeredAtMs: number, spec: AtiResearchInput,
  build: BuildIdentity, frozenInstrument?: AtiInstrumentProfile) {
  const walk = spec.walkForward;
  const folds = walk ? chronologicalFoldBounds(spec.developmentEndsAtMs / barMs, spec.validationEndsAtMs / barMs,
    walk.folds, holdMs / barMs, walk.embargoBars).map(({ trainEnd, testStart, testEnd }) => ({
      priorDecisionEndMs: trainEnd * barMs, priorLabelCutoffMs: (testStart - walk.embargoBars) * barMs,
      testStartMs: testStart * barMs, testEndMs: testEnd * barMs,
    })) : null;
  return {
    runId, ownerId, agentId, registeredAtMs, spec, build: buildIdentity.parse(build),
    runnerVersion: walk ? ATI_WALK_FORWARD_VERSION : ATI_RESEARCH_VERSION,
    definition: { ...atiShadowDefinition, baselineVersion: spec.baselineVersion ?? atiShadowDefinition.baselineVersion,
      challengerVersion: spec.challengerVersion ?? atiShadowDefinition.challengerVersion },
    holdWindowMs: holdMs, gradeCutoffMs: spec.holdoutEndsAtMs + holdMs, monteCarlo,
    executionAuthority: "NONE" as const,
    ...(folds ? { folds } : {}),
    ...(spec.challengerVersion === guardianComparisonPolicy.version ? { guardianPolicy: guardianComparisonPolicy } : {}),
    ...(isAtiCounterargumentChallenger(spec.challengerVersion) ? { counterargumentPolicy: atiCounterargumentPolicy } : {}),
    ...(spec.challengerVersion === ATI_RETEST_CHALLENGER ? { retestPolicy: { maximumWaitMs: ATI_RETEST_WAIT_MS,
      pnlRiskBasis: "FROZEN_PLANNED_STOP_DISTANCE" as const } } : {}),
    ...(spec.challengerVersion === ATI_REGIME_INSTRUMENT_CHALLENGER ? { regimePolicy: atiRegimePolicy,
      instrumentProfile: frozenInstrument === undefined ? atiInstrumentProfile(spec.symbol) : frozenInstrument } : {}),
  };
}

export function canonicalResearch(value: unknown) {
  const canonical = stableStringify(value);
  return { canonical, hash: createHash("sha256").update(canonical).digest("hex") };
}

/** Freeze the experiment's comparison rules independently of the calendar dates. */
export function atiReplicationPolicy(registration: ReturnType<typeof researchRegistration>) {
  const { spec } = registration;
  return canonicalResearch({
    ownerId: registration.ownerId, agentId: registration.agentId, definition: registration.definition,
    hypothesis: spec.hypothesis, market: spec.market, symbol: spec.symbol, setup: spec.setup,
    costs: spec.costs, criteria: spec.criteria, walkForward: spec.walkForward ?? null,
    phaseDurations: researchPhases(spec).map(p => p.endMs - p.startMs),
    runnerVersion: registration.runnerVersion, holdWindowMs: registration.holdWindowMs, monteCarlo: registration.monteCarlo,
    guardianPolicy: registration.guardianPolicy ?? null, regimePolicy: registration.regimePolicy ?? null,
    instrumentProfile: registration.instrumentProfile ?? null, counterargumentPolicy: registration.counterargumentPolicy ?? null,
    retestPolicy: registration.retestPolicy ?? null,
  }).hash;
}

const pair = z.object({ baselineR: z.number(), challengerR: z.number() }).strict();
const replayProof = z.object({ inputHash: z.hash("sha256"), gradeHash: z.hash("sha256") }).strict();
const fill = z.object({
  exitObservedAt: z.number().int().positive(),
  baselineSizeRatio: z.number().positive(),
  challengerSizeRatio: z.number().nonnegative(),
  quoteSidePnl: pair,
  pnlWithAssumedCosts: pair.nullable(),
  pnlWithMeasuredCosts: pair.nullable(),
  quoteSource: z.enum(["deriv_public", "mt5_broker"]),
  mt5Mode: z.enum(["LIVE", "DEMO"]).nullable(),
  entry: z.number().positive(),
  exit: z.number().positive(),
  exitReason: z.enum(["STOP", "TARGET"]),
  riskPriceUnits: z.number().positive(),
  pnlRiskBasis: z.literal("FROZEN_PLANNED_STOP_DISTANCE").optional(),
}).strict();

export const fleetResearchReceipt = z.object({
  decisionId: z.number().int().positive(), cycleId: z.string().min(1), cycleStartedAt: z.number().int().positive(),
  version: cleanFleetVersion,
}).strict();

const dataRow = z.object({
  fleetDecision: fleetResearchReceipt.nullable().optional(),
  observationKey: z.string(),
  observedAtMs: z.number().int().positive(),
  recordedAtMs: z.number().int().positive().nullable(),
  sourceIdentity: z.string().nullable(),
  coverage: z.string(),
  setup: z.string(),
  baseline: z.string(),
  challenger: z.string(),
  captureBuild: buildIdentity.nullable(),
  decisionSettingsHash: z.hash("sha256").nullable(),
  mt5ReplayProof: replayProof.optional(),
  derivReplayProof: replayProof.optional(),
  counterargument: atiCounterargumentEvidence.omit({ history: true }).extend({ evidenceHash: z.hash("sha256") }).strict().optional(),
  retestPlan: atiRetestPlan.optional(),
  regimeAssessment: atiRegimeAssessment.optional(),
  evidence: z.object({
    evaluatedAtMs: z.number().int().positive(),
    recordedAtMs: z.number().int().positive(),
    version: z.string(),
    fill: fill.nullable(),
    retest: atiRetestComparison.optional(),
    guardian: atiGuardianGrade.optional(),
    unresolvedReason: z.string().nullable(),
    build: buildIdentity.nullable(),
  }).strict().nullable(),
}).strict();

export const atiResearchDataset = z.object({
  registrationHash: z.hash("sha256"),
  sourceIdentity: z.string().nullable(),
  decisionSettingsHash: z.hash("sha256").nullable(),
  measuredCostProfileHash: z.hash("sha256").nullable(),
  observations: z.array(dataRow),
}).strict();

export type AtiResearchDataset = z.infer<typeof atiResearchDataset>;

type Phase = ReturnType<typeof researchPhases>[number];
type Registration = ReturnType<typeof researchRegistration>;
type FoldWindow = { name: "PRIOR_CONTEXT" | "WALK_FORWARD_TEST"; startMs: number; endMs: number };

function evaluatePhase(registration: Registration, dataset: AtiResearchDataset, phase: Phase | FoldWindow, simulateTail = true,
  developmentTransitions?: AtiRegimeTransitions, replayKeys?: Set<string>) {
  const { spec, build } = registration;
  const { criteria } = spec;
  const lastDecisionMs = phase.endMs - holdMs;
  const labelCutoffMs = phase.name === "FINAL_HOLDOUT" ? phase.endMs + holdMs : phase.endMs;
  const primary = spec.costs.basis === "ASSUMED" ? "pnlWithAssumedCosts" : "pnlWithMeasuredCosts";
  const gradeVersions = spec.market.source === "deriv_public" ? [ATI_SHADOW_GRADE_VERSION, ATI_DERIV_ARCHIVE_GRADE_VERSION] : [ATI_MT5_GRADE_VERSION];
  const rows = dataset.observations.filter((row) => row.observedAtMs >= phase.startMs && row.observedAtMs < phase.endMs);
  const available = rows.filter((row) => row.observedAtMs < lastDecisionMs && row.recordedAtMs != null &&
    registration.registeredAtMs < row.observedAtMs && row.observedAtMs <= row.recordedAtMs && row.recordedAtMs < lastDecisionMs);
  const observed = available.filter((row) => row.coverage === "OBSERVED" && row.sourceIdentity === dataset.sourceIdentity &&
    dataset.sourceIdentity != null);
  const expectedSlots = (lastDecisionMs - phase.startMs) / barMs;
  const observedSlots = new Set(observed.map((row) => Math.floor(row.observedAtMs / barMs))).size;
  const eligible = observed.filter((row) => row.setup === spec.setup && isAtiEntryDecision(row.baseline));
  const usesGuardian = spec.challengerVersion === guardianComparisonPolicy.version;
  const guardians: AtiGuardianGrade[] = [];
  let invalidGuardian = 0;
  const usesRetest = spec.challengerVersion === ATI_RETEST_CHALLENGER;
  const usesRegime = spec.challengerVersion === ATI_REGIME_INSTRUMENT_CHALLENGER;
  const regimeBound = (row: (typeof observed)[number]) => boundAtiRegimeAssessment(row.regimeAssessment, {
    observedAtMs: row.observedAtMs, observationKey: row.observationKey, instrument: registration.instrumentProfile ?? null,
  });

  let unresolved = 0, unavailableLabels = 0, missingCosts = 0, changedPairs = 0;
  const retests: AtiRetestComparison[] = [];
  const trustedRegimeFills = new Map<string, z.infer<typeof fill>>();
  const legReturn = primary === "pnlWithAssumedCosts" ? "assumedR" : "measuredR";
  const settled = eligible.flatMap((row) => {
    if (spec.baselineVersion === ATI_FLEET_BASELINE && !row.fleetDecision) {
      unresolved++;
      return [];
    }
    const evidence = row.evidence;
    if (!evidence || evidence.recordedAtMs >= labelCutoffMs || evidence.recordedAtMs < row.recordedAtMs! ||
        evidence.evaluatedAtMs <= row.observedAtMs || evidence.evaluatedAtMs > evidence.recordedAtMs) {
      unavailableLabels++;
      return [];
    }
    if (usesGuardian || evidence.guardian) {
      const grade = evidence.guardian;
      const proof = spec.market.source === "deriv_public" ? row.derivReplayProof : row.mt5ReplayProof;
      const end = Math.min(evidence.evaluatedAtMs, row.observedAtMs + holdMs);
      const inWindow = (at: number) => at > row.observedAtMs && at <= end;
      if (!grade || !usesGuardian || grade.quoteSource !== spec.market.source || grade.mt5Mode !== spec.market.mode ||
          evidence.version !== ATI_GUARDIAN_GRADE_VERSION || evidence.fill || evidence.retest ||
          row.baseline !== row.challenger || grade.sizeRatio !== (row.baseline === "APPROVED_REDUCED" ? 0.5 : 1) ||
          (proof && canonicalResearch(grade).hash !== proof.gradeHash) ||
          (!grade.entry && (grade.samples !== 0 || grade.sampleHash !== null || grade.archivePrefixHash !== null)) ||
          (grade.entry && (!proof || !grade.sampleHash || !grade.archivePrefixHash || grade.samples < 1 || !inWindow(grade.entry.at))) ||
          [grade.baseline.exit, grade.challenger.exit].some((exit) => exit && (!grade.entry || !inWindow(exit.at) || exit.at < grade.entry.at)) ||
          ((grade.status === "SETTLED_PAIR") !== !!(grade.baseline.exit && grade.challenger.exit)) ||
          (grade.pairedDeltaR !== (grade.baseline.exit && grade.challenger.exit
            ? grade.challenger.exit.quoteSideR - grade.baseline.exit.quoteSideR : null)) ||
          ((grade.status === "NO_FILL") !== !!grade.noFill) ||
          (grade.noFill && (!proof || grade.entry || !inWindow(grade.noFill.atMs)))) {
        invalidGuardian++;
        unresolved++;
        return [];
      }
      if (grade.noFill || grade.baseline.exit || grade.challenger.exit) replayKeys?.add(row.observationKey);
      guardians.push(grade);
      if (grade.status === "UNRESOLVED") unresolved++;
      if (grade.status === "SETTLED_PAIR") {
        const baseline = grade.baseline.exit!, challenger = grade.challenger.exit!;
        const costKey = spec.costs.basis === "ASSUMED" ? "assumedNetR" : "measuredNetR";
        if (baseline[costKey] == null || challenger[costKey] == null) missingCosts++;
        else if (baseline.at !== challenger.at || baseline.price !== challenger.price) changedPairs++;
      }
      return [];
    }
    if (usesRegime && (!regimeBound(row) || atiRegimeOutcome(row.baseline, row.regimeAssessment ?? null) !== row.challenger)) {
      unresolved++;
      return [];
    }
    if (evidence.retest) {
      const retest = evidence.retest;
      const plan = row.retestPlan;
      const end = Math.min(row.observedAtMs + holdMs, evidence.evaluatedAtMs);
      const inWindow = (at: number) => at > row.observedAtMs && at <= end;
      const validLeg = (leg: AtiRetestLeg) => leg.state === "SIMULATED_FILL"
        ? inWindow(leg.entryAtMs) && inWindow(leg.exitAtMs) && leg.exitAtMs >= leg.entryAtMs &&
          leg.entryDelayMs === leg.entryAtMs - row.observedAtMs
        : leg.state === "NO_FILL" ? inWindow(leg.atMs) : !leg.observedEntry || inWindow(leg.observedEntry.atMs);
      const challenger = retest.challenger;
      const baseline = retest.baseline;
      if (!usesRetest || !plan || evidence.version !== ATI_RETEST_GRADE_VERSION || evidence.fill ||
          retest.quoteSource !== spec.market.source || retest.mt5Mode !== spec.market.mode ||
          row.challenger !== "WAIT" || plan.expiresAtMs <= row.observedAtMs || plan.expiresAtMs > row.observedAtMs + ATI_RETEST_WAIT_MS ||
          !validLeg(retest.baseline) || !validLeg(challenger) ||
          (challenger.state === "SIMULATED_FILL" && (challenger.entryAtMs >= plan.expiresAtMs ||
            challenger.entry < plan.band.from || challenger.entry > plan.band.to || challenger.sizeRatio !== plan.sizeRatio)) ||
          (challenger.state === "NO_FILL" && (challenger.reason === "FIRST_QUOTE_NOT_EXECUTABLE" ||
            (challenger.atMs >= plan.expiresAtMs) !== (challenger.reason === "ENTRY_WINDOW_EXPIRED")))) {
        unresolved++;
        return [];
      }
      if (baseline.state !== "UNRESOLVED" || challenger.state !== "UNRESOLVED") replayKeys?.add(row.observationKey);
      retests.push(retest);
      if (baseline.state === "UNRESOLVED" || challenger.state === "UNRESOLVED") unresolved++;
      else if ([baseline, challenger].some((leg) => leg.state === "SIMULATED_FILL" && leg.returns[legReturn] == null)) missingCosts++;
      else if (baseline.state !== challenger.state || (baseline.state === "SIMULATED_FILL" && challenger.state === "SIMULATED_FILL" &&
        (baseline.entryAtMs !== challenger.entryAtMs || baseline.entry !== challenger.entry || baseline.sizeRatio !== challenger.sizeRatio ||
          baseline.exitAtMs !== challenger.exitAtMs || baseline.exit !== challenger.exit))) changedPairs++;
      return [];
    }
    const fill = evidence.fill;
    if (row.retestPlan || !fill || (fill.pnlRiskBasis != null) !== usesRetest ||
        !gradeVersions.includes(evidence.version) || fill.quoteSource !== spec.market.source || fill.mt5Mode !== spec.market.mode ||
        fill.exitObservedAt <= row.observedAtMs || fill.exitObservedAt > row.observedAtMs + holdMs ||
        fill.exitObservedAt > evidence.evaluatedAtMs) {
      unresolved++;
      return [];
    }
    if (!fill[primary]) {
      missingCosts++;
      return [];
    }
    if (fill.baselineSizeRatio !== fill.challengerSizeRatio) changedPairs++;
    if (usesRegime) trustedRegimeFills.set(row.observationKey, fill);
    replayKeys?.add(row.observationKey);
    return [fill];
  });

  const performance = atiComparisonPerformance(settled, retests, primary, guardians);
  const base = summarizeAtiComparison(performance);
  const stress = summarizeAtiComparison(performance, criteria.extraStressCostRPerRoundTrip);
  const pairedRisk = usesRetest || usesGuardian ? summarizeAtiComparison(performance.filter(({ baseline, challenger }) =>
    baseline.riskMultiple != null && challenger.riskMultiple != null)) : base;
  const regimeReport = usesRegime ? (() => {
    const classified = observed.filter(regimeBound);
    const assessments = classified.map((row) => row.regimeAssessment!);
    return {
      instrument: registration.instrumentProfile ?? null, unattestedBars: observed.length - classified.length,
      transitions: summarizeAtiRegimeTransitions(assessments, barMs),
      ...(developmentTransitions ? { transitionValidation: scoreAtiRegimeTransitions(developmentTransitions, assessments, barMs) } : {}),
      cohorts: atiObservedRegime.options.map((regime) => {
        const cohort = classified.filter((row) => row.regimeAssessment?.regime === regime);
        const candidates = cohort.filter((row) => row.setup === spec.setup && isAtiEntryDecision(row.baseline));
        const fills = candidates.flatMap((row) => {
          const grade = trustedRegimeFills.get(row.observationKey);
          return grade ? [grade] : [];
        });
        const metrics = summarizeAtiComparison(atiComparisonPerformance(fills, [], primary));
        return { regime, observedBars: cohort.length, eligible: candidates.length, metrics,
          measured: metrics.settledPairs >= criteria.minSettledPairs && metrics.challenger.settledTrades > 0 };
      }),
    };
  })() : null;

  const meanDeltaR = base.pairedDifferenceR == null ? null : base.pairedDifferenceR / base.settledPairs;
  const stressedMeanDeltaR = stress.pairedDifferenceR == null ? null : stress.pairedDifferenceR / stress.settledPairs;
  const drawdownIncreaseR = pairedRisk.baseline.closedEquityDrawdownR == null || pairedRisk.challenger.closedEquityDrawdownR == null ? null
    : pairedRisk.challenger.closedEquityDrawdownR - pairedRisk.baseline.closedEquityDrawdownR;
  function simulatedTail(variant: "baseline" | "challenger") {
    if (!simulateTail) return null;
    const trades = performance.flatMap((row) => row[variant].sizeRatio > 0 && row[variant].riskMultiple != null
      ? [row[variant].riskMultiple] : []);
    if (trades.length < registration.monteCarlo.minimumTrades) return null;
    const { p05FinalR, p95FinalR, worstDrawdownR } = runMonteCarloValidation({ tradeRs: trades, ...registration.monteCarlo });
    return { p05FinalR, p95FinalR, worstDrawdownR };
  }
  const evidenceGaps = [
    ...(spec.baselineVersion === ATI_FLEET_BASELINE && observed.some(row => !row.fleetDecision)
      ? ["FLEET_DECISION_UNVERIFIED"] : []),
    ...(invalidGuardian ? ["GUARDIAN_RECEIPT_UNAVAILABLE_OR_CONFLICTING"] : []),
    ...(usesRegime && eligible.some((row) => !regimeBound(row) ||
      atiRegimeOutcome(row.baseline, row.regimeAssessment ?? null) !== row.challenger)
      ? ["REGIME_RECEIPT_UNAVAILABLE_OR_CONFLICTING"] : []),
    ...(usesRegime && !regimeReport?.cohorts.some((cohort) => cohort.measured) ? ["INSUFFICIENT_PAIRS_IN_SUPPORTED_REGIMES"] : []),
    ...(isAtiCounterargumentChallenger(spec.challengerVersion) &&
      eligible.some((row) => row.counterargument?.decidedAtMs !== row.observedAtMs ||
        counterargumentOutcome(row.baseline, row.counterargument.decision) !== row.challenger)
      ? ["COUNTERARGUMENT_RECEIPT_UNAVAILABLE_OR_CONFLICTING"] : []),
    ...(spec.costs.basis === "MEASURED_SLIPPAGE_COMMISSION_FEE" && !dataset.measuredCostProfileHash ? ["MEASURED_COST_PROFILE_UNAVAILABLE"] : []),
    ...(observedSlots / expectedSlots < criteria.minCaptureFraction ? ["CAPTURE_COVERAGE_BELOW_MINIMUM"] : []),
    ...(base.settledPairs < criteria.minSettledPairs ? ["TOO_FEW_SETTLED_PAIRS"] : []),
    ...(changedPairs < criteria.minChangedPairs ? ["TOO_FEW_CHANGED_PAIRS"] : []),
    ...(!eligible.length || base.settledPairs / eligible.length < criteria.minSettledFraction ? ["SETTLEMENT_COVERAGE_BELOW_MINIMUM"] : []),
    ...(drawdownIncreaseR == null ? ["CHALLENGER_OR_BASELINE_DRAWDOWN_UNAVAILABLE"] : []),
  ];
  const rejectionReasons = [
    ...(meanDeltaR != null && meanDeltaR < criteria.minMeanImprovementR ? ["MEAN_IMPROVEMENT_BELOW_MINIMUM"] : []),
    ...(stressedMeanDeltaR != null && stressedMeanDeltaR <= 0 ? ["NO_POSITIVE_IMPROVEMENT_UNDER_COST_STRESS"] : []),
    ...(drawdownIncreaseR != null && drawdownIncreaseR > criteria.maxDrawdownIncreaseR ? ["DRAWDOWN_INCREASE_ABOVE_MAXIMUM"] : []),
  ];
  const sameBuild = (value: BuildIdentity | null) => build.revision != null && build.sourceState === "clean" &&
    value?.revision === build.revision && value.sourceState === "clean";
  if (!sameBuild(build) || observed.some((row) => !sameBuild(row.captureBuild) ||
      (row.evidence && row.evidence.recordedAtMs < labelCutoffMs && !sameBuild(row.evidence.build)))) {
    evidenceGaps.push("UNVERIFIED_OR_CHANGED_BUILD");
  }
  if (!dataset.decisionSettingsHash || observed.some((row) => row.decisionSettingsHash !== dataset.decisionSettingsHash)) {
    evidenceGaps.push("UNVERIFIED_OR_CHANGED_DECISION_SETTINGS");
  }
  return {
    ...phase, lastDecisionMs, labelCutoffMs, expectedSlots, observedSlots,
    captureBasis: "PREREGISTERED_M5_CALENDAR_SLOTS" as const,
    exclusions: { boundaryPurge: rows.filter((row) => row.observedAtMs >= lastDecisionMs).length,
      unverifiedOrLateCapture: rows.length - available.length - rows.filter((row) => row.observedAtMs >= lastDecisionMs).length,
      unavailableFeed: available.filter((row) => row.coverage === "NO_OBSERVED_FEED").length,
      changedSource: available.filter((row) => row.coverage === "SOURCE_CHANGED").length,
      unavailableLabels, unresolved, missingCosts },
    eligible: eligible.length, changedPairs, base, stress, meanDeltaR, stressedMeanDeltaR, drawdownIncreaseR,
    ...(usesGuardian ? { guardianCoverage: { eligible: eligible.length, awaitingGradeAtCutoff: unavailableLabels,
      settledPairs: guardians.filter((g) => g.status === "SETTLED_PAIR").length, noFill: guardians.filter((g) => g.status === "NO_FILL").length,
      unresolved, missingCosts, baselineAmendments: guardians.reduce((sum, g) => sum + g.baseline.amendments, 0),
      challengerAmendments: guardians.reduce((sum, g) => sum + g.challenger.amendments, 0) } } : {}),
    ...(regimeReport ? { regimeReport } : {}),
    ...(usesRetest ? { retestCoverage: { planned: eligible.filter((row) => row.retestPlan).length,
      graded: retests.length, fills: retests.filter((row) => row.challenger.state === "SIMULATED_FILL").length,
      noFills: retests.filter((row) => row.challenger.state === "NO_FILL").length,
      unresolved: retests.filter((row) => row.challenger.state === "UNRESOLVED").length } } : {}),
    simulatedTail: { basis: "TRADE_ORDER_SHUFFLE_WITH_ASSUMED_COST_AND_LATENCY_JITTER" as const,
      baseline: simulatedTail("baseline"), challenger: simulatedTail("challenger") },
    evidenceGaps, rejectionReasons,
  };
}

export function evaluateAtiResearch(registration: Registration, dataset: AtiResearchDataset, replayKeys?: Set<string>) {
  const { spec } = registration;
  const [developmentWindow, ...evaluationWindows] = researchPhases(spec);
  const development = evaluatePhase(registration, dataset, developmentWindow);
  const developmentTransitions = development.regimeReport?.transitions;
  const phases = [development, ...evaluationWindows.map((phase) => evaluatePhase(registration, dataset, phase, true, developmentTransitions, replayKeys))];
  const outOfSample = phases.filter((phase) => phase.name !== "DEVELOPMENT");
  const sufficientlyMeasured = outOfSample.every((phase) => !phase.evidenceGaps.length);
  const baseVerdict = !sufficientlyMeasured ? "INSUFFICIENT_EVIDENCE" as const
    : outOfSample.some((phase) => phase.rejectionReasons.length) ? "REJECTED" as const : "FORWARD_REVIEW_REQUIRED" as const;
  const base = {
    registrationHash: dataset.registrationHash,
    outcomeBasis: "SIMULATED_FILLS_ON_OBSERVED_VENUE_QUOTES" as const,
    costBasis: spec.costs.basis, phases, verdict: baseVerdict, executionAuthority: "NONE" as const,
  };
  if (!registration.folds || !spec.walkForward) return { ...base, runnerVersion: ATI_RESEARCH_VERSION } as const;
  const folds = registration.folds.map((fold, index) => {
    const prior = evaluatePhase(registration, dataset, {
      name: "PRIOR_CONTEXT", startMs: spec.startsAtMs, endMs: fold.priorLabelCutoffMs,
    }, false);
    const test = evaluatePhase(registration, dataset, {
      name: "WALK_FORWARD_TEST", startMs: fold.testStartMs, endMs: fold.testEndMs,
    }, false, developmentTransitions, replayKeys);
    return { fold: index + 1, ...fold, prior: { observedSlots: prior.observedSlots, settledPairs: prior.base.settledPairs,
      unavailableLabels: prior.exclusions.unavailableLabels }, test };
  });
  const measuredFolds = folds.filter(({ test }) => !test.evidenceGaps.length);
  const passingFolds = measuredFolds.filter(({ test }) => !test.rejectionReasons.length).length;
  const minPassingFolds = spec.walkForward.minPassingFolds;
  const verdict = !sufficientlyMeasured || measuredFolds.length !== folds.length ? "INSUFFICIENT_EVIDENCE" as const
    : baseVerdict === "REJECTED" || passingFolds < minPassingFolds ? "REJECTED" as const : "FORWARD_REVIEW_REQUIRED" as const;
  return { ...base, runnerVersion: ATI_WALK_FORWARD_VERSION, verdict, walkForward: { selection: "FIXED_PREREGISTERED_RULES",
    minPassingFolds, measuredFolds: measuredFolds.length, passingFolds, folds } } as const;
}
