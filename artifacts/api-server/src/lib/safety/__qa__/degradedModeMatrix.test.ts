// Capability #32 — Degraded-Mode Matrix test suite (chaos-lite fixtures).
//
// Proves, offline and deterministically:
//   1. CONTRACT SHAPE: every subsystem (broker/data/bridge + the newly
//      covered Ruby/model/reconciliation/database) has exactly one row, and
//      no row grants new exposure under a CLOSE_ONLY/NONE posture.
//   2. PER-ROW OUTAGE FIXTURES: injecting each subsystem's outage yields the
//      row's declared posture through the pure evaluator — including the
//      hard rows: DATABASE outage → NONE (an unreadable stop button is not
//      permission to trade) and MODEL outage → REDUCED with new exposure
//      still allowed (losing learned outputs can only make the system MORE
//      conservative, because learned outputs only tighten).
//   3. COMPOSITION is strictest-wins and monotone: adding an outage can
//      never loosen the posture; unknown subsystems fail closed to NONE.
//   4. RUNTIME CONSISTENCY (matrix ↔ engines): the vocabulary is the
//      global-state ExecutionPermission enum, and the DATABASE row's
//      enforcement claim matches the real fail-closed engine behavior
//      (recovery probation's pure verdicts refuse under uncertainty).
//
// Run: pnpm --filter @workspace/api-server run test:degraded-mode-matrix

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEGRADED_MODE_MATRIX,
  SUBSYSTEMS,
  degradedModeRowFor,
  evaluateDegradedPosture,
  stricterPosture,
  type Subsystem,
} from "@workspace/domain/safety-contracts/degradedModeMatrix";
import { ExecutionPermissionSchema } from "@workspace/domain/global-state";

// ── 1. Contract shape ───────────────────────────────────────────────────────

test("every subsystem has exactly one matrix row; no extras", () => {
  assert.equal(DEGRADED_MODE_MATRIX.length, SUBSYSTEMS.length);
  for (const s of SUBSYSTEMS) {
    const rows = DEGRADED_MODE_MATRIX.filter((r) => r.subsystem === s);
    assert.equal(rows.length, 1, `subsystem ${s} must have exactly one row`);
  }
});

test("the previously uncovered subsystems are now covered: RUBY, MODEL, RECONCILIATION, DATABASE", () => {
  for (const s of ["RUBY", "MODEL", "RECONCILIATION", "DATABASE"] as const) {
    assert.ok(degradedModeRowFor(s), `missing row for ${s}`);
  }
});

test("no row grants new exposure under a CLOSE_ONLY/NONE posture; every row names detection + enforcement", () => {
  for (const row of DEGRADED_MODE_MATRIX) {
    ExecutionPermissionSchema.parse(row.posture); // shared vocabulary with global-state profiles
    if (row.posture === "CLOSE_ONLY" || row.posture === "NONE") {
      assert.equal(row.newExposureAllowed, false, `${row.subsystem}: ${row.posture} must refuse new exposure`);
    }
    assert.ok(row.detectedBy.length > 10, `${row.subsystem}: detection mechanism must be named`);
    assert.ok(row.enforcedBy.length > 10, `${row.subsystem}: enforcement mechanism must be named`);
    assert.ok(row.recoveryCondition.length > 10, `${row.subsystem}: recovery condition must be named`);
    assert.notEqual(row.posture, "FULL", `${row.subsystem}: an OUTAGE row cannot declare FULL — that would mean the outage changes nothing`);
  }
});

// ── 2. Per-row outage fixtures (chaos-lite) ─────────────────────────────────

const EXPECTED: Record<Subsystem, { posture: string; newExposure: boolean }> = {
  BROKER:         { posture: "CLOSE_ONLY", newExposure: false },
  DATA_FEED:      { posture: "CLOSE_ONLY", newExposure: false },
  BRIDGE:         { posture: "CLOSE_ONLY", newExposure: false },
  RUBY:           { posture: "CLOSE_ONLY", newExposure: false },
  MODEL:          { posture: "REDUCED",    newExposure: true  },
  RECONCILIATION: { posture: "CLOSE_ONLY", newExposure: false },
  DATABASE:       { posture: "NONE",       newExposure: false },
};

