// Truth: levelPersonality sets retest_pending only after a level broke AND
// price came back to it (breaks > 0 && retests > 0): the retest was observed,
// not awaited. Ruby's nearest-level line and the Exit panel already say
// "broken, and price has come back to retest it", but GET /me/chart/smart-layers
// had its own vocabulary and labelled the scanner chart's structure line
// "Support — retest pending", telling the trader to wait for something that
// already happened. The route now uses the same level wording as Ruby.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//   src/routes/__qa__/smartLayersLevelPersonality.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
const fake = createFakeDb({ paper_trades: [] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });

const realSignal = await import("../../lib/signalIntelligence/signalIntelligenceService.js");
mock.module("../../lib/signalIntelligence/signalIntelligenceService.js", { namedExports: {
  ...realSignal,
  buildRubyMarketEdgeForUser: async () => null,
} });
const realChart = await import("../../lib/data/chart/chartIntelligence.js");
mock.module("../../lib/data/chart/chartIntelligence.js", { namedExports: {
  ...realChart,
  buildChartIntelligenceState: async () => ({
    stale: false,
    marketUnderstanding: { levels: { levels: [
      { kind: "support", price: 1.08, personality: "retest_pending" },
      { kind: "resistance", price: 1.09, personality: "defended" },
    ] } },
  }),
} });
const realRadar = await import("../../lib/news/marketImpactRadar.js");
mock.module("../../lib/news/marketImpactRadar.js", { namedExports: {
  ...realRadar, buildMarketImpactRadar: async () => { throw new Error("no provider in test"); },
} });
const router = (await import("../meChartSmartLayers.js")).default;
const { chartLevelPersonalityWords } = await import("../../lib/data/chart/marketSentenceEngine.js");

type Layer = { group: string; price: number | null; label: string };
async function structureLabels(): Promise<Layer[]> {
  let out: Layer[] = [];
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/me/chart/smart-layers?symbol=EURUSD&timeframe=M5`);
    assert.equal(r.status, 200);
    const body = await r.json() as { layers: Layer[] };
    out = body.layers.filter((l) => l.group === "structure");
  });
  return out;
}

test("a broken-and-retested level is not labelled as a retest still pending", async () => {
  const layers = await structureLabels();
  const support = layers.find((l) => l.price === 1.08);
  assert.ok(support, JSON.stringify(layers));
  assert.doesNotMatch(support.label, /pending|waiting|awaiting/i, support.label);
  assert.match(support.label, /broken/);
  assert.match(support.label, /come back to retest/);
});

test("the chart line uses the same level words as Ruby's nearest-level line", async () => {
  const layers = await structureLabels();
  assert.equal(layers.find((l) => l.price === 1.08)?.label, `Support — ${chartLevelPersonalityWords("retest_pending")}`);
  assert.equal(layers.find((l) => l.price === 1.09)?.label, `Resistance — ${chartLevelPersonalityWords("defended")}`);
});
