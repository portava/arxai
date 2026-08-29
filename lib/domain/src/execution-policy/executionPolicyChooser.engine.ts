// Capability #27 — the execution policy chooser (pure, SHADOW-ONLY).
//
// Chooses between the two certified execution shapes — IMMEDIATE_MARKET and
// GUIDED_STAGED — conditioned on spread state, urgency class, size vs recent
// volume, and the fill-quality evidence store. Deterministic: identical input
// always yields the identical recommendation, so every journaled
// recommendation is replayable from its own evidence echo.
//
// The rules are deliberately legible (a scored vote, thresholds named as
// constants) rather than learned: a shadow recommender earns trust by being
// auditable first. Data-starved inputs degrade to the CURRENT default shape
// with confidence 0 — the chooser never manufactures a preference it has no
// evidence for, and it NEVER touches the actual order path.

import type {
  ExecutionPolicyInput, ExecutionPolicyRecommendation, ExecutionShape,
  FillQualityEvidence, FillQualityStats,
} from "./executionPolicy.types";

// ── Named thresholds (auditable, test-pinned) ───────────────────────────────
/** currentSpread / typicalSpread at/above which the spread is WIDE. */
export const WIDE_SPREAD_RATIO = 1.5;
/** ...and at/above which it is at least ELEVATED. */
export const ELEVATED_SPREAD_RATIO = 1.2;
/** orderSize / recentVolume at/above which the order is LARGE for the tape. */
export const LARGE_SIZE_FRACTION = 0.25;
/** ...and at/above which it is at least NOTABLE. */
export const NOTABLE_SIZE_FRACTION = 0.1;
/** Minimum per-shape sample before fill-quality evidence may tilt the vote. */
export const MIN_FILL_SAMPLE = 5;

function fillStatsFor(
  evidence: readonly FillQualityEvidence[],
  shape: ExecutionShape,
): FillQualityStats | null {
  for (const e of evidence) {
    if (e.available && e.stats.shape === shape) return e.stats;
  }
  return null;
}

/**
 * The chooser. See module header for the contract. Returns a recommendation
 * stamped `shadow: true` / `advisoryOnly: true`; the caller journals it and
 * the actual order path proceeds exactly as it would have anyway.
 */