for (const subsystem of SUBSYSTEMS) {
  test(`outage fixture: ${subsystem} down → ${EXPECTED[subsystem].posture}, new exposure ${EXPECTED[subsystem].newExposure ? "allowed (reduced)" : "refused"}`, () => {
    const verdict = evaluateDegradedPosture([{ subsystem, detail: "injected outage fixture" }]);
    assert.equal(verdict.posture, EXPECTED[subsystem].posture);
    assert.equal(verdict.newExposureAllowed, EXPECTED[subsystem].newExposure);
    assert.deepEqual(verdict.outagesApplied, [subsystem]);
    assert.deepEqual(verdict.unknownSubsystems, []);
    assert.ok(verdict.reasons.some((r) => r.includes(subsystem)), "verdict must name the outage");
  });
}

test("DATABASE outage dominates everything: no readable safety state = no orders of any kind", () => {
  const verdict = evaluateDegradedPosture([
    { subsystem: "MODEL" },
    { subsystem: "DATABASE" },
  ]);
  assert.equal(verdict.posture, "NONE");
  assert.equal(verdict.newExposureAllowed, false);
});

test("MODEL outage alone keeps trading available at REDUCED — the unlearned baseline is the conservative one", () => {
  const row = degradedModeRowFor("MODEL")!;
  assert.equal(row.posture, "REDUCED");
  assert.equal(row.newExposureAllowed, true);
  assert.ok(row.degradedBehavior.includes("tighten"), "the row must state WHY losing learned outputs is safe: they only ever tighten");
});

// ── 3. Composition ──────────────────────────────────────────────────────────

test("no outages = FULL (the matrix imposes nothing; ordinary gates unchanged)", () => {
  const verdict = evaluateDegradedPosture([]);
  assert.equal(verdict.posture, "FULL");
  assert.equal(verdict.newExposureAllowed, true);
});

test("composition is strictest-wins and monotone: adding an outage never loosens", () => {
  const rank: Record<string, number> = { NONE: 0, CLOSE_ONLY: 1, REDUCED: 2, FULL: 3 };
  // Every pair: pair posture must be ≤ each single posture.
  for (const a of SUBSYSTEMS) {
    for (const b of SUBSYSTEMS) {
      const single = evaluateDegradedPosture([{ subsystem: a }]);
      const pair = evaluateDegradedPosture([{ subsystem: a }, { subsystem: b }]);
      assert.ok(
        rank[pair.posture]! <= rank[single.posture]!,
        `adding ${b} to ${a} loosened ${single.posture} → ${pair.posture}`,
      );
      if (!single.newExposureAllowed) {
        assert.equal(pair.newExposureAllowed, false, `adding ${b} re-granted new exposure refused under ${a}`);
      }
    }
  }
  // Helper sanity.
  assert.equal(stricterPosture("REDUCED", "NONE"), "NONE");
  assert.equal(stricterPosture("FULL", "CLOSE_ONLY"), "CLOSE_ONLY");
});

test("an UNKNOWN subsystem fails closed to NONE", () => {
  const verdict = evaluateDegradedPosture([{ subsystem: "QUANTUM_ORACLE" }]);
  assert.equal(verdict.posture, "NONE");
  assert.equal(verdict.newExposureAllowed, false);
  assert.deepEqual(verdict.unknownSubsystems, ["QUANTUM_ORACLE"]);
  assert.ok(verdict.reasons.some((r) => r.includes("failing closed")));
});

// ── 4. Runtime consistency (matrix ↔ real engine fail-closed behavior) ──────

test("DATABASE row's enforcement claim matches the real engines: unreadable safety state refuses", async () => {
  // The row claims fail-closed reads across the gate wall. Pin one real,
  // pure instance of that behavior: recovery probation's BLOCK_ALL verdict
  // refuses every dispatch, and the service treats unreadable-on-deployed as
  // refuse (documented in its module contract; the pure verdict is testable).
  process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";
  const { probationDispatchVerdict, guidedProbationVerdict } = await import("../../recoveryProbation.js");
  const v = probationDispatchVerdict({ stage: "BLOCK_ALL", executionMode: "live", edgeTier: "A" });
  assert.equal(v.allowed, false);
  const g = guidedProbationVerdict("BLOCK_ALL");
  assert.equal(g.allowed, false);
});
