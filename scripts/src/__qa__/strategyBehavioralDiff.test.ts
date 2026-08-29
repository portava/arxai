// Capability #14 — Strategy behavioral diff test suite.
//
// Proves, offline and deterministically:
//   1. IDENTITY: diffing a strategy against itself over a frozen dataset
//      yields an EMPTY changed-decision inventory and zero deltas.
//   2. INVENTORY: a candidate that stops trading below a confidence floor
//      produces an exact TRADE_TO_WAIT inventory (frame indices, regimes,
//      sessions), and the reverse diff reports the same frames as
//      WAIT_TO_TRADE.
//   3. SIMULATION: trade outcomes over the frozen candles are exact — one
//      target hit with pinned pnl in R, holding time, and one position still
//      open at dataset end reported as OPEN_AT_END with pnlR null (never a
//      synthesized mark-to-market).
//   4. COSTS: cost figures exist ONLY when the dataset declares a cost
//      model; otherwise they are null with the typed reason
//      NO_COST_MODEL_IN_DATASET.
//   5. CLASSES: stop/target/confidence changes are classified per frame.
//
// Run: pnpm --filter @workspace/scripts run test:strategy-behavioral-diff

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  londonBreakoutStrategy,
  type Strategy,
} from "@workspace/domain/strategies";
import {
  runBehavioralDiff,
  isTradeSignal,
  type BehavioralDiffReport,
} from "@workspace/domain/strategy-factory";
import { londonBreakoutDataset, LONDON_EMIT_FRAMES } from "./strategyFactoryFixtures";

const NOW = new Date("2026-01-07T00:00:00.000Z"); // injected clock — no Date.now()

function approx(actual: number | null, expected: number, tol = 1e-9): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tol, `expected ≈${expected}, got ${actual}`);
}

// Candidate v2: identical setup logic, but refuses to trade below a
// confidence floor of 75 (the fixture's signals sit at 70).
function confidenceFloorVariant(base: Strategy, floor: number): Strategy {
  return {
    ...base,
    version: "2.0.0-lab",
    evaluate: (input) => {
      const r = base.evaluate(input);
      if (!isTradeSignal(r.signal) || r.signal.confidence >= floor) return r;
      return {
        strategyName: r.strategyName,
        emitted: false,
        signal: null,
        rejectedReasons: [`confidence ${r.signal.confidence} below lab floor ${floor}`],
      };
    },
  };
}

// Candidate v3: same entries, tighter stop (half distance) and higher confidence.
function tighterStopVariant(base: Strategy): Strategy {
  return {
    ...base,
    version: "3.0.0-lab",
    evaluate: (input) => {
      const r = base.evaluate(input);
      if (!isTradeSignal(r.signal) || r.signal.entry === null || r.signal.stopLoss === null) return r;
      const s = r.signal;
      const entry = s.entry as number;
      const halved = entry + ((s.stopLoss as number) - entry) / 2;
      return { ...r, signal: { ...s, stopLoss: halved, confidence: s.confidence + 5 } };
    },
  };
}

// ── 1. Identity ─────────────────────────────────────────────────────────────

test("identical versions => empty inventory and zero deltas", () => {
  const dataset = londonBreakoutDataset();
  const report = runBehavioralDiff(londonBreakoutStrategy, londonBreakoutStrategy, dataset, { now: NOW });
  assert.equal(report.frameCount, 16);
  assert.deepEqual(report.changedDecisions, []);
  assert.equal(report.waitToTradeCount, 0);
  assert.equal(report.tradeToWaitCount, 0);
  assert.equal(report.directionFlipCount, 0);
  assert.deepEqual(report.affectedRegimes, {});
  assert.equal(report.deltas.signalsEmitted, 0);
  assert.equal(report.deltas.tradeFrequencyPerFrame, 0);
  assert.equal(report.deltas.grossPnlR, 0);
  assert.equal(report.baseline.signalsEmitted, LONDON_EMIT_FRAMES.length);
  assert.equal(report.candidate.signalsEmitted, LONDON_EMIT_FRAMES.length);
});

// ── 2. Exact changed-decision inventory ─────────────────────────────────────

