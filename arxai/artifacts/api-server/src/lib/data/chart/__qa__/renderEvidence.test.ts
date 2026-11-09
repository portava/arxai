// Render Accuracy evidence (owner ruling 2026-11-09: reads, drawings and
// predictions must be accurate). Constructed fixtures only; the real judge,
// score update and handshake run.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordRenderEvidence, judgeRenderEvidence, applyRenderEvidence, __clearRenderEvidenceForTests,
  RENDER_EVIDENCE_TTL_MS, type RenderEvidenceReport,
} from "../renderEvidence.js";
import { withSubMetric } from "../chartTruthScore.js";
import { buildChartHandshake } from "../chartHandshake.js";
import type { ChartIntelligenceState } from "../chartIntelligence.js";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const NEWEST_OPEN = "2026-11-09T11:55:00Z";
const USER = 7;
const state = {
  symbol: "EURUSD", timeframe: "M5",
  truthState: { source: "mt5_broker" },
  currentCandle: null,
  latestClosedCandle: { openTime: NEWEST_OPEN },
} as unknown as ChartIntelligenceState;
const exact = (over: Partial<RenderEvidenceReport> = {}): RenderEvidenceReport => ({
  symbol: "EURUSD", timeframe: "M5", source: "mt5_broker", displayMode: "ohlc",
  newestBarTime: Date.parse(NEWEST_OPEN) / 1000, barsCompared: 300, mismatchedBars: 0, droppedBars: 0,
  priceRoundTripOk: true, timeRoundTripOk: true, ...over,
});
beforeEach(() => __clearRenderEvidenceForTests());

test("no report → absent (unmeasured, never a pass)", () => {
  assert.equal(judgeRenderEvidence(USER, state, NOW).status, "absent");
});

test("an exact draw of the served series measures 100", () => {
  recordRenderEvidence(USER, exact(), null, NOW);
  const v = judgeRenderEvidence(USER, state, NOW);
  assert.equal(v.status, "measured");
  assert.equal(v.status === "measured" && v.score, 100);
});

test("any mismatch, dropped bar or failed round-trip measures a FAIL (0)", () => {
  for (const over of [{ mismatchedBars: 1 }, { droppedBars: 2 }, { priceRoundTripOk: false }, { timeRoundTripOk: false }]) {
    recordRenderEvidence(USER, exact(over), null, NOW);
    const v = judgeRenderEvidence(USER, state, NOW);
    assert.equal(v.status === "measured" && v.score, 0, JSON.stringify(over));
  }
});

test("off-screen newest bar leaves the time axis unmeasured, not failed", () => {
  recordRenderEvidence(USER, exact({ timeRoundTripOk: null }), null, NOW);
  const v = judgeRenderEvidence(USER, state, NOW);
  assert.equal(v.status === "measured" && v.score, 100);
});

test("evidence binds only to this user, source, symbol, timeframe and bar window", () => {
  recordRenderEvidence(USER, exact(), null, NOW);
  assert.equal(judgeRenderEvidence(USER + 1, state, NOW).status, "absent");
  recordRenderEvidence(USER, exact({ source: "deriv" }), null, NOW);
  assert.equal(judgeRenderEvidence(USER, state, NOW).status, "unbound");
  recordRenderEvidence(USER, exact({ newestBarTime: Date.parse(NEWEST_OPEN) / 1000 - 600 }), null, NOW);
  assert.equal(judgeRenderEvidence(USER, state, NOW).status, "unbound");
  recordRenderEvidence(USER, exact({ timeframe: "M15" }), null, NOW);
  recordRenderEvidence(USER, exact({ symbol: "GBPUSD" }), null, NOW);
  // The M5/EURUSD slot still holds the 600s-old window report → unbound.
  assert.equal(judgeRenderEvidence(USER, state, NOW).status, "unbound");
});

test("evidence from another feed-scope bridge does not count for this reader", () => {
  recordRenderEvidence(USER, exact(), 42, NOW);
  assert.equal(judgeRenderEvidence(USER, state, NOW).status, "absent", "bridge 42's draw is not the shared series' draw");
});

test("evidence expires and Heikin Ashi is never a price-faithful pass", () => {
  recordRenderEvidence(USER, exact(), null, NOW);
  assert.equal(judgeRenderEvidence(USER, state, NOW + RENDER_EVIDENCE_TTL_MS + 1).status, "absent");
  recordRenderEvidence(USER, exact({ displayMode: "heikinAshi" }), null, NOW);
  assert.equal(judgeRenderEvidence(USER, state, NOW).status, "unavailable");
});

test("measured evidence turns RenderHealth PASS; a measured mismatch fails it", () => {
  const base = { subMetrics: [{ key: "render_accuracy", label: "Render Accuracy", weight: 0.07, rawScore: null,
    weightedScore: null, evidenceStatus: "unavailable", detail: "x" }], score: 0, label: "Read-blocked",
    evidenceCoverage: 0, unmeasuredKeys: ["render_accuracy"], primaryConcern: null, note: "" } as never;
  const withState = { ...state, chartTruthScore: base } as ChartIntelligenceState;
  recordRenderEvidence(USER, exact(), null, NOW);
  const ok = applyRenderEvidence(withState, USER, NOW).chartTruthScore;
  assert.equal(ok.subMetrics[0]!.evidenceStatus, "measured");
  assert.equal(ok.subMetrics[0]!.rawScore, 100);
  const gate = {} as never;
  assert.equal(buildChartHandshake(gate, ok).RenderHealth, "PASS");
  recordRenderEvidence(USER, exact({ mismatchedBars: 3 }), null, NOW);
  const bad = applyRenderEvidence(withState, USER, NOW).chartTruthScore;
  assert.equal(buildChartHandshake(gate, bad).RenderHealth, "FAIL");
  assert.equal(withSubMetric(base, "missing_key", 100, "n").subMetrics.length, 1, "unknown key is a no-op");
});
