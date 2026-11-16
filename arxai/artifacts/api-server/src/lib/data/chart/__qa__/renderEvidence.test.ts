// Render Accuracy evidence (owner ruling 2026-11-09: reads, drawings and
// predictions must be accurate). Constructed fixtures only; the real judge,
// score update and handshake run.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordRenderEvidence, judgeRenderEvidence, applyRenderEvidence, __clearRenderEvidenceForTests,
  RENDER_EVIDENCE_TTL_MS, type RenderEvidenceReport, type RenderedProjection,
  recordIssuedProjection, projectionRoles,
} from "../renderEvidence.js";
import { withSubMetric } from "../chartTruthScore.js";
import { heikinAshiRun } from "../heikinAshiTransform.js";
import { buildChartHandshake } from "../chartHandshake.js";
import type { ChartIntelligenceState } from "../chartIntelligence.js";
import { closedCandlesOfState, evidenceOfState, recordStateCandleWindow } from "../stateCandleWindow.js";
import { recordStateTruthResult, truthResultOfState } from "../stateTruthResult.js";
import type { NormalizedChartCandle } from "../candleNormalization.js";

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
  priceRoundTripOk: true, timeRoundTripOk: true, visibleBarsRoundTripped: 120,
  drawings: { checked: 4, failed: 0, unplaced: 1, failedIds: [] }, projections: [], ...over,
});
const LEVELS = { entry: 1.1050, sl: 1.1020, tp: 1.1110, secondaryTp: 1.1140 };
const issue = (over: Record<string, unknown> = {}) => recordIssuedProjection(USER, {
  previewId: "pv-1", symbol: "EURUSD", timeframe: "M5", side: "BUY", levels: LEVELS,
  expiresAt: new Date(NOW + 300_000).toISOString(), ...over,
} as never, NOW);
const drawnProjection = (over: Partial<RenderedProjection> = {}, roles = projectionRoles(LEVELS)): RenderedProjection[] =>
  [...roles].map(([role, price]) => ({ previewId: "pv-1", symbol: "EURUSD", timeframe: "M5", role, price, axisRoundTripOk: true, ...over }));
const scoreOf = (report: RenderEvidenceReport) => {
  recordRenderEvidence(USER, report, null, NOW);
  const v = judgeRenderEvidence(USER, state, NOW);
  return v.status === "measured" ? v.score : v.status;
};
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

test("no visible bar round-tripped is unavailable, never a pass", () => {
  assert.equal(scoreOf(exact({ timeRoundTripOk: null, visibleBarsRoundTripped: 0 })), "unavailable");
  assert.equal(scoreOf(exact({ visibleBarsRoundTripped: 0 })), "unavailable");
});

test("a drawing read back away from its stored anchors fails the read", () => {
  assert.equal(scoreOf(exact()), 100);
  const v = (recordRenderEvidence(USER, exact({ drawings: { checked: 4, failed: 1, unplaced: 0, failedIds: ["fib-1"] } }), null, NOW),
    judgeRenderEvidence(USER, state, NOW));
  assert.equal(v.status === "measured" && v.score, 0);
  assert.match(v.detail, /fib-1/);
});

// ── Heikin Ashi: the server re-derives the transform itself ────────────────
const NEWEST_SEC = Date.parse(NEWEST_OPEN) / 1000;
const SRC: [number, number, number, number][] = Array.from({ length: 12 }, (_, i) => {
  const o = 1.1 + i * 0.0003, c = o + (i % 3 === 0 ? -0.0002 : 0.0004);
  return [o, Math.max(o, c) + 0.0005, Math.min(o, c) - 0.0004, c];
});
const haState = {
  ...state,
  latestClosedCandle: { openTime: NEWEST_OPEN, open: SRC[11]![0], high: SRC[11]![1], low: SRC[11]![2], close: SRC[11]![3] },
} as unknown as ChartIntelligenceState;
const haDrawn = (seed: { open: number; close: number } | null) => heikinAshiRun(SRC.map(([open, high, low, close]) => ({ open, high, low, close })), seed)
  .map(b => [b.open, b.high, b.low, b.close] as [number, number, number, number]);
