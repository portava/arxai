// Capability #4 — conformal authority integration (FLAG-GATED, default OFF).
//
// Locked here:
//   * DEFAULT OFF: without ARX_CONFORMAL_GATE_ENABLED the verdict is advisory
//     only — every verdict field passes through unchanged.
//   * COVERAGE MUST BE PROVEN: even with the flag on, an unproven / failing /
//     under-window coverage validation keeps the verdict advisory.
//   * TIGHTEN-ONLY: an armed inadmissible verdict demotes approved/ENTER to
//     not-approved/WAIT and NOTHING ELSE; it can never re-approve a blocked
//     result, never touches scores/blockers, and admissible:true changes
//     nothing.
//   * The env flag has exactly one reader with default-off interpretation.
//
// Run: pnpm --filter @workspace/api-server run test:conformal-authority

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFORMAL_MIN_EVALUATION_WINDOW,
  applyConformalAuthority,
  proveConformalCoverage,
  type ConfidenceGateResult,
  type ConformalAdvisoryEvidence,
} from "@workspace/domain/confidence-gate";
import {
  conformalGateEnabledFromEnv,
  isConformalGateEnabled,
} from "../conformal/conformalGateFlag.js";

function gateResult(over: Partial<ConfidenceGateResult> = {}): ConfidenceGateResult {
  return {
    approved: true,
    finalScore: 96,
    requiredScore: 95,
    blockers: [],
    warnings: [],
    scoreBreakdown: {
      strategyEdge: 96, marketRegime: 96, multiTimeframe: 96, executionQuality: 96,
      riskApproval: 96, traderBehavior: 96, liveValidation: 96,
    },
    recommendation: "ENTER",
    reports: [],
    signalId: "sig-1",
    decidedAt: "2026-08-29T12:00:00.000Z",
    totalDurationMs: 1,
    ...over,
  };
}

function inadmissible(): ConformalAdvisoryEvidence {
  return {
    admissible: false,
    interval: { lower: -2, upper: 1, unbounded: false },
    outcomeSet: null,
    coverage: 0.9,
    calibrationSize: 300,
    reason: "outcomes violating gte 0 cannot be excluded from [-2, 1]",
    advisoryOnly: true,
  };
}

function admissible(): ConformalAdvisoryEvidence {
  return { ...inadmissible(), admissible: true, reason: "entire interval satisfies gte 0" };
}

const PROVEN = proveConformalCoverage({
  pass: true,
  declaredCoverage: 0.9,
  empiricalCoverage: 0.905,
  validationSize: CONFORMAL_MIN_EVALUATION_WINDOW,
});

// ── Coverage proof ──────────────────────────────────────────────────────────

test("coverage proof: null / unmeasured / short-window / failing all NOT proven", () => {
  assert.equal(proveConformalCoverage(null).proven, false);
  assert.equal(
    proveConformalCoverage({ pass: true, declaredCoverage: 0.9, empiricalCoverage: null, validationSize: 500 }).proven,
    false,
  );
  assert.equal(
    proveConformalCoverage({
      pass: true, declaredCoverage: 0.9, empiricalCoverage: 0.9,
      validationSize: CONFORMAL_MIN_EVALUATION_WINDOW - 1,
    }).proven,
    false,
  );
  assert.equal(
    proveConformalCoverage({ pass: false, declaredCoverage: 0.9, empiricalCoverage: 0.7, validationSize: 500 }).proven,
    false,
  );
  assert.equal(PROVEN.proven, true);
});

// ── Default off ─────────────────────────────────────────────────────────────

test("flag off → advisory only: every verdict field unchanged, evidence attached", () => {
  const result = gateResult();
  const out = applyConformalAuthority({
    result, conformal: inadmissible(), gateEnabled: false, coverageProof: PROVEN,
  });
  assert.equal(out.mode, "ADVISORY_FLAG_OFF");
  assert.equal(out.result.approved, true);
  assert.equal(out.result.recommendation, "ENTER");
  assert.equal(out.result.finalScore, 96);
  assert.deepEqual(out.result.blockers, []);
  assert.equal(out.result.advisory?.conformal?.admissible, false);
  // The input object is never mutated.
  assert.equal(result.advisory, undefined);
});

