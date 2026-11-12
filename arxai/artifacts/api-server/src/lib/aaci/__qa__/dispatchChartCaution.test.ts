// AACI autonomous dispatch advisory — chart inputs are never looser than the
// pre-round-3 base (16c8a1a0).
// Run via:
//   node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//     src/lib/aaci/__qa__/dispatchChartCaution.test.ts
//
// The shared AACI snapshot now carries the chart's structure-clarity read as
// Market Truth structure (it used to carry the Chart Truth data-quality score).
// That is the truthful label for the user-facing reads, but the self-trade
// agent's dispatch advisory scores the same snapshot, and its proceed /
// prepare-only / size decision must never get looser from the change. These
// tests drive the real evaluateAaciExecutionAdvisory with the snapshot read and
// the decision composer replaced, and check what the decision scored.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  computeFreshness,
  computeMarketTruth,
  type AaciSharedTruthSnapshot,
} from "@workspace/domain/aaci";
import { smartChartFromState as realSmartChartFromState } from "../snapshotService.js";
import type { ChartIntelligenceState } from "../../data/chart/chartIntelligence.js";

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

interface StateOpts {
  chartTruthScore: number;
  structureClarity: number | null;
  populated?: boolean;
  aiUsable?: boolean;
  stale?: boolean;
  latestClosedCloseTime?: string | null;
}

function chartState(o: StateOpts): ChartIntelligenceState {
  const stale = o.stale ?? false;
  const subMetrics = o.structureClarity === null
    ? []
    : [{ key: "structure_clarity", label: "Structure Clarity", rawScore: o.structureClarity, detail: "" }];
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    aiUsable: o.aiUsable ?? true,
    stale,
    lastUpdated: iso(NOW),
    truthState: { lastTickTime: iso(NOW - 200), lastCandleTime: null, stale },
    latestClosedCandle: o.latestClosedCloseTime ? { closeTime: o.latestClosedCloseTime } : null,
    marketUnderstanding: { populated: o.populated ?? true },
    decisionState: { bias: "bullish", actionability: "stand_aside" },
    chartReadScore: { score: 50, subMetrics },
    gateOutput: { chartTruthScore: o.chartTruthScore, confidentReadAllowed: true },
  } as unknown as ChartIntelligenceState;
}

// The snapshot the real builder makes from a cached chart state (chart block
// from the real smartChartFromState; handshake score as buildChartHandshake
// copies it from the same gate output).
function snapshotFromState(state: ChartIntelligenceState): AaciSharedTruthSnapshot {
  return {
    snapshotId: "t",
    timestamp: iso(NOW),
    user: { userId: "7", role: "system" },
    symbolContext: { selectedSymbol: "EURUSD" },
    account: {},
    bridge: { status: "unknown" },
    positions: { openCount: 0 },
    scanner: { score: 72, lastUpdated: iso(NOW) },
    smartChart: realSmartChartFromState(state),
    chartHandshake: {
      overall: "WARN",
      chartTruthScore: state.gateOutput.chartTruthScore,
    } as AaciSharedTruthSnapshot["chartHandshake"],
  };
}

// The same snapshot as the 16c8a1a0 builder made it: structure carried the
// Chart Truth score and no candle close time was set.
function legacySnapshot(snap: AaciSharedTruthSnapshot, state: ChartIntelligenceState): AaciSharedTruthSnapshot {
  const { lastCandleTime: _dropped, ...chart } = snap.smartChart!;
  return { ...snap, smartChart: { ...chart, structureScore: state.gateOutput.chartTruthScore } };
}

let nextSnapshot: AaciSharedTruthSnapshot | null = null;
const scored: AaciSharedTruthSnapshot[] = [];
const contexts: Array<{ timeframe?: string; setupType?: string }> = [];
const snapshotTimeframes: Array<string | undefined> = [];

