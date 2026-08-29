// Capability #7 — disagreement classes + stored-disagreement calibration.
//
// Locked here:
//   * Six classes (direction/quality/timing/regime/cost/uncertainty), each
//     with a per-class mapping to NONE / REDUCE_SIZE / ABSTAIN.
//   * REDUCE-ONLY: no multiplier ever exceeds 1; the combined multiplier is
//     the MIN across classes; ABSTAIN dominates.
//   * Fewer than two reporters for a facet → typed INSUFFICIENT_REPORTERS
//     (multiplier 1) — a single voice is never fabricated into a split.
//   * The stored-disagreement calibration loop runs over persisted records:
//     per divergence kind, resolved-outcome stats at ≥ minSamples, honest
//     INSUFFICIENT_HISTORY below; suggested multipliers are TIGHTEN-ONLY
//     (never > 1; exactly 1 when outcomes are non-negative).
//
// Run: pnpm --filter @workspace/api-server run test:disagreement-classes

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISAGREEMENT_ABSTAIN_THRESHOLD,
  DISAGREEMENT_CLASSES,
  classifyDisagreement,
  type AgentStanceReading,
} from "@workspace/domain/agent-system";
import {
  DISAGREEMENT_CALIBRATION_MIN_SAMPLES,
  InMemoryDisagreementStore,
  buildDisagreementRecord,
  calibrateStoredDisagreements,
  type ShadowComparison,
} from "@workspace/domain/intelligence-v2";

// ── Per-class classification ────────────────────────────────────────────────

test("no stances → every class is INSUFFICIENT_REPORTERS with multiplier 1", () => {
  const report = classifyDisagreement([]);
  for (const cls of DISAGREEMENT_CLASSES) {
    const c = report.classes[cls];
    assert.equal(c.status, "INSUFFICIENT_REPORTERS", cls);
    assert.equal(c.sizeMultiplier, 1);
    assert.equal(c.action, "NONE");
  }
  assert.equal(report.combinedSizeMultiplier, 1);
  assert.equal(report.combinedAction, "NONE");
});

test("single reporter of a facet is never fabricated into a split", () => {
  const report = classifyDisagreement([
    { agentId: "a", timing: "NOW", regime: "TRENDING", expectedCostR: 0.2, uncertainty01: 0.9 },
  ]);
  assert.equal(report.classes.timing.status, "INSUFFICIENT_REPORTERS");
  assert.equal(report.classes.regime.status, "INSUFFICIENT_REPORTERS");
  assert.equal(report.classes.cost.status, "INSUFFICIENT_REPORTERS");
  assert.equal(report.classes.uncertainty.status, "INSUFFICIENT_REPORTERS");
  assert.equal(report.combinedSizeMultiplier, 1);
});

test("timing 50/50 NOW-vs-WAIT split → maximal timing disagreement → ABSTAIN", () => {
  const report = classifyDisagreement([
    { agentId: "a", timing: "NOW" },
    { agentId: "b", timing: "WAIT" },
  ]);
  const t = report.classes.timing;
  assert.equal(t.status, "MEASURED");
  if (t.status === "MEASURED") {
    assert.ok(t.score01 >= DISAGREEMENT_ABSTAIN_THRESHOLD);
    assert.equal(t.action, "ABSTAIN");
    assert.equal(t.sizeMultiplier, 0);
  }
  assert.equal(report.combinedAction, "ABSTAIN");
  assert.equal(report.combinedSizeMultiplier, 0);
});

test("unanimous timing/regime → zero disagreement, no reduction", () => {
  const report = classifyDisagreement([
    { agentId: "a", timing: "NOW", regime: "TRENDING" },
    { agentId: "b", timing: "NOW", regime: "TRENDING" },
    { agentId: "c", timing: "NOW", regime: "TRENDING" },
  ]);
  const t = report.classes.timing;
  const r = report.classes.regime;
  assert.equal(t.status, "MEASURED");
  assert.equal(r.status, "MEASURED");
  if (t.status === "MEASURED") assert.equal(t.score01, 0);
  if (r.status === "MEASURED") assert.equal(r.score01, 0);
  assert.equal(report.combinedSizeMultiplier, 1);
});

test("regime label fragmentation maps to reduce-only actions", () => {
  const report = classifyDisagreement([
    { agentId: "a", regime: "TRENDING" },
    { agentId: "b", regime: "TRENDING" },
    { agentId: "c", regime: "RANGING" },
  ]);
  const r = report.classes.regime;
  assert.equal(r.status, "MEASURED");
  if (r.status === "MEASURED") {
    assert.ok(r.score01 > 0.6 && r.score01 < DISAGREEMENT_ABSTAIN_THRESHOLD);
    assert.equal(r.action, "REDUCE_SIZE");
    assert.ok(r.sizeMultiplier < 1 && r.sizeMultiplier >= 0.25);
  }
});

test("cost dispersion → REDUCE_SIZE; uncertainty dispersion → measured", () => {
  const report = classifyDisagreement([
    { agentId: "a", expectedCostR: 0.1, uncertainty01: 0.2 },
    { agentId: "b", expectedCostR: 0.4, uncertainty01: 0.75 },
  ]);
  const c = report.classes.cost;
  assert.equal(c.status, "MEASURED");
  if (c.status === "MEASURED") {
    assert.ok(c.score01 > 0.9); // spread 0.3 vs mean 0.25 → saturated
    assert.notEqual(c.action, "NONE");
  }
  const u = report.classes.uncertainty;
  assert.equal(u.status, "MEASURED");
  if (u.status === "MEASURED") {
    assert.ok(Math.abs(u.score01 - 0.55) < 1e-9);
    assert.equal(u.action, "REDUCE_SIZE");
  }
});

