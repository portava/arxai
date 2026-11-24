import { z } from "zod/v4";
import { stableStringify } from "@workspace/features/event-chain";
import { resolveArxMarket } from "@workspace/domain/market";
import type { DecisionCandidate, DecisionCandidateInput } from "@workspace/domain/self-trade";
import { resolveInstrument } from "../instruments/index.js";

export const ATI_REGIME_INSTRUMENT_CHALLENGER = "regime-instrument-v1";

export const atiObservedRegime = z.enum(["TRENDING", "BREAKOUT", "RANGING", "VOLATILE", "QUIET", "UNKNOWN"]);
type ObservedRegime = z.infer<typeof atiObservedRegime>;

export const atiRegimePolicy = Object.freeze({
  classification: "ELEANOR_CLOSED_BAR_REGIME",
  allowedSetups: Object.freeze({
    TRENDING: Object.freeze(["TREND_CONTINUATION"]),
    BREAKOUT: Object.freeze(["BREAKOUT_RETEST"]),
    RANGING: Object.freeze(["RANGE_FADE"]),
    VOLATILE: Object.freeze(["REVERSAL", "LIQUIDITY_SWEEP"]),
    QUIET: Object.freeze([]),
    UNKNOWN: Object.freeze([]),
  }),
  minimumTransitionsPerRegime: 20,
  sizeRatios: Object.freeze({ KEEP: 1, REDUCE: 0.5, WAIT: 0 }),
});

export const atiInstrumentProfileSchema = z.object({
  canonicalSymbol: z.string(),
  category: z.enum(["synthetic", "forex_major", "forex_minor", "metal", "index", "crypto"]),
  riskProfile: z.string(), sessionProfile: z.string(), profileKey: z.string().nullable(),
  preferredSessions: z.array(z.string()), supportsM5: z.boolean(),
}).strict().nullable();
export type AtiInstrumentProfile = z.infer<typeof atiInstrumentProfileSchema>;

export function atiInstrumentProfile(symbol: string): AtiInstrumentProfile {
  const focus = resolveArxMarket(symbol);
  if (!focus) return null;
  const { profile } = resolveInstrument(focus.canonicalSymbol);
  const { canonicalSymbol, category, riskProfile, sessionProfile } = focus;
  return {
    canonicalSymbol, category, riskProfile, sessionProfile,
    profileKey: profile?.key ?? null,
    preferredSessions: [...(profile?.tradingSessions ?? [])],
    supportsM5: focus.enabledForBacktest && focus.supportedTimeframes.includes("M5"),
  };
}

const action = z.enum(["KEEP", "REDUCE", "WAIT"]);
type Action = z.infer<typeof action>;

export const atiRegimeAssessment = z.object({
  assessedAtMs: z.number().int().positive(),
  closedBarAtMs: z.number().int().positive(),
  regime: atiObservedRegime,
  instrument: atiInstrumentProfileSchema,
  session: z.string().nullable(),
  action,
  reasons: z.array(z.string()),
  evidenceGaps: z.array(z.string()),
}).strict();
export type AtiRegimeAssessment = z.infer<typeof atiRegimeAssessment>;

const sessionNames: Record<string, readonly string[]> = {
  SYDNEY: ["Asia"], TOKYO: ["Asia"], LONDON: ["London"], NEW_YORK: ["New York"],
  LONDON_NY_OVERLAP: ["London/NY Overlap", "London", "New York"], OFF_HOURS: [],
};

