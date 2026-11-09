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

test("Heikin Ashi is measured against its own transform: exact → 100, mismatch → 0", () => {
  assert.equal(scoreOf(exact({ displayMode: "heikinAshi" })), 100);
  const v = judgeRenderEvidence(USER, state, NOW);
  assert.match(v.detail, /Heikin Ashi transform of the source/);
  assert.equal(scoreOf(exact({ displayMode: "heikinAshi", mismatchedBars: 1 })), 0);
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
