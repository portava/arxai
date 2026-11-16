// Audit 2026-11-15: the scanner chart drew "Stop loss" / "Take profit" /
// "Invalidation" from the raw signal whenever the prices were finite, while
// the selected-market panel and the Eleanor read withheld the same setup. The
// chart's trade levels now follow the same per-symbol truth verdict.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
const fake = createFakeDb({ paper_trades: [] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });

const realSignal = await import("../../lib/signalIntelligence/signalIntelligenceService.js");
mock.module("../../lib/signalIntelligence/signalIntelligenceService.js", { namedExports: {
  ...realSignal,
  buildEleanorMarketEdgeForUser: async () => ({
    symbol: "EURUSD", direction: "NEUTRAL", lifecycleStage: "WATCHING", hasSufficientData: true,
    freshness: "FRESH", generatedAt: new Date().toISOString(), dataSource: "LIVE_FEED",
    entryZone: null, watchZone: { from: 1.081, to: 1.082 }, retestZone: { from: 1.081, to: 1.082 }, doNotChaseZone: null,
    invalidationPrice: 1.078, stopLoss: 1.078, takeProfitZones: [{ from: 1.09, to: 1.09 }],
  }),
} });
const realChart = await import("../../lib/data/chart/chartIntelligence.js");
mock.module("../../lib/data/chart/chartIntelligence.js", { namedExports: {
  ...realChart, buildChartIntelligenceState: async () => ({ stale: false, marketUnderstanding: { levels: { levels: [] } } }),
} });
const realRadar = await import("../../lib/news/marketImpactRadar.js");
mock.module("../../lib/news/marketImpactRadar.js", { namedExports: {
  ...realRadar, buildMarketImpactRadar: async () => { throw new Error("no provider in test"); },
} });
let truth: unknown = null;
const realTruth = await import("../../lib/truth/symbolTruthSnapshot.js");
mock.module("../../lib/truth/symbolTruthSnapshot.js", { namedExports: {
  ...realTruth, getSymbolTruthSnapshot: async () => { if (truth instanceof Error) throw truth; return truth; },
} });
const { default: router, truthShowsTradeLevels } = await import("../meChartSmartLayers.js");

const verdict = (bestAction: string, withheld: boolean) => ({
  symbol: "EURUSD", timeframe: "M5", validUntil: new Date(Date.now() + 60_000).toISOString(),
  verdict: { bestAction, bestActionText: "Wait for a cleaner setup." },
  levels: { withheld, withheldReason: withheld ? "Not enough confirmed data for a directional read." : null },
});
async function layers(): Promise<{ ids: string[]; tradeLevels: { shown: boolean; reason: string | null } }> {
  let out: { ids: string[]; tradeLevels: { shown: boolean; reason: string | null } } | null = null;
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/me/chart/smart-layers?symbol=EURUSD&timeframe=M5`);
    assert.equal(r.status, 200);
    const body = await r.json() as { layers: Array<{ id: string }>; tradeLevels: { shown: boolean; reason: string | null } };
    out = { ids: body.layers.map((l) => l.id), tradeLevels: body.tradeLevels };
  });
  return out!;
}
const TRADE = /^signal-(entry|retest|invalidation|sl|tp)/;

test("no stop, target, invalidation or retest is drawn when the truth withholds the setup, and the reason is given", async () => {
  truth = verdict("WAIT", true);
  const r = await layers();
  assert.deepEqual(r.ids.filter((id) => TRADE.test(id)), []);
  assert.ok(r.ids.includes("signal-watch"), "the watch zone stays as context");
  assert.deepEqual(r.tradeLevels, { shown: false, reason: "Not enough confirmed data for a directional read." });
});

test("an unreadable truth check withholds the levels too", async () => {
  truth = new Error("feed down");
  const r = await layers();
  assert.deepEqual(r.ids.filter((id) => TRADE.test(id)), []);
  assert.equal(r.tradeLevels.shown, false);
});

test("levels are drawn only when the truth shows a current directional setup", async () => {
  truth = verdict("BUY", false);
  const r = await layers();
  assert.ok(r.ids.includes("signal-sl") && r.ids.some((id) => /tp/.test(id)), r.ids.join(","));
  assert.deepEqual(r.tradeLevels, { shown: true, reason: null });
});

test("an expired or mismatched truth verdict never shows levels", () => {
  const expired = { ...verdict("BUY", false), validUntil: new Date(Date.now() - 1).toISOString() };
  assert.equal(truthShowsTradeLevels(expired as never, "EURUSD", "M5").shown, false);
  assert.equal(truthShowsTradeLevels(verdict("BUY", false) as never, "GBPUSD", "M5").shown, false);
  assert.equal(truthShowsTradeLevels(verdict("BUY", false) as never, "EURUSD", "M15").shown, false);
});