test("flag on but coverage unproven → still advisory only", () => {
  const out = applyConformalAuthority({
    result: gateResult(),
    conformal: inadmissible(),
    gateEnabled: true,
    coverageProof: proveConformalCoverage(null),
  });
  assert.equal(out.mode, "ADVISORY_COVERAGE_UNPROVEN");
  assert.equal(out.result.approved, true);
  assert.equal(out.result.recommendation, "ENTER");
});

// ── Armed behavior ──────────────────────────────────────────────────────────

test("armed + inadmissible + approved → VETO_APPLIED demotes to WAIT (tighten-only)", () => {
  const out = applyConformalAuthority({
    result: gateResult(), conformal: inadmissible(), gateEnabled: true, coverageProof: PROVEN,
  });
  assert.equal(out.mode, "VETO_APPLIED");
  assert.equal(out.result.approved, false);
  assert.equal(out.result.recommendation, "WAIT");
  assert.ok(out.result.warnings.some((w) => w.includes("[CONFORMAL]")));
  // Everything else untouched: score, blockers, breakdown.
  assert.equal(out.result.finalScore, 96);
  assert.deepEqual(out.result.blockers, []);
  assert.equal(out.result.scoreBreakdown.riskApproval, 96);
});

test("armed + admissible → NOTHING changes (admissibility is never confidence)", () => {
  const out = applyConformalAuthority({
    result: gateResult(), conformal: admissible(), gateEnabled: true, coverageProof: PROVEN,
  });
  assert.equal(out.mode, "NO_ACTION_ADMISSIBLE");
  assert.equal(out.result.approved, true);
  assert.equal(out.result.recommendation, "ENTER");
});

test("armed + inadmissible on an already-blocked result → never loosens, never re-blocks twice", () => {
  const blocked = gateResult({ approved: false, recommendation: "BLOCK", blockers: ["[RISK][riskApproval] daily loss"] });
  const out = applyConformalAuthority({
    result: blocked, conformal: inadmissible(), gateEnabled: true, coverageProof: PROVEN,
  });
  assert.equal(out.mode, "NO_ACTION_ALREADY_RESTRICTED");
  assert.equal(out.result.approved, false);
  assert.equal(out.result.recommendation, "BLOCK");
  assert.deepEqual(out.result.blockers, ["[RISK][riskApproval] daily loss"]);
});

// ── The env flag reader ─────────────────────────────────────────────────────

test("ARX_CONFORMAL_GATE_ENABLED interpretation: default OFF, explicit affirmatives only", () => {
  assert.equal(conformalGateEnabledFromEnv(undefined), false);
  assert.equal(conformalGateEnabledFromEnv(""), false);
  assert.equal(conformalGateEnabledFromEnv("0"), false);
  assert.equal(conformalGateEnabledFromEnv("false"), false);
  assert.equal(conformalGateEnabledFromEnv("banana"), false);
  assert.equal(conformalGateEnabledFromEnv("true"), true);
  assert.equal(conformalGateEnabledFromEnv("1"), true);
  assert.equal(conformalGateEnabledFromEnv("on"), true);
  assert.equal(conformalGateEnabledFromEnv("YES"), true);
});

test("isConformalGateEnabled reads the environment and defaults OFF in CI", () => {
  const prev = process.env["ARX_CONFORMAL_GATE_ENABLED"];
  try {
    delete process.env["ARX_CONFORMAL_GATE_ENABLED"];
    assert.equal(isConformalGateEnabled(), false);
    process.env["ARX_CONFORMAL_GATE_ENABLED"] = "true";
    assert.equal(isConformalGateEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env["ARX_CONFORMAL_GATE_ENABLED"];
    else process.env["ARX_CONFORMAL_GATE_ENABLED"] = prev;
  }
});
