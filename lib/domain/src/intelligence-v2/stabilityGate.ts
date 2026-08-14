import {
  V2_PROMOTION_THRESHOLDS,
  type StabilityGateInput, type StabilityGateResult,
} from "./intelligenceV2.types";

// computeStabilityGate
//
// Returns the gating decision for promoting v2 from shadow to live.
// Every gate must pass for `ready` to be true. Even when `ready` is
// false, `stabilityScore` is computed so the dashboard can show
// "we're at 72/100, here's what's missing".
//
// The score is a weighted mean of seven dimensions in [0..1]:
//   • samples       — sample-size sufficiency
//   • agreement     — within sane band (not too low, not a clone of v1)
//   • calibration   — 1 − calibrationError
//   • falsePos      — 1 − fpRate / threshold (clipped to 0..1)
//   • falseBlock    — 1 − fbRate / threshold (clipped to 0..1)
//   • riskGov       — 0 or 1
//   • freshness     — sample age vs maximum allowed
export function computeStabilityGate(input: StabilityGateInput): StabilityGateResult {
  const T = V2_PROMOTION_THRESHOLDS;
  const reasons: string[] = [];
  const blockers: string[] = [];

  // ── Per-gate booleans ───────────────────────────────────────────────────
  const sufficientSamples = input.shadowSampleSize >= T.minShadowSamples;
  const agreementInBand   = input.agreementRate >= T.minAgreementRate
                         && input.agreementRate <= T.maxAgreementRate;
  const calibrationOk     = input.averageCalibrationError <= T.maxCalibrationError;
  const falsePositiveOk   = input.falsePositiveRate <= T.maxFalsePositiveRate;
  const falseBlockOk      = input.falseBlockRate <= T.maxFalseBlockRate;
  const riskGovernorOk    = input.riskGovernorTested === true;
  const sampleFreshnessOk = input.oldestSampleAgeDays <= T.maxOldestSampleAgeDays;

  // ── Reasons / blockers ─────────────────────────────────────────────────
  if (!sufficientSamples) blockers.push(
    `shadow sample ${input.shadowSampleSize} < ${T.minShadowSamples}`,
  );
  if (!agreementInBand) {
    if (input.agreementRate < T.minAgreementRate) {
      blockers.push(`agreement ${(input.agreementRate * 100).toFixed(0)}% < ${(T.minAgreementRate * 100).toFixed(0)}% — v2 catastrophically diverging`);
    } else {
      blockers.push(`agreement ${(input.agreementRate * 100).toFixed(0)}% > ${(T.maxAgreementRate * 100).toFixed(0)}% — v2 is just a clone of v1, no edge`);
    }
  }
  if (!calibrationOk) blockers.push(
    `avg calibration error ${input.averageCalibrationError.toFixed(2)} > ${T.maxCalibrationError}`,
  );
  if (!falsePositiveOk) blockers.push(
    `false-positive rate ${(input.falsePositiveRate * 100).toFixed(0)}% > ${(T.maxFalsePositiveRate * 100).toFixed(0)}%`,
  );
  if (!falseBlockOk) blockers.push(
    `false-block rate ${(input.falseBlockRate * 100).toFixed(0)}% > ${(T.maxFalseBlockRate * 100).toFixed(0)}%`,
  );
  if (!riskGovernorOk) blockers.push("risk governor not yet tested");
  if (!sampleFreshnessOk) blockers.push(
    `oldest sample ${input.oldestSampleAgeDays}d > ${T.maxOldestSampleAgeDays}d — refresh shadow data`,
  );

  reasons.push(`samples ${input.shadowSampleSize} (need ${T.minShadowSamples})`);
  reasons.push(`agreement ${(input.agreementRate * 100).toFixed(0)}% (band ${(T.minAgreementRate * 100).toFixed(0)}-${(T.maxAgreementRate * 100).toFixed(0)}%)`);
  reasons.push(`calibration ${input.averageCalibrationError.toFixed(2)} (max ${T.maxCalibrationError})`);
  reasons.push(`FP ${(input.falsePositiveRate * 100).toFixed(0)}% (max ${(T.maxFalsePositiveRate * 100).toFixed(0)}%)`);
  reasons.push(`FB ${(input.falseBlockRate * 100).toFixed(0)}% (max ${(T.maxFalseBlockRate * 100).toFixed(0)}%)`);
  reasons.push(`risk governor ${input.riskGovernorTested ? "tested" : "untested"}`);
  reasons.push(`oldest sample ${input.oldestSampleAgeDays}d (max ${T.maxOldestSampleAgeDays}d)`);

  // ── Stability score (continuous) ───────────────────────────────────────
  const dimSamples     = clamp01(input.shadowSampleSize / T.minShadowSamples);
  const agreementMid   = (T.minAgreementRate + T.maxAgreementRate) / 2;
  const agreementWidth = (T.maxAgreementRate - T.minAgreementRate) / 2;
  const dimAgreement   = clamp01(1 - Math.abs(input.agreementRate - agreementMid) / Math.max(0.001, agreementWidth));
  const dimCalibration = clamp01(1 - input.averageCalibrationError / Math.max(0.001, T.maxCalibrationError));
  const dimFalsePos    = clamp01(1 - input.falsePositiveRate / Math.max(0.001, T.maxFalsePositiveRate));
  const dimFalseBlock  = clamp01(1 - input.falseBlockRate / Math.max(0.001, T.maxFalseBlockRate));
  const dimRiskGov     = input.riskGovernorTested ? 1 : 0;
  const dimFreshness   = clamp01(1 - input.oldestSampleAgeDays / Math.max(1, T.maxOldestSampleAgeDays));

  const w = T.weights;
  const stabilityScore = Math.round(100 * (
    dimSamples * w.samples
    + dimAgreement * w.agreement
    + dimCalibration * w.calibration
    + dimFalsePos * w.falsePos
    + dimFalseBlock * w.falseBlock
    + dimRiskGov * w.riskGov
    + dimFreshness * w.freshness
  ));

  const ready = sufficientSamples && agreementInBand && calibrationOk
             && falsePositiveOk && falseBlockOk && riskGovernorOk && sampleFreshnessOk;

  return {
    ready, stabilityScore,
    gates: {
      sufficientSamples, agreementInBand, calibrationOk,
      falsePositiveOk, falseBlockOk, riskGovernorOk, sampleFreshnessOk,
    },
    reasons, blockers,
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