test("confidence-floor candidate => exact TRADE_TO_WAIT inventory with regimes and sessions", () => {
  const dataset = londonBreakoutDataset();
  const candidate = confidenceFloorVariant(londonBreakoutStrategy, 75);
  const report = runBehavioralDiff(londonBreakoutStrategy, candidate, dataset, { now: NOW });

  assert.equal(report.tradeToWaitCount, LONDON_EMIT_FRAMES.length);
  assert.equal(report.waitToTradeCount, 0);
  assert.deepEqual(report.changedDecisions.map((d) => d.frameIndex), LONDON_EMIT_FRAMES);
  for (const d of report.changedDecisions) {
    assert.deepEqual(d.classes, ["TRADE_TO_WAIT"]);
    assert.equal(d.baseline.emittedTrade, true);
    assert.equal(d.candidate.emittedTrade, false);
    assert.ok(d.regime.length > 0);
    assert.ok(["LONDON", "OVERLAP_LONDON_NY"].includes(d.session), d.session);
  }
  // Affected-regime histogram covers every changed frame, no more.
  const regimeTotal = Object.values(report.affectedRegimes).reduce((a, b) => a + b, 0);
  assert.equal(regimeTotal, LONDON_EMIT_FRAMES.length);
  const sessionTotal = Object.values(report.affectedSessions).reduce((a, b) => a + b, 0);
  assert.equal(sessionTotal, LONDON_EMIT_FRAMES.length);

  assert.equal(report.deltas.signalsEmitted, -LONDON_EMIT_FRAMES.length);
  assert.ok(report.deltas.tradeFrequencyPerFrame < 0);
  assert.equal(report.candidate.signalsEmitted, 0);
  assert.equal(report.candidate.simulatedTrades.length, 0);
});

test("reverse diff reports the same frames as WAIT_TO_TRADE", () => {
  const dataset = londonBreakoutDataset();
  const candidate = confidenceFloorVariant(londonBreakoutStrategy, 75);
  const report = runBehavioralDiff(candidate, londonBreakoutStrategy, dataset, { now: NOW });
  assert.equal(report.waitToTradeCount, LONDON_EMIT_FRAMES.length);
  assert.equal(report.tradeToWaitCount, 0);
  assert.deepEqual(report.changedDecisions.map((d) => d.frameIndex), LONDON_EMIT_FRAMES);
  assert.equal(report.deltas.signalsEmitted, LONDON_EMIT_FRAMES.length);
});

// ── 3. Exact simulation over the frozen candles ─────────────────────────────

test("simulation: pinned target hit, holding time, and honest OPEN_AT_END", () => {
  const dataset = londonBreakoutDataset();
  const report = runBehavioralDiff(londonBreakoutStrategy, londonBreakoutStrategy, dataset, { now: NOW });
  const stats = report.baseline;

  // Trade 1 opens at frame 8 (08:00 close 1.1015, stop 1.0999, tp 1.1030)
  // and the 12:00 bar's 1.1032 high is the first target touch.
  assert.equal(stats.simulatedTrades.length, 2);
  const [t1, t2] = stats.simulatedTrades;
  assert.equal(t1.openedFrameIndex, 8);
  assert.equal(t1.closedFrameIndex, 12);
  assert.equal(t1.outcome, "TARGET_HIT");
  assert.equal(t1.ambiguousBar, false);
  approx(t1.entry, 1.1015);
  approx(t1.stopLoss, 1.0999);
  approx(t1.takeProfit, 1.103);
  // pnlR = tpDistance / stopDistance = 0.0015 / 0.0016
  approx(t1.pnlR, 0.0015 / 0.0016, 1e-6);
  assert.equal(t1.holdingMs, 4 * 3_600_000);

  // Trade 2 opens on the next emitting frame (13) and never reaches its
  // farther target — honest OPEN_AT_END, pnlR null, never marked-to-market.
  assert.equal(t2.openedFrameIndex, 13);
  assert.equal(t2.outcome, "OPEN_AT_END");
  assert.equal(t2.closedFrameIndex, null);
  assert.equal(t2.pnlR, null);
  assert.equal(t2.holdingMs, null);

  assert.equal(stats.closedTrades, 1);
  assert.equal(stats.targetHits, 1);
  assert.equal(stats.stopHits, 0);
  assert.equal(stats.openAtEnd, 1);
  approx(stats.grossPnlR, 0.0015 / 0.0016, 1e-6);
  assert.equal(stats.maxDrawdownR, 0);
  assert.equal(stats.avgHoldingMs, 4 * 3_600_000);
  assert.equal(stats.tradeFrequencyPerFrame, LONDON_EMIT_FRAMES.length / 16);
});