mock.module("../snapshotService.js", {
  namedExports: {
    buildAaciSnapshot: async (input: { timeframe?: string }) => { snapshotTimeframes.push(input.timeframe); return structuredClone(nextSnapshot); },
    smartChartFromState: realSmartChartFromState,
  },
});
mock.module("../decisionService.js", {
  namedExports: {
    buildAaciDecision: async (input: { snapshot: AaciSharedTruthSnapshot; timeframe?: string; setupType?: string }) => {
      scored.push(input.snapshot);
      contexts.push({ timeframe: input.timeframe, setupType: input.setupType });
      return {
        decisionId: "d",
        timestamp: iso(NOW),
        actorType: "self_trade_agent",
        actionRequested: "AUTONOMOUS_EXECUTE",
        hardGatePass: true,
        hardGateFailures: [],
        finalAaciScore: 72,
        recommendedAction: "ALLOW_REDUCED_SIZE",
        explanation: "x",
        userFacingExplanation: "x",
      };
    },
  },
});
mock.module("../../security/handshake.js", {
  namedExports: {
    consultSecurityHandshake: async () => ({
      verdict: { securityHandshakePass: true },
      autonomy: null,
    }),
  },
});

const { evaluateAaciExecutionAdvisory } = await import("../executionAdvisory.js");

async function scoredSnapshotFor(state: ChartIntelligenceState): Promise<AaciSharedTruthSnapshot> {
  nextSnapshot = snapshotFromState(state);
  scored.length = 0;
  await evaluateAaciExecutionAdvisory({
    executingUserId: 7,
    agentId: 1,
    agentKey: "agent-1",
    funded: true,
    active: true,
    symbol: "EURUSD",
  });
  assert.equal(scored.length, 1, "the advisory composed exactly one decision");
  return scored[0]!;
}

test("a strongly trending market on a data-quality score of 75 does not raise the dispatch Market Truth", async () => {
  const state = chartState({ chartTruthScore: 75, structureClarity: 100 });
  const snap = await scoredSnapshotFor(state);
  const legacy = legacySnapshot(snapshotFromState(state), state);
  assert.ok(
    computeMarketTruth(snap) <= computeMarketTruth(legacy),
    `dispatch M ${computeMarketTruth(snap)} must not exceed the 16c8a1a0 M ${computeMarketTruth(legacy)}`,
  );
  assert.equal(snap.smartChart?.structureScore, 75);
});

test("a low data-quality score is still counted when the structure read is unknown", async () => {
  for (const state of [
    chartState({ chartTruthScore: 40, structureClarity: 90, populated: false }),
    chartState({ chartTruthScore: 40, structureClarity: 90, aiUsable: false }),
    chartState({ chartTruthScore: 40, structureClarity: 90, stale: true }),
    chartState({ chartTruthScore: 40, structureClarity: null }),
  ]) {
    const snap = await scoredSnapshotFor(state);
    const legacy = legacySnapshot(snapshotFromState(state), state);
    assert.equal(snap.smartChart?.structureScore, 40, "unknown structure falls back to the old input, never dropped");
    assert.ok(computeMarketTruth(snap) <= computeMarketTruth(legacy));
  }
});

test("a weaker structure read still lowers the dispatch Market Truth (min of both)", async () => {
  const state = chartState({ chartTruthScore: 75, structureClarity: 30 });
  const snap = await scoredSnapshotFor(state);
  assert.equal(snap.smartChart?.structureScore, 30);
});

test("the dispatch path never scores a structure input above the old one, across a grid of states", async () => {
  for (const chartTruthScore of [0, 35, 62, 75, 100]) {
    for (const structureClarity of [null, 0, 40, 70, 100]) {
      const state = chartState({ chartTruthScore, structureClarity });
      const snap = await scoredSnapshotFor(state);
      const legacy = legacySnapshot(snapshotFromState(state), state);
      assert.ok(
        computeMarketTruth(snap) <= computeMarketTruth(legacy),
        `ct=${chartTruthScore} clarity=${structureClarity}: ${computeMarketTruth(snap)} > ${computeMarketTruth(legacy)}`,
      );
    }
  }
});

