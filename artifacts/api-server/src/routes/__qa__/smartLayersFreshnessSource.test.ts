// Truth: the smart-layers overlay handshake's "freshness" check measured how
// long ago the server rebuilt the signal (generatedAt = new Date(now) at build),
// not how old the candles under it are. On a stale feed every 45 s refetch
// rebuilt the signal, so the check always read PASS "Overlays are fresh." over
// overlays drawn from stale candles. The check now also takes whether the
// source candles are live.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
const fake = createFakeDb({ paper_trades: [] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });

let dataSource = "AWAITING_FEED";
let chartStale = true;
const realSignal = await import("../../lib/signalIntelligence/signalIntelligenceService.js");
mock.module("../../lib/signalIntelligence/signalIntelligenceService.js", { namedExports: {
  ...realSignal,
  buildRubyMarketEdgeForUser: async () => ({
    symbol: "EURUSD", direction: "NEUTRAL", lifecycleStage: "WATCHING", hasSufficientData: true,
    freshness: "FRESH", generatedAt: new Date().toISOString(), dataSource,
    entryZone: null, watchZone: null, retestZone: null, doNotChaseZone: null,
    invalidationPrice: null, stopLoss: null, takeProfitZones: [],
  }),
} });
const realChart = await import("../../lib/data/chart/chartIntelligence.js");
mock.module("../../lib/data/chart/chartIntelligence.js", { namedExports: {
  ...realChart,
  buildChartIntelligenceState: async () => ({
    stale: chartStale,
    marketUnderstanding: { levels: { levels: [{ kind: "support", price: 1.08, personality: "fresh" }] } },
  }),
} });
const realRadar = await import("../../lib/news/marketImpactRadar.js");
mock.module("../../lib/news/marketImpactRadar.js", { namedExports: {
  ...realRadar, buildMarketImpactRadar: async () => { throw new Error("no provider in test"); },
} });
const router = (await import("../meChartSmartLayers.js")).default;

type Check = { key: string; status: string; detail: string };
async function freshnessCheck(): Promise<{ check: Check; body: Record<string, unknown> }> {
  let out: { check: Check; body: Record<string, unknown> } | null = null;
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/me/chart/smart-layers?symbol=EURUSD&timeframe=M5`);
    assert.equal(r.status, 200);
    const body = await r.json() as Record<string, unknown>;
    const checks = (body["handshake"] as { checks: Check[] }).checks;
    out = { check: checks.find((c) => c.key === "freshness")!, body };
  });
  return out!;
}

test("a signal rebuilt seconds ago from candles that are not live is not 'fresh'", async () => {
  dataSource = "AWAITING_FEED"; chartStale = true;
  const { check, body } = await freshnessCheck();
  assert.notEqual(check.status, "PASS");
  assert.notEqual(check.detail, "Overlays are fresh.");
  assert.match(check.detail, /not live/);
  const hi = body["handshakeInputs"] as Record<string, unknown>;
  assert.equal(hi["sourceDataLive"], false, "the client re-runs the handshake with the same fact");
});

test("a live signal over stale structure levels is not 'fresh' either", async () => {
  dataSource = "LIVE_FEED"; chartStale = true;
  const { check } = await freshnessCheck();
  assert.notEqual(check.status, "PASS");
});

test("live candles and a recent rebuild still pass", async () => {
  dataSource = "LIVE_FEED"; chartStale = false;
  const { check, body } = await freshnessCheck();
  assert.equal(check.status, "PASS");
  assert.match(check.detail, /live candles/);
  assert.equal((body["handshakeInputs"] as Record<string, unknown>)["sourceDataLive"], true);
});