export function chooseExecutionPolicy(
  input: ExecutionPolicyInput,
): ExecutionPolicyRecommendation {
  const rationale: string[] = [];
  const evidence = {
    spread: input.spread,
    urgency: input.urgency,
    size: input.size,
    fillQuality: input.fillQuality,
    currentDefaultShape: input.currentDefaultShape,
  };

  // ── Urgency dominates: an IMMEDIATE entry cannot afford staging latency. ──
  if (input.urgency === "IMMEDIATE") {
    rationale.push("urgency IMMEDIATE — staging latency is unacceptable, immediate market dispatch recommended");
    return finish("IMMEDIATE_MARKET", 0.9, rationale, evidence, input.currentDefaultShape);
  }

  let stagedScore = 0;
  let marketScore = 1; // immediacy has baseline value on a moving market
  let knownSignals = 0;

  // ── Spread state ──────────────────────────────────────────────────────────
  const { currentSpread, typicalSpread } = input.spread;
  if (currentSpread !== null && typicalSpread !== null && typicalSpread > 0) {
    knownSignals += 1;
    const ratio = currentSpread / typicalSpread;
    if (ratio >= WIDE_SPREAD_RATIO) {
      stagedScore += 2;
      rationale.push(`spread is WIDE (${ratio.toFixed(2)}x typical ≥ ${WIDE_SPREAD_RATIO}x) — staged entry avoids paying a stressed spread`);
    } else if (ratio >= ELEVATED_SPREAD_RATIO) {
      stagedScore += 1;
      rationale.push(`spread is elevated (${ratio.toFixed(2)}x typical ≥ ${ELEVATED_SPREAD_RATIO}x)`);
    } else {
      marketScore += 1;
      rationale.push(`spread is normal (${ratio.toFixed(2)}x typical) — market dispatch pays no stress premium`);
    }
  } else {
    rationale.push("spread baseline unreadable — spread signal excluded (no value synthesized)");
  }

  // ── Size vs recent volume ─────────────────────────────────────────────────
  const { orderSize, recentVolume } = input.size;
  if (recentVolume !== null && recentVolume > 0) {
    knownSignals += 1;
    const fraction = orderSize / recentVolume;
    if (fraction >= LARGE_SIZE_FRACTION) {
      stagedScore += 2;
      rationale.push(`order is LARGE vs recent volume (${(fraction * 100).toFixed(1)}% ≥ ${LARGE_SIZE_FRACTION * 100}%) — staging reduces footprint`);
    } else if (fraction >= NOTABLE_SIZE_FRACTION) {
      stagedScore += 1;
      rationale.push(`order is notable vs recent volume (${(fraction * 100).toFixed(1)}%)`);
    } else {
      marketScore += 1;
      rationale.push(`order is small vs recent volume (${(fraction * 100).toFixed(1)}%)`);
    }
  } else {
    rationale.push("recent volume unreadable — size signal excluded (no value synthesized)");
  }

  // ── Urgency (non-IMMEDIATE) ───────────────────────────────────────────────
  if (input.urgency === "PATIENT") {
    stagedScore += 1;
    rationale.push("urgency PATIENT — time is available to work the entry");
  }

  // ── Fill-quality evidence tilt ────────────────────────────────────────────
  const market = fillStatsFor(input.fillQuality, "IMMEDIATE_MARKET");
  const staged = fillStatsFor(input.fillQuality, "GUIDED_STAGED");
  if (market && staged && market.sampleSize >= MIN_FILL_SAMPLE && staged.sampleSize >= MIN_FILL_SAMPLE) {
    knownSignals += 1;
    if (staged.medianAdverseSlippage < market.medianAdverseSlippage) {
      stagedScore += 1;
      rationale.push(`fill evidence favors GUIDED_STAGED (median adverse slippage ${staged.medianAdverseSlippage} vs ${market.medianAdverseSlippage}, n=${staged.sampleSize}/${market.sampleSize})`);
    } else if (market.medianAdverseSlippage < staged.medianAdverseSlippage) {
      marketScore += 1;
      rationale.push(`fill evidence favors IMMEDIATE_MARKET (median adverse slippage ${market.medianAdverseSlippage} vs ${staged.medianAdverseSlippage}, n=${market.sampleSize}/${staged.sampleSize})`);
    } else {
      rationale.push("fill evidence is a tie — no tilt");
    }
  } else {
    rationale.push(`fill-quality evidence below minimum sample (need ≥${MIN_FILL_SAMPLE} per shape) — tilt excluded`);
  }

  // ── Data-starved: defer to the existing default path, honestly. ───────────
  if (knownSignals === 0) {
    rationale.push(`insufficient evidence on every signal — deferring to existing default path ${input.currentDefaultShape} with confidence 0`);
    return finish(input.currentDefaultShape, 0, rationale, evidence, input.currentDefaultShape);
  }

  const recommended: ExecutionShape = stagedScore > marketScore ? "GUIDED_STAGED" : "IMMEDIATE_MARKET";
  const margin = Math.abs(stagedScore - marketScore);
  // Confidence: how much of the signal set was readable, damped by how close
  // the vote was. Bounded [0,1]; a full-evidence blowout still caps at 1.
  const confidence = Math.min(1, (knownSignals / 3) * Math.min(1, 0.4 + margin * 0.2));
  rationale.push(`vote: staged=${stagedScore} market=${marketScore} → ${recommended}`);
  return finish(recommended, confidence, rationale, evidence, input.currentDefaultShape);
}

function finish(
  recommendedShape: ExecutionShape,
  confidence: number,
  rationale: string[],
  evidence: ExecutionPolicyRecommendation["evidence"],
  currentDefaultShape: ExecutionShape,
): ExecutionPolicyRecommendation {
  return {
    recommendedShape,
    divergesFromDefault: recommendedShape !== currentDefaultShape,
    confidence,
    rationale,
    evidence,
    shadow: true,
    advisoryOnly: true,
  };
}
