// Regression: POST /me/assistant/draw-setup must describe the feed behind a
// setup preview as it actually is.
//
//   * The route hard-coded providerSource {composite:true, label:"composite
//     market-data"} on the stale premise that no broker-native feed is active,
//     so even a tradeable preview (which by construction is served by the
//     user's own MetaTrader 5 broker bridge) said "Source: composite
//     market-data" and "not a broker-native quote".
import { test, mock } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

type Ctx = Record<string, any>;
let ctx: Ctx | null = null;

const rubyCtxMod = await import("../../lib/data/chart/rubyChartContext.js");
mock.module("../../lib/data/chart/rubyChartContext.js", {
  namedExports: { ...rubyCtxMod, buildRubyChartContext: async () => { if (!ctx) throw new Error("no chart"); return ctx; } },
});
const poolMod = await import("../../lib/live/masterBridgePool.js");
mock.module("../../lib/live/masterBridgePool.js", {
  namedExports: { ...poolMod, getUserAllocationView: async () => { throw new Error("not read in this test"); } },
});
const recordMod = await import("../../lib/chart/recordRubyRead.js");
mock.module("../../lib/chart/recordRubyRead.js", {
  namedExports: { ...recordMod, recordRubyReadDecision: () => {} },
});
const signalsMod = await import("../../lib/assistant/setupSignals.js");
mock.module("../../lib/assistant/setupSignals.js", {
  namedExports: {
    ...signalsMod,
    assembleSetupSignals: async () => ({
      scannerScore: null, riskScore: null, flameStage: null, runOnQuality: null,
      governanceOutcome: null, governanceCautions: [],
    }),
  },
});

const { meAssistantRouter } = await import("../meAssistant.js");
const { withRouter } = await import("./_fakeRouteDb.js");

function candles(n = 80, start = 1.07643, step = 0.00011, wick = 0.00017) {
  const r = (x: number) => Number(x.toFixed(5));
  let t = Date.parse("2026-10-27T00:00:00Z");
  return Array.from({ length: n }, (_, i) => {
    const close = r(start + step * i);
    const open = r(close - step * 0.4);
    t += 15 * 60_000;
    return { time: new Date(t).toISOString(), open, high: r(Math.max(open, close) + wick), low: r(Math.min(open, close) - wick), close, volume: 0 };
  });
}

function verifiedCtx(source: string | null): Ctx {
  return {
    symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M15", basis: "VERIFIED",
    confidentReadAllowed: true, hasFormingCandle: true, closedBarsCount: 80, limitedHistory: false,
    liveDelayed: false, trustLine: "Verified M15 candles · Live feed · Mirror synced · AACI verified",
    blockReason: null, aaciChartHandshakeOverall: "PASS",
    state: { stale: false, aiUsable: true, truthState: { source } },
    candles: candles(), htfCandles: [], htfTimeframe: null,
  };
}

async function draw(body: Record<string, unknown>): Promise<any> {
  let out: any;
  await withRouter(meAssistantRouter, { id: 7, role: "TRADER" }, async (base) => {
    const r = await fetch(`${base}/me/assistant/draw-setup`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(r.status, 200, await r.clone().text());
    out = await r.json();
  });
  return out.setupPreview;
}

test("a tradeable preview served by the MT5 broker bridge is not labelled composite", async () => {
  ctx = verifiedCtx("mt5_broker");
  const p = await draw({ symbol: "EURUSD", timeframe: "M15", side: "BUY" });
  assert.ok(p.levels, `expected a drawn setup, got ${p.verdict}: ${p.refusalReason}`);
  assert.equal(p.providerSource.composite, false);
  assert.equal(p.providerSource.label, "MetaTrader 5 broker bridge");
  assert.ok(!p.explanation.some((l: string) => /not a broker-native quote/.test(l)), p.explanation.join(" | "));
});

test("a series from another provider is composite; an unreported source is named as unreported", async () => {
  ctx = { ...verifiedCtx("deriv"), basis: "PARTIAL" };
  const composite = await draw({ symbol: "EURUSD", timeframe: "M15" });
  assert.equal(composite.providerSource.composite, true);
  assert.equal(composite.providerSource.label, "composite market-data");

  ctx = null; // the chart context could not be built
  const unknown = await draw({ symbol: "EURUSD", timeframe: "M15" });
  assert.equal(unknown.providerSource.label, "unreported");
  assert.notEqual(unknown.providerSource.label, "composite market-data");
});