test("REDUCE-ONLY invariant: combined multiplier is min over classes, never > 1", () => {
  const report = classifyDisagreement([
    { agentId: "a", direction: "BUY", conviction: 60, quality: 80, timing: "NOW", regime: "TRENDING", expectedCostR: 0.2, uncertainty01: 0.3 },
    { agentId: "b", direction: "BUY", conviction: 55, quality: 40, timing: "NOW", regime: "TRENDING", expectedCostR: 0.22, uncertainty01: 0.35 },
  ]);
  const multipliers = DISAGREEMENT_CLASSES.map((c) => report.classes[c].sizeMultiplier);
  assert.ok(multipliers.every((m) => m <= 1 && m >= 0));
  assert.equal(report.combinedSizeMultiplier, Math.min(1, ...multipliers));
});

test("direction split reuses conviction weighting (balanced → high score)", () => {
  const report = classifyDisagreement([
    { agentId: "a", direction: "BUY", conviction: 70 },
    { agentId: "b", direction: "SELL", conviction: 70 },
  ]);
  const d = report.classes.direction;
  assert.equal(d.status, "MEASURED");
  if (d.status === "MEASURED") {
    assert.equal(d.score01, 1);
    assert.equal(d.action, "ABSTAIN");
  }
});

// ── Stored-disagreement calibration loop ────────────────────────────────────

function comparison(kinds: ShadowComparison["divergenceKinds"], signalId: string): ShadowComparison {
  return {
    signalId,
    comparedAt: "2026-08-29T12:00:00.000Z",
    v1Vote: "APPROVE" as ShadowComparison["v1Vote"],
    v1Confidence: 70,
    v1ActionClass: "ENTER" as ShadowComparison["v1ActionClass"],
    v1Blockers: [],
    v2Verdict: "PROCEED" as ShadowComparison["v2Verdict"],
    v2Confidence: 40,
    v2ActionClass: "WAIT" as ShadowComparison["v2ActionClass"],
    v2Direction: "BUY",
    v2Blockers: [],
    v2RecommendedSizeMultiplier: 1,
    agreed: false,
    divergenceKinds: kinds,
    confidenceDelta: -30,
    notes: [],
  };
}

test("calibration loop over the store: per-kind stats, tighten-only suggestions", async () => {
  const store = new InMemoryDisagreementStore();
  const n = DISAGREEMENT_CALIBRATION_MIN_SAMPLES;

  // VERDICT divergences resolved NEGATIVE (mean −0.5R) → tightening suggested.
  for (let i = 0; i < n; i++) {
    const rec = buildDisagreementRecord({
      comparison: comparison(["VERDICT"], `v-${i}`),
      symbol: "EURUSD",
      id: `v-${i}`,
    });
    await store.record(rec);
    await store.fillOutcome(`v-${i}`, i % 2 === 0 ? -1.5 : 0.5, "V1");
  }
  // CONFIDENCE divergences resolved POSITIVE → NO tightening (exactly 1).
  for (let i = 0; i < n; i++) {
    const rec = buildDisagreementRecord({
      comparison: comparison(["CONFIDENCE"], `c-${i}`),
      symbol: "EURUSD",
      id: `c-${i}`,
    });
    await store.record(rec);
    await store.fillOutcome(`c-${i}`, 0.8, "V1");
  }
  // BLOCKERS divergences: mostly unresolved → INSUFFICIENT_HISTORY w/ pending.
  for (let i = 0; i < 5; i++) {
    await store.record(
      buildDisagreementRecord({
        comparison: comparison(["BLOCKERS"], `b-${i}`),
        symbol: "EURUSD",
        id: `b-${i}`,
      }),
    );
  }

  const report = calibrateStoredDisagreements(await store.list());
  assert.equal(report.totalRecords, 2 * n + 5);
  assert.equal(report.totalResolved, 2 * n);

  const verdictCal = report.perKind.VERDICT;
  assert.equal(verdictCal.status, "OK");
  if (verdictCal.status === "OK") {
    assert.equal(verdictCal.resolved, n);
    assert.ok(Math.abs(verdictCal.meanOutcomeR - -0.5) < 1e-9);
    assert.ok(verdictCal.suggestedSizeMultiplier < 1, "negative mean must tighten");
    assert.ok(verdictCal.suggestedSizeMultiplier >= 0.25);
  }

  const confCal = report.perKind.CONFIDENCE;
  assert.equal(confCal.status, "OK");
  if (confCal.status === "OK") {
    assert.equal(confCal.suggestedSizeMultiplier, 1, "positive outcomes must NOT loosen anything");
    assert.equal(confCal.winRate, 1);
  }

  const blockCal = report.perKind.BLOCKERS;
  assert.equal(blockCal.status, "INSUFFICIENT_HISTORY");
  if (blockCal.status === "INSUFFICIENT_HISTORY") {
    assert.equal(blockCal.pending, 5);
    assert.equal(blockCal.resolved, 0);
  }
});

test("calibration never suggests a multiplier above 1 (tighten-only floor at 0.25)", async () => {
  const store = new InMemoryDisagreementStore();
  for (let i = 0; i < DISAGREEMENT_CALIBRATION_MIN_SAMPLES; i++) {
    await store.record(
      buildDisagreementRecord({
        comparison: comparison(["VERDICT"], `x-${i}`),
        symbol: "EURUSD",
        id: `x-${i}`,
      }),
    );
    await store.fillOutcome(`x-${i}`, -5, "V1"); // catastrophic mean
  }
  const report = calibrateStoredDisagreements(await store.list());
  const cal = report.perKind.VERDICT;
  assert.equal(cal.status, "OK");
  if (cal.status === "OK") {
    assert.equal(cal.suggestedSizeMultiplier, 0.25);
  }
});