export function assessAtiRegimeInstrument(
  baseline: DecisionCandidate, input: DecisionCandidateInput, assessedAtMs: number, instrument: AtiInstrumentProfile,
): AtiRegimeAssessment | null {
  const { signal } = input;
  const closedBarAtMs = Date.parse(signal.marketEvidence?.lastClosedCandleAt ?? "");
  if (!Number.isFinite(closedBarAtMs) || !(closedBarAtMs > 0) || closedBarAtMs > assessedAtMs) return null;
  const normalized = atiObservedRegime.safeParse(signal.regime);
  const regime = normalized.success ? normalized.data : "UNKNOWN";
  const session = signal.session?.session ?? null;
  const reasons: string[] = [];
  const evidenceGaps: string[] = [];
  let decision: Action = "KEEP";
  const restrict = (next: Action, reason: string) => {
    reasons.push(reason);
    if (atiRegimePolicy.sizeRatios[next] < atiRegimePolicy.sizeRatios[decision]) decision = next;
  };

  if (!instrument?.supportsM5) {
    restrict("WAIT", "INSTRUMENT_M5_PROFILE_UNAVAILABLE");
    evidenceGaps.push("INSTRUMENT_M5_PROFILE_UNAVAILABLE");
  }
  if (regime === "UNKNOWN") {
    restrict("WAIT", "REGIME_UNVERIFIED");
    evidenceGaps.push("REGIME_UNVERIFIED");
  } else if (regime === "QUIET") restrict("WAIT", "QUIET_REGIME");
  else if (!(atiRegimePolicy.allowedSetups[regime] as readonly string[]).includes(baseline.setup)) {
    restrict("WAIT", "SETUP_OUTSIDE_REGIME");
  }

  const early = signal.earlyTrend;
  if (early?.blind !== false || !baseline.side) {
    restrict("WAIT", "STRUCTURE_UNVERIFIED");
    evidenceGaps.push("STRUCTURE_UNVERIFIED");
  } else {
    const bullish = baseline.side === "BUY";
    const alignedBreak = early.bosChoch === (bullish ? "BOS_UP" : "BOS_DOWN");
    const alignedReversal = early.bosChoch === (bullish ? "CHOCH_UP" : "CHOCH_DOWN");
    if (baseline.setup === "TREND_CONTINUATION" && early.structure !== (bullish ? "HH_HL" : "LH_LL"))
      restrict("WAIT", "DIRECTIONAL_TREND_UNCONFIRMED");
    if (baseline.setup === "BREAKOUT_RETEST" && (!alignedBreak || signal.lifecycleStage !== "ENTRY_WINDOW_OPEN"))
      restrict("WAIT", "BREAKOUT_RETEST_UNCONFIRMED");
    if (baseline.setup === "REVERSAL" && !alignedReversal) restrict("WAIT", "REVERSAL_UNCONFIRMED");
    if (baseline.setup === "LIQUIDITY_SWEEP" && (!early.rejectionDetected || (!alignedBreak && !alignedReversal)))
      restrict("WAIT", "SWEEP_CONFIRMATION_REQUIRED");
    if (baseline.setup === "RANGE_FADE" && early.structure !== "RANGE")
      restrict("WAIT", "RANGE_STRUCTURE_UNCONFIRMED");
    if (early.pressure === "FADING" || early.momentum === "COMPRESSING") restrict("REDUCE", "WEAK_MOMENTUM");
    if (early.momentum !== "EXPANDING" && early.momentum !== "STEADY" && early.momentum !== "COMPRESSING") {
      evidenceGaps.push("MOMENTUM_UNVERIFIED");
      restrict("REDUCE", "MOMENTUM_UNVERIFIED");
    }
  }
  if (regime === "VOLATILE") restrict("REDUCE", "VOLATILE_REGIME");

  if (instrument?.category === "synthetic") {
    const symbol = instrument.canonicalSymbol;
    if (symbol.startsWith("BOOM") || symbol.startsWith("CRASH")) {
      restrict("WAIT", "SPIKE_RISK_MODEL_UNVALIDATED");
      evidenceGaps.push("SPIKE_RISK_MODEL_UNVALIDATED");
    }
    if (symbol === "V75_1S") restrict("REDUCE", "V75_1S_EXPOSURE_CAP");
    if (symbol === "V75" && (regime === "RANGING" || regime === "BREAKOUT"))
      restrict("REDUCE", "V75_NON_TREND_EXPOSURE_CAP");
    if (symbol === "V25_1S" && early?.momentum !== "EXPANDING") restrict("WAIT", "V25_1S_MOMENTUM_UNCONFIRMED");
  } else if (instrument?.category === "crypto") {
    if (regime === "BREAKOUT") restrict("REDUCE", "CRYPTO_BREAKOUT_EXPOSURE_CAP");
  } else if (instrument?.category === "forex_major" || instrument?.category === "forex_minor" ||
      instrument?.category === "metal" || instrument?.category === "index") {
    const names = session == null ? undefined : sessionNames[session];
    if (!names) {
      restrict("WAIT", "SESSION_UNVERIFIED");
      evidenceGaps.push("SESSION_UNVERIFIED");
    } else if (session === "OFF_HOURS") restrict("WAIT", "SESSION_OFF_HOURS");
    else if (!instrument.preferredSessions.length) evidenceGaps.push("INSTRUMENT_SESSION_PREFERENCE_UNAVAILABLE");
    else if (!instrument.preferredSessions.some((name) => name === "24/7" || names.includes(name)))
      restrict("REDUCE", "OUTSIDE_PREFERRED_INSTRUMENT_SESSION");
    if (!signal.scores?.unmeasured || signal.scores.unmeasured.includes("newsSafety")) evidenceGaps.push("MACRO_RISK_UNMEASURED");
    else if (input.newsRisk === "critical") restrict("WAIT", "CRITICAL_MACRO_RISK");
    else if (input.newsRisk === "high") restrict("REDUCE", "ELEVATED_MACRO_RISK");
    if (instrument.category === "metal" && regime === "VOLATILE") restrict("WAIT", "METAL_VOLATILITY_PAUSE");
  }
  return { assessedAtMs, closedBarAtMs, regime, instrument, session, action: decision, reasons, evidenceGaps };
}