const haReport = (over: Partial<RenderEvidenceReport> = {}, drawn = haDrawn(null), seed: { open: number; close: number } | null = null) => exact({
  displayMode: "heikinAshi", transform: "heikinAshi", transformVerified: true,
  transformCheck: { seed, samples: SRC.map((source, i) => ({ time: NEWEST_SEC - (11 - i) * 300, source, drawn: drawn[i]! })) },
  ...over,
});
const haJudge = (report: RenderEvidenceReport) => { recordRenderEvidence(USER, report, null, NOW); return judgeRenderEvidence(USER, haState, NOW); };

test("Heikin Ashi: an exact draw the server re-derives itself measures 100 and is labelled not tradable", () => {
  const v = haJudge(haReport());
  assert.equal(v.status === "measured" && v.score, 100, v.detail);
  assert.match(v.detail, /Heikin Ashi transform of the source/);
  assert.match(v.detail, /server re-derived the newest 12 Heikin Ashi bar/);
  assert.match(v.detail, /not tradable prices/);
  // A window that starts mid-series carries the HA seed before it.
  const seed = { open: 1.0995, close: 1.1001 };
  assert.equal((v => v.status === "measured" && v.score)(haJudge(haReport({}, haDrawn(seed), seed))), 100);
});

test("Heikin Ashi: the verdict Eleanor's read carries never quotes an HA value as a price", () => {
  const v = haJudge(haReport());
  const haValues = haDrawn(null).flat().map(x => x.toFixed(5));
  for (const value of haValues) assert.ok(!v.detail.includes(value), `verdict quotes HA value ${value}`);
});