// ── 4. Costs are honest ─────────────────────────────────────────────────────

test("no cost model => cost figures null with typed reason, never zero", () => {
  const dataset = londonBreakoutDataset(null);
  const report = runBehavioralDiff(londonBreakoutStrategy, londonBreakoutStrategy, dataset, { now: NOW });
  assert.equal(report.baseline.totalCostR, null);
  assert.equal(report.baseline.costReason, "NO_COST_MODEL_IN_DATASET");
  assert.equal(report.deltas.totalCostR, null);
  assert.ok(report.notes.some((n) => n.includes("NO_COST_MODEL_IN_DATASET")));
});

test("declared cost model => per-trade spread cost in R", () => {
  const dataset = londonBreakoutDataset({ spreadPips: 1 }); // 1 pip = 0.0001 price units
  const report = runBehavioralDiff(londonBreakoutStrategy, londonBreakoutStrategy, dataset, { now: NOW });
  const stats = report.baseline;
  assert.equal(stats.costReason, null);
  const [t1, t2] = stats.simulatedTrades;
  approx(t1.costR, 0.0001 / 0.0016, 1e-6);                 // spread / stop distance
  assert.ok(t2.costR !== null && t2.costR > 0);
  approx(stats.totalCostR, (t1.costR as number) + (t2.costR as number), 1e-12);
  assert.equal(report.deltas.totalCostR, 0);
});

// ── 5. Per-frame change classes ─────────────────────────────────────────────

test("tighter-stop candidate => STOP_MOVED + CONFIDENCE_SHIFT per emitting frame", () => {
  const dataset = londonBreakoutDataset();
  const candidate = tighterStopVariant(londonBreakoutStrategy);
  const report = runBehavioralDiff(londonBreakoutStrategy, candidate, dataset, { now: NOW });

  assert.equal(report.changedDecisions.length, LONDON_EMIT_FRAMES.length);
  for (const d of report.changedDecisions) {
    assert.ok(d.classes.includes("STOP_MOVED"), d.classes.join(","));
    assert.ok(d.classes.includes("CONFIDENCE_SHIFT"), d.classes.join(","));
    assert.ok(!d.classes.includes("TARGET_MOVED"));
    assert.ok(!d.classes.includes("DIRECTION_FLIP"));
  }
  assert.equal(report.tradeToWaitCount, 0);
  assert.equal(report.waitToTradeCount, 0);
  assert.equal(report.deltas.signalsEmitted, 0);
  // Tighter stop => smaller average stop distance on the candidate side.
  assert.ok(report.candidate.avgStopDistance !== null && report.baseline.avgStopDistance !== null);
  assert.ok(report.candidate.avgStopDistance < report.baseline.avgStopDistance);
});

// ── Report journal fields ───────────────────────────────────────────────────

test("report carries journal identity fields and safety note", () => {
  const dataset = londonBreakoutDataset();
  const report: BehavioralDiffReport = runBehavioralDiff(
    londonBreakoutStrategy,
    confidenceFloorVariant(londonBreakoutStrategy, 75),
    dataset,
    { now: NOW, datasetHash: "deadbeef" },
  );
  assert.ok(report.reportId.includes(dataset.datasetId));
  assert.ok(report.reportId.includes("london-breakout@1.0.0"));
  assert.ok(report.reportId.includes("2.0.0-lab"));
  assert.equal(report.generatedAtIso, NOW.toISOString());
  assert.equal(report.datasetHash, "deadbeef");
  assert.ok(report.notes.some((n) => n.includes("changes no authority")));
});
