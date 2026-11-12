// Agent trust measured ONLY from that agent's own scored outcome record. PURE.
//
// The registry's `trustScore` / `authorityWeight` were never validated against
// outcomes, so they no longer drive influence. An agent's influence is the
// lower 95% bound of the cross-validated Brier improvement its confidence
// scores give over the base rate on ITS OWN graded predictions:
//   - no record, or fewer than the edge sample      → influence 0
//   - a record whose scores do not beat the base rate → influence 0
//   - a record that beats it out of sample           → influence in (0, 1]
// Noise controls check the false-positive behaviour; they cannot prove a zero false-positive rate.

import {
  CALIBRATION_METHOD,
  fitCalibration,
  type CalibrationFit,
  type CalibrationSample,
} from "./calibration.engine";

/** Brier improvement (per sample) that maps to full influence. A Brier gain
 *  of 0.02 over the base rate is a large, real forecasting edge. */
export const AGENT_FULL_INFLUENCE_IMPROVEMENT = 0.02;

export interface MeasuredAgentTrust {
  agentKey: string;
  /** Graded predictions behind the measurement. */
  n: number;
  /** 0..1. Zero unless the record proves skill out of sample. */
  influence: number;
  /** 50 = no measured skill; 50 + 50 × influence otherwise. Never below 50:
   *  an unskilled record earns silence, not a measured "low trust" vote. */
  trustScore: number;
  status: "measured" | "unmeasured";
  basis: string;
  fit: CalibrationFit;
}

export function measureAgentTrust(agentKey: string, record: CalibrationSample[]): MeasuredAgentTrust {
  return agentTrustFromFit(agentKey, fitCalibration(record));
}

/** Same measurement from an already-fitted (e.g. persisted) record. A missing
 *  fit means no scored record: zero influence. `noReplayReason`, when given,
 *  says why the agent has no replayed record either (its read is not a
 *  deterministic function of market data); it is reported in the basis. */
export function agentTrustFromFit(
  agentKey: string,
  fit: CalibrationFit | null | undefined,
  noReplayReason?: string | null,
): MeasuredAgentTrust {
  const f = fit?.method === CALIBRATION_METHOD ? fit : fitCalibration([]);
  let influence = 0;
  let basis: string;
  if (f.status !== "measured" && !fit && noReplayReason) {
    basis = `no_replayable_record:${noReplayReason}`;
  } else if (f.status !== "measured") {
    basis = `no_scored_record:n=${f.n}`;
  } else if (!f.cv) {
    basis = `no_prospective_validation:n=${f.n}; timed resolved outcomes required`;
  } else if (!f.edgeDetected || !f.holdout?.passed) {
    basis = `no_out_of_sample_skill:selectionLower95=${f.cv.improvementLower95}; holdoutLower95=${f.holdout?.improvementLower95 ?? "unmeasured"}`;
  } else {
    const lower = Math.min(f.cv.improvementLower95, f.holdout.improvementLower95);
    influence = Math.min(1, Math.max(0, lower / AGENT_FULL_INFLUENCE_IMPROVEMENT));
    basis = `out_of_sample_skill:lower95=${lower}`;
  }
  influence = Math.round(influence * 1000) / 1000;
  return {
    agentKey,
    n: f.n,
    influence,
    trustScore: Math.round((50 + 50 * influence) * 10) / 10,
    status: f.status,
    basis,
    fit: f,
  };
}