test("the user-facing snapshot keeps the truthful structure read", () => {
  const state = chartState({ chartTruthScore: 75, structureClarity: 100 });
  assert.equal(realSmartChartFromState(state).structureScore, 100);
});

// ── Candle freshness (6ac9000a) ─────────────────────────────────────────────
// At 16c8a1a0 the snapshot never carried a candle close time, so the candle
// source always scored the honest-unknown 25 and always counted as stale. The
// truthful close time may now lower that on the dispatch path (an old bar),
// but a just-closed bar must not raise F or drop out of the stale sources.

const candle = (snap: AaciSharedTruthSnapshot, nowMs: number) =>
  computeFreshness(snap, nowMs).records.find((r) => r.source === "candle")!;

test("a just-closed bar does not raise the dispatch freshness score or leave the stale sources", async () => {
  for (const closedAgoMs of [0, 500, 2_000, 2_999, 4_000]) {
    const state = chartState({
      chartTruthScore: 75,
      structureClarity: 60,
      latestClosedCloseTime: iso(NOW - closedAgoMs),
    });
    // The user-facing snapshot carries the real close time.
    assert.equal(realSmartChartFromState(state).lastCandleTime, iso(NOW - closedAgoMs));
    const snap = await scoredSnapshotFor(state);
    const legacy = legacySnapshot(snapshotFromState(state), state);
    const nowMs = Date.now();
    const rec = candle(snap, nowMs);
    const old = candle(legacy, nowMs);
    assert.ok(rec.score <= old.score, `closed ${closedAgoMs}ms ago: candle ${rec.score} > old ${old.score}`);
    assert.equal(rec.stale, true, `closed ${closedAgoMs}ms ago: candle must stay stale on the dispatch path`);
    const f = computeFreshness(snap, nowMs);
    const fOld = computeFreshness(legacy, nowMs);
    assert.ok(f.score <= fOld.score, `F ${f.score} > old F ${fOld.score}`);
    assert.ok(f.staleSources.length >= fOld.staleSources.length);
  }
});

test("an old closed bar keeps its lower candle score on the dispatch path", async () => {
  const state = chartState({
    chartTruthScore: 75,
    structureClarity: 60,
    latestClosedCloseTime: iso(NOW - 60_000),
  });
  const snap = await scoredSnapshotFor(state);
  const rec = candle(snap, Date.now());
  assert.equal(rec.stale, true);
  assert.equal(rec.score, 0, "a bar a minute old scores below the old unknown 25");
});


test("execution advisory preserves the persisted timeframe and outcome classifier", async () => {
  nextSnapshot = snapshotFromState(chartState({ chartTruthScore: 75, structureClarity: 100 }));
  snapshotTimeframes.length = contexts.length = 0;
  await evaluateAaciExecutionAdvisory({ executingUserId: 7, agentId: 1, agentKey: "agent-1", funded: true, active: true,
    symbol: "EURUSD", timeframe: "M5", setupType: "Breakout" });
  assert.deepEqual(snapshotTimeframes, ["M5"]);
  assert.deepEqual(contexts, [{ timeframe: "M5", setupType: "Breakout" }]);
});

test("unsupported timeframe withholds dispatch instead of scoring a substitute timeframe", async () => {
  snapshotTimeframes.length = contexts.length = 0;
  const result = await evaluateAaciExecutionAdvisory({ executingUserId: 7, agentId: 1, agentKey: "agent-1", funded: true, active: true,
    symbol: "EURUSD", timeframe: "M2", setupType: "Breakout" });
  assert.equal(result.decision, null);
  assert.equal(result.advisory.proceed, false);
  assert.equal(result.advisory.downgradeToPrepareOnly, true);
  assert.deepEqual(snapshotTimeframes, []);
  assert.deepEqual(contexts, []);
});
