// Truth snapshot per-claim evidence classes (server side).
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence
//
// Proves the snapshot's additive `evidence` block is produced from the facts the
// brain already has, through the REAL composer path with deterministic offline
// SOURCE stand-ins (no DB, network or broker):
//   - direct live observations are "verified" with their DATA timestamp;
//   - every heuristic read / level / verdict is at best "estimate";
//   - a stale feed makes its claims "stale"; a missing feed / calendar /
//     component is "unavailable" (never a value);
//   - post-cache expiry turns derived claims "stale" without touching data time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRubyMarketEdge, type SignalEngineInput } from "@workspace/domain/signal-intelligence";
import {
  buildSymbolTruthSnapshot,
  capExpiredTruthSnapshot,
  classifySnapshotEvidence,
  type SymbolTruthSnapshot,
  type TruthSnapshotDeps,
} from "../symbolTruthSnapshot.js";
import { NOW, marketFixture } from "./marketEvidenceFixtures.js";

const fixture = marketFixture();
const absent = async (): Promise<never> => { throw new Error("offline unavailable"); };
const inputs: SignalEngineInput = { symbol: "EURUSD", displayName: "EURUSD", timeframe: "M15", assetClass: "forex", candles: fixture.result.candles,
  currentPrice: 1.098, dataSource: "LIVE_FEED", scanner: { bias: "bullish", recommendedAction: "BUY", confidenceScore: 85, entrySniperScore: 85, riskRewardRatio: 2,
    setupType: "Trend", entry: 1.098, entryZone: { from: 1.0978, to: 1.0982 }, stopLoss: 1.097, takeProfit: 1.1, reasonForTrade: "", reasonToAvoid: "" },
  scalp: null, execution: null, newsRiskLevel: null, previous: null, now: NOW };
function signal() {
  return { ...buildRubyMarketEdge(inputs), marketEvidence: { ...fixture.evidence, userId: 1 } };
}
function snapshot(over: Partial<TruthSnapshotDeps> = {}) {
  return buildSymbolTruthSnapshot("EURUSD", "M15", 1, {
    getChartCandlesFn: async () => fixture.chart as never, buildNewsFn: absent,
    evaluateScalpFn: absent, computeTimingFn: absent, buildScannerFn: async () => signal() as never, ...over,
  });
}
const connectedCalendar = async () => ({
  radar: { symbol: "EURUSD", provider: { connected: true, name: "test-calendar", note: "" }, events: [], topSeverity: null, highImpactWindowActive: false, summary: "" },
  behavior: { mode: "NORMAL", note: "" },
}) as never;

function derivedClaims(s: SymbolTruthSnapshot) {
  const e = s.evidence;
  return [e.components.scanner, e.components.flame, e.components.timing, e.components.scalp, e.levels, e.verdict];
}

test("live matching read: direct observations verified, calculations estimates, absences unavailable", async () => {
  const s = await snapshot();
  assert.equal(s.data.state, "LIVE_CONFIRMED");
  assert.deepEqual(s.evidence.price, { evidenceClass: "verified", reason: "LIVE_FEED_OBSERVATION", observedAt: s.data.lastCandleAt });
  assert.deepEqual(s.evidence.lastCandle, { evidenceClass: "verified", reason: "LIVE_FEED_OBSERVATION", observedAt: s.data.lastCandleAt });
  assert.deepEqual(s.evidence.lastTick, { evidenceClass: "verified", reason: "LIVE_FEED_OBSERVATION", observedAt: s.data.lastTickAt });

  assert.equal(s.components.scanner.present, true);
  assert.deepEqual(s.evidence.components.scanner, { evidenceClass: "estimate", reason: "MODEL_ESTIMATE", observedAt: fixture.evidence.lastClosedCandleAt });
  for (const k of ["flame", "timing", "scalp"] as const) {
    assert.equal(s.components[k].present, false);
    assert.deepEqual(s.evidence.components[k], { evidenceClass: "unavailable", reason: "COMPONENT_ABSENT", observedAt: null });
  }
  for (const c of derivedClaims(s)) assert.notEqual(c.evidenceClass, "verified");
  assert.equal(s.evidence.levels.reason, s.levels.withheld ? "LEVELS_WITHHELD" : "MODEL_ESTIMATE");
  assert.equal(s.evidence.verdict.reason, s.verdict.bias === "UNKNOWN" ? "INSUFFICIENT_DATA" : "MODEL_ESTIMATE");
  assert.deepEqual(s.evidence.news, { evidenceClass: "unavailable", reason: "NO_CALENDAR", observedAt: null });
});