export function atiRegimeOutcome(baseline: string, assessment: AtiRegimeAssessment | null) {
  if (baseline !== "APPROVED" && baseline !== "APPROVED_REDUCED") return baseline;
  if (!assessment || assessment.action === "WAIT") return "WAIT";
  return assessment.action === "REDUCE" ? "APPROVED_REDUCED" : baseline;
}

export function boundAtiRegimeAssessment(assessment: AtiRegimeAssessment | null | undefined,
  scope: { observedAtMs: number; observationKey: string; instrument: AtiInstrumentProfile }) {
  return !!assessment && assessment.assessedAtMs === scope.observedAtMs &&
    assessment.closedBarAtMs <= scope.observedAtMs && scope.observationKey === `bar:${assessment.closedBarAtMs}` &&
    stableStringify(assessment.instrument) === stableStringify(scope.instrument);
}

function adjacentRegimes(assessments: AtiRegimeAssessment[], barMs: number) {
  const chronological = [...assessments].sort((a, b) => a.closedBarAtMs - b.closedBarAtMs);
  const pairs: Array<{ from: ObservedRegime; to: ObservedRegime }> = [];
  for (let i = 1; i < chronological.length; i++) {
    const before = chronological[i - 1]!;
    const after = chronological[i]!;
    if (before.regime === "UNKNOWN" || after.regime === "UNKNOWN" || after.closedBarAtMs - before.closedBarAtMs !== barMs) continue;
    pairs.push({ from: before.regime, to: after.regime });
  }
  return pairs;
}

const knownRegimes = atiObservedRegime.options.filter((regime) => regime !== "UNKNOWN");

export function summarizeAtiRegimeTransitions(assessments: AtiRegimeAssessment[], barMs: number) {
  const counts = new Map<ObservedRegime, Map<ObservedRegime, number>>();
  for (const { from, to } of adjacentRegimes(assessments, barMs)) {
    const row = counts.get(from) ?? new Map<ObservedRegime, number>();
    row.set(to, (row.get(to) ?? 0) + 1);
    counts.set(from, row);
  }
  return {
    basis: "EMPIRICAL_ADJACENT_OBSERVED_CLOSED_BARS" as const,
    minimumSample: atiRegimePolicy.minimumTransitionsPerRegime,
    byFromRegime: knownRegimes.map((from) => {
      const row = counts.get(from);
      const sample = row ? [...row.values()].reduce((acc, n) => acc + n, 0) : 0;
      return { from, sample, to: knownRegimes.map((to) => {
        const count = row?.get(to) ?? 0;
        return { regime: to, count, probability: sample >= atiRegimePolicy.minimumTransitionsPerRegime ? count / sample : null };
      }) };
    }),
  };
}

export type AtiRegimeTransitions = ReturnType<typeof summarizeAtiRegimeTransitions>;

export function scoreAtiRegimeTransitions(development: AtiRegimeTransitions, assessment: AtiRegimeAssessment[], barMs: number) {
  const test = adjacentRegimes(assessment, barMs);
  const priors = new Map(development.byFromRegime.map((row) => [row.from, row]));
  let scored = 0, squaredError = 0, persistenceError = 0;
  for (const { from, to } of test) {
    if (from === "UNKNOWN") continue;
    const prior = priors.get(from);
    if (!prior || prior.sample < development.minimumSample || prior.to.some((state) => state.probability == null)) continue;
    scored++;
    squaredError += prior.to.reduce((sum, state) => sum + (state.probability! - Number(state.regime === to)) ** 2, 0);
    if (from !== to) persistenceError += 2;
  }
  return {
    basis: "DEVELOPMENT_ONLY_ADJACENT_BAR_FREQUENCIES" as const,
    eligibleTransitions: test.length, scoredTransitions: scored,
    modelBrier: scored ? squaredError / scored : null,
    persistenceBrier: scored ? persistenceError / scored : null,
  };
}