test("Heikin Ashi: one drawn bar off the server's transform is a measured FAIL even if the chart says verified", () => {
  const drawn = haDrawn(null);
  drawn[5] = [drawn[5]![0], drawn[5]![1], drawn[5]![2], drawn[5]![3] + 0.00001];
  const v = haJudge(haReport({}, drawn));
  assert.equal(v.status === "measured" && v.score, 0);
  assert.match(v.detail, /1 drawn Heikin Ashi bar\(s\) differ from the server's own transform/);
});

test("Heikin Ashi: the chart's own failed transform check or bar mismatch fails", () => {
  assert.equal((v => v.status === "measured" && v.score)(haJudge(haReport({ transformVerified: false }))), 0);
  assert.equal((v => v.status === "measured" && v.score)(haJudge(haReport({ mismatchedBars: 1 }))), 0);
});

test("Heikin Ashi: no transform check → unavailable (never a pass); with a known mismatch → FAIL", () => {
  assert.equal(haJudge(exact({ displayMode: "heikinAshi" })).status, "unavailable");
  assert.match(haJudge(exact({ displayMode: "heikinAshi" })).detail, /did not report its transform check/);
  assert.equal((v => v.status === "measured" && v.score)(haJudge(exact({ displayMode: "heikinAshi", mismatchedBars: 1 }))), 0);
});

test("Heikin Ashi: samples that do not carry the served closed candle are unbound", () => {
  const moved = haReport();
  moved.transformCheck!.samples[11]!.source = [SRC[11]![0], SRC[11]![1], SRC[11]![2], SRC[11]![3] + 0.0001];
  assert.equal(haJudge(moved).status, "unbound");
  const unordered = haReport();
  unordered.transformCheck!.samples.reverse();
  assert.notEqual((v => v.status === "measured" && v.score)(haJudge(unordered)), 100);
});

test("a projection drawn exactly at the levels the server issued passes", () => {
  issue();
  assert.equal(scoreOf(exact({ projections: drawnProjection() })), 100);
});

test("a projection drawn off its issued price, partially, twice or unissued fails", () => {
  issue();
  const exactDraw = drawnProjection();
  const cases: [string, RenderedProjection[]][] = [
    ["entry shifted one pip", exactDraw.map(p => p.role === "entry" ? { ...p, price: p.price + 0.0001 } : p)],
    ["stop missing", exactDraw.filter(p => p.role !== "sl")],
    ["target drawn twice", [...exactDraw, exactDraw.find(p => p.role === "tp")!]],
    ["unknown role", [...exactDraw, { ...exactDraw[0]!, role: "tp3" }]],
    ["never issued", drawnProjection({ previewId: "pv-forged" })],
    ["other timeframe", drawnProjection({ timeframe: "M15" })],
    ["axis does not map back", exactDraw.map(p => p.role === "tp" ? { ...p, axisRoundTripOk: false } : p)],
  ];
  for (const [name, projections] of cases) assert.equal(scoreOf(exact({ projections })), 0, name);
});

test("projections bind to the issuing user, chart and expiry", () => {
  issue({ timeframe: "M15" });
  assert.equal(scoreOf(exact({ projections: drawnProjection({ timeframe: "M15" }) })), 0, "issued for M15, drawn on the M5 chart");
  __clearRenderEvidenceForTests();
  recordIssuedProjection(USER + 1, { previewId: "pv-1", symbol: "EURUSD", timeframe: "M5", side: "BUY", levels: LEVELS,
    expiresAt: new Date(NOW + 300_000).toISOString() }, NOW);
  assert.equal(scoreOf(exact({ projections: drawnProjection() })), 0, "another user's preview");
  __clearRenderEvidenceForTests();
  issue({ expiresAt: new Date(NOW - RENDER_EVIDENCE_TTL_MS - 1).toISOString() });
  assert.equal(scoreOf(exact({ projections: drawnProjection() })), 0, "expired preview still drawn");
  __clearRenderEvidenceForTests();
  issue({ levels: null });
  assert.equal(scoreOf(exact({ projections: drawnProjection() })), 0, "a refusal draws nothing to match");
});

test("projection roles mirror the dashboard's drawn overlays (no secondary target → no tp2)", () => {
  const roles = projectionRoles({ ...LEVELS, secondaryTp: null });
  assert.deepEqual([...roles.keys()].sort(),
    ["entry", "reward-zone:max", "reward-zone:min", "risk-zone:max", "risk-zone:min", "sl", "tp"]);
  assert.equal(roles.get("risk-zone:min"), LEVELS.sl);
  assert.equal(roles.get("reward-zone:max"), LEVELS.tp);
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

test("evidence expires (fail-closed TTL)", () => {
  recordRenderEvidence(USER, exact(), null, NOW);
  assert.equal(judgeRenderEvidence(USER, state, NOW + RENDER_EVIDENCE_TTL_MS + 1).status, "absent");
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

test("render-evidence enrichment preserves the measured closed window and its truth basis", () => {
  const base = { subMetrics: [{ key: "render_accuracy", label: "Render Accuracy", weight: 0.07, rawScore: null,
    weightedScore: null, evidenceStatus: "unavailable", detail: "x" }], score: 0, label: "Read-blocked",
    evidenceCoverage: 0, unmeasuredKeys: ["render_accuracy"], primaryConcern: null, note: "" } as never;
  const evidence = { source: "mt5_broker", symbol: "EURUSD", timeframe: "M5", identity: "scope-1" } as never;
  const rawTruth = { barsAnalyzed: 1, source: "mt5_broker" } as never;
  const candle = {
    symbol: "EURUSD", displaySymbol: "EURUSD", providerSymbol: "EURUSD", brokerSymbol: "EURUSD", timeframe: "M5", openTime: NEWEST_OPEN,
    closeTime: "2026-11-09T12:00:00.000Z", open: 1.1, high: 1.101, low: 1.099, close: 1.1005,
    volume: 12, tickVolume: null, source: "mt5_broker", sourceMode: "live", priceBasis: "BID",
    isComplete: true, isFinal: true, isForming: false, receivedAt: "2026-11-09T12:00:00.000Z",
    qualityFlags: [],
  } as NormalizedChartCandle;
  const original = {
    ...state,
    latestClosedCandle: { openTime: NEWEST_OPEN, closeTime: candle.closeTime, open: candle.open, high: candle.high, low: candle.low, close: candle.close },
    candleStats: { barsAnalyzed: 1 },
    chartTruthScore: base,
  } as unknown as ChartIntelligenceState;
  recordStateCandleWindow(original, [candle], evidence);
  recordStateTruthResult(original, rawTruth);
  recordRenderEvidence(USER, exact(), null, NOW);

  const enriched = applyRenderEvidence(original, USER, NOW);
  assert.notEqual(enriched, original, "applying the render score creates the immutable enriched state");
  assert.equal(enriched.chartTruthScore.subMetrics[0]!.evidenceStatus, "measured");
  assert.equal(closedCandlesOfState(enriched).length, 1);
  assert.deepEqual(closedCandlesOfState(enriched), [{
    time: NEWEST_OPEN, open: 1.1, high: 1.101, low: 1.099, close: 1.1005, volume: 12,
  }]);
  assert.deepEqual(evidenceOfState(enriched), evidence);
  assert.equal(truthResultOfState(enriched), rawTruth);
  assert.equal(enriched.candleStats.barsAnalyzed, closedCandlesOfState(enriched).length);
});

test("unmeasured render evidence preserves window metadata without manufacturing a measurement", () => {
  const base = { subMetrics: [{ key: "render_accuracy", label: "Render Accuracy", weight: 0.07, rawScore: null,
    weightedScore: null, evidenceStatus: "unavailable", detail: "not checked" }], score: 0, label: "Read-blocked",
    evidenceCoverage: 0, unmeasuredKeys: ["render_accuracy"], primaryConcern: null, note: "" } as never;
  const evidence = { source: "mt5_broker", symbol: "EURUSD", timeframe: "M5", identity: "scope-2" } as never;
  const rawTruth = { barsAnalyzed: 1, source: "mt5_broker" } as never;
  const candle = {
    symbol: "EURUSD", displaySymbol: "EURUSD", providerSymbol: "EURUSD", brokerSymbol: "EURUSD", timeframe: "M5", openTime: NEWEST_OPEN,
    closeTime: "2026-11-09T12:00:00.000Z", open: 1.1, high: 1.101, low: 1.099, close: 1.1005,
    volume: 12, tickVolume: null, source: "mt5_broker", sourceMode: "live", priceBasis: "BID",
    isComplete: true, isFinal: true, isForming: false, receivedAt: "2026-11-09T12:00:00.000Z",
    qualityFlags: [],
  } as NormalizedChartCandle;
  const original = {
    ...state,
    latestClosedCandle: { openTime: NEWEST_OPEN, closeTime: candle.closeTime, open: candle.open, high: candle.high, low: candle.low, close: candle.close },
    candleStats: { barsAnalyzed: 1 },
    chartTruthScore: base,
  } as unknown as ChartIntelligenceState;
  recordStateCandleWindow(original, [candle], evidence);
  recordStateTruthResult(original, rawTruth);

  const enriched = applyRenderEvidence(original, USER, NOW);
  assert.notEqual(enriched, original);
  assert.equal(judgeRenderEvidence(USER, enriched, NOW).status, "absent");
  assert.equal(enriched.chartTruthScore.subMetrics[0]!.rawScore, null);
  assert.equal(closedCandlesOfState(enriched).length, 1);
  assert.deepEqual(evidenceOfState(enriched), evidence);
  assert.equal(truthResultOfState(enriched), rawTruth);
});