test("observedAt is a data timestamp, never the snapshot build time", async () => {
  const s = await snapshot();
  const all = [s.evidence.price, s.evidence.lastCandle, s.evidence.lastTick, s.evidence.news, ...derivedClaims(s)];
  for (const c of all) assert.notEqual(c.observedAt, s.generatedAt);
});

test("connected calendar without a fetch time is an estimate, never verified", async () => {
  const s = await snapshot({ buildNewsFn: connectedCalendar });
  assert.equal(s.news.providerConnected, true);
  assert.deepEqual(s.evidence.news, { evidenceClass: "estimate", reason: "CALENDAR_FETCH_TIME_UNKNOWN", observedAt: null });
});

test("a stale feed makes every claim resting on it stale", async () => {
  const stale = marketFixture({ ageMs: 3_600_000 });
  const s = await snapshot({ getChartCandlesFn: async () => stale.chart as never });
  assert.equal(s.data.state, "STALE");
  for (const c of [s.evidence.price, s.evidence.lastCandle, s.evidence.lastTick]) {
    assert.equal(c.evidenceClass, "stale"); assert.equal(c.reason, "FEED_STALE");
  }
  for (const c of derivedClaims(s)) assert.ok(c.evidenceClass === "stale" || c.evidenceClass === "unavailable", c.reason);
});

test("a failed chart source leaves every claim unavailable — nothing coerced to a value", async () => {
  const s = await snapshot({ getChartCandlesFn: absent, buildScannerFn: absent });
  assert.equal(s.data.state, "UNAVAILABLE");
  assert.equal(s.data.price, null);
  for (const c of [s.evidence.price, s.evidence.lastCandle, s.evidence.lastTick, ...derivedClaims(s)]) {
    assert.equal(c.evidenceClass, "unavailable", c.reason);
  }
  assert.equal(s.evidence.price.reason, "NO_VALUE");
  assert.equal(s.evidence.verdict.reason, "INSUFFICIENT_DATA");
});

test("the classification is a pure function of the snapshot's own visible fields", async () => {
  for (const s of [await snapshot(), await snapshot({ buildNewsFn: connectedCalendar }), await snapshot({ getChartCandlesFn: absent })]) {
    const { evidence, ...rest } = s;
    assert.deepEqual(classifySnapshotEvidence(rest, NOW), evidence);
  }
});

test("post-cache expiry turns derived claims stale and keeps data claims and timestamps", async () => {
  const s = signal(); s.expiresAt = new Date(NOW + 2000).toISOString();
  const before = await snapshot({ buildScannerFn: async () => s as never });
  assert.equal(before.evidence.components.scanner.evidenceClass, "estimate");
  const after = capExpiredTruthSnapshot(before, Date.parse(before.validUntil!));
  assert.deepEqual(after.evidence.components.scanner, { evidenceClass: "stale", reason: "EXPIRED", observedAt: before.evidence.components.scanner.observedAt });
  if (before.evidence.verdict.evidenceClass === "estimate") assert.equal(after.evidence.verdict.reason, "EXPIRED");
  assert.deepEqual(after.evidence.price, before.evidence.price);
  assert.deepEqual(after.evidence.components.timing, before.evidence.components.timing, "never-present stays unavailable");
  for (const c of derivedClaims(after)) assert.ok(c.evidenceClass === "stale" || c.evidenceClass === "unavailable");
  assert.equal(before.evidence.components.scanner.evidenceClass, "estimate", "cached original is not mutated");
});
