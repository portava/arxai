// ── Conformal authority integration (capability #4) — FLAG-GATED, default OFF
//
// The staged, authority-bearing consumption of the lib/validation conformal
// verdict. THE CONTRACT, in order of precedence:
//
//   1. DEFAULT OFF. Unless the caller passes `gateEnabled: true` (which the
//      api-server derives ONLY from ARX_CONFORMAL_GATE_ENABLED — an owner
//      press, see docs/CONFORMAL_GATE_AUTHORITY.md), the verdict remains the
//      same journal-only advisory it always was.
//   2. COVERAGE MUST BE PROVEN. Even with the flag on, the veto is inert until
//      empirical coverage has been validated on a later chronological window
//      of at least CONFORMAL_MIN_EVALUATION_WINDOW records
//      (`proveConformalCoverage`). A coverage claim without that evidence is
//      not authority.
//   3. TIGHTEN-ONLY. When armed, an `admissible: false` verdict may only
//      RESTRICT: an approved/ENTER result is demoted to WAIT with
//      approved=false. It can NEVER flip a blocked/unapproved result toward
//      approval, never raise a score, never remove a blocker — the function
//      copies every field and only ever writes the restrictive demotion.
//   4. An `admissible: true` verdict changes NOTHING. Conformal admissibility
//      is never a source of confidence, only a possible source of caution.
//
// Pure. The env flag is read by the api-server wrapper, never here.

import type {
  ConfidenceGateResult,
  ConformalAdvisoryEvidence,
} from "./confidenceGate.types";
import { attachConformalAdvisory } from "./confidenceGate.engine";

/** Minimum later-window records before empirical coverage counts as proven. */
export const CONFORMAL_MIN_EVALUATION_WINDOW = 200;

/** The empirical-coverage facts the proof is judged on (structural mirror of
 *  lib/validation `CoverageValidation` — the package graph is frozen). */
export interface ConformalCoverageEvidence {
  pass: boolean;
  declaredCoverage: number;
  empiricalCoverage: number | null;
  validationSize: number;
}

export type ConformalCoverageProof =
  | {
      proven: true;
      empiricalCoverage: number;
      validationSize: number;
      reason: string;
    }
  | { proven: false; reason: string };

/**
 * Decide whether empirical coverage is PROVEN well enough to bear authority.
 * Proven requires: the validation passed, on a window of at least
 * `minEvaluationWindow` records, with a finite empirical coverage. Anything
 * less is an explicit not-proven with the reason.
 */
export function proveConformalCoverage(
  evidence: ConformalCoverageEvidence | null | undefined,
  minEvaluationWindow: number = CONFORMAL_MIN_EVALUATION_WINDOW,
): ConformalCoverageProof {
  if (!evidence) {
    return { proven: false, reason: "no coverage validation evidence exists" };
  }
  if (evidence.empiricalCoverage === null || !Number.isFinite(evidence.empiricalCoverage)) {
    return { proven: false, reason: "empirical coverage was never measured" };
  }
  if (evidence.validationSize < minEvaluationWindow) {
    return {
      proven: false,
      reason: `validation window ${evidence.validationSize} < required ${minEvaluationWindow}`,
    };
  }
  if (!evidence.pass) {
    return {
      proven: false,
      reason: `coverage validation FAILED (empirical ${evidence.empiricalCoverage.toFixed(4)} vs declared ${evidence.declaredCoverage})`,
    };
  }
  return {
    proven: true,
    empiricalCoverage: evidence.empiricalCoverage,
    validationSize: evidence.validationSize,
    reason: `empirical coverage ${evidence.empiricalCoverage.toFixed(4)} proven over ${evidence.validationSize} later-window records`,
  };
}

export type ConformalAuthorityMode =
  | "ADVISORY_FLAG_OFF" // owner has not pressed the flag — advisory only
  | "ADVISORY_COVERAGE_UNPROVEN" // flag on but coverage not proven — advisory only
  | "NO_ACTION_ADMISSIBLE" // armed, verdict admissible — nothing to do
  | "NO_ACTION_ALREADY_RESTRICTED" // armed, inadmissible, but result was already not approved
  | "VETO_APPLIED"; // armed, inadmissible, approved result demoted to WAIT

export interface ConformalAuthorityOutcome {
  mode: ConformalAuthorityMode;
  reason: string;
  /** The result with the advisory attached and (only for VETO_APPLIED) the
   *  tighten-only demotion applied. */
  result: ConfidenceGateResult;
}

export interface ApplyConformalAuthorityInput {
  result: ConfidenceGateResult;
  conformal: ConformalAdvisoryEvidence;
  /** True ONLY when ARX_CONFORMAL_GATE_ENABLED was set by the owner press. */
  gateEnabled: boolean;
  coverageProof: ConformalCoverageProof;
}

/**
 * Apply the (possibly armed) conformal authority to a confidence-gate result.
 * The advisory evidence is ALWAYS attached; the verdict fields change only in
 * the single tighten-only case described in the header.
 */
export function applyConformalAuthority(
  input: ApplyConformalAuthorityInput,
): ConformalAuthorityOutcome {
  const withAdvisory = attachConformalAdvisory(input.result, input.conformal);

  if (!input.gateEnabled) {
    return {
      mode: "ADVISORY_FLAG_OFF",
      reason: "ARX_CONFORMAL_GATE_ENABLED is not set — conformal verdict is advisory only",
      result: withAdvisory,
    };
  }
  if (!input.coverageProof.proven) {
    return {
      mode: "ADVISORY_COVERAGE_UNPROVEN",
      reason: `coverage unproven (${input.coverageProof.reason}) — conformal verdict is advisory only`,
      result: withAdvisory,
    };
  }
  if (input.conformal.admissible) {
    return {
      mode: "NO_ACTION_ADMISSIBLE",
      reason: "conformal verdict admissible — admissibility never adds confidence, nothing changes",
      result: withAdvisory,
    };
  }
  if (!withAdvisory.approved) {
    return {
      mode: "NO_ACTION_ALREADY_RESTRICTED",
      reason: "result already not approved — the veto has nothing to tighten",
      result: withAdvisory,
    };
  }

  // TIGHTEN-ONLY VETO: approved → not approved, recommendation → WAIT.
  const vetoNote = `[CONFORMAL] veto (coverage-proven): ${input.conformal.reason}`;
  return {
    mode: "VETO_APPLIED",
    reason: vetoNote,
    result: {
      ...withAdvisory,
      approved: false,
      recommendation: "WAIT",
      warnings: [...withAdvisory.warnings, vetoNote],
    },
  };
}
