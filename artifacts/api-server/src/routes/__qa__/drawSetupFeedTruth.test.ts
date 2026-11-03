// Regression: POST /me/assistant/draw-setup must describe the feed behind a
// setup preview as it actually is.
//
//   * The route hard-coded providerSource {composite:true, label:"composite
//     market-data"} on the stale premise that no broker-native feed is active,
//     so even a tradeable preview (which by construction is served by the
//     user's own MetaTrader 5 broker bridge) said "Source: composite
//     market-data" and "not a broker-native quote".
//   * For a gated read the route reused the success-path trust line ("Verified
//     M15 candles · Live feed · Mirror synced …") and, when the gate had no
//     block reason, the producer's default refusal "The chart feed isn't
//     confirmed yet" — although the feed was confirmed and what was missing
//     was a merge-seam check (or the feed was delayed, not stale).
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

const openGate = {
  chartTruthScore: 85, chartReadScore: 70, truthLabel: "Strong", readLabel: "Readable",
  confidentReadAllowed: true, scannerConfirmAllowed: true, selfTradeChartAllowed: true,
  candlestickModeAllowed: true, autonomousChartActionAllowed: true, tradeConfirmationAllowed: true,
  primaryBlockReason: null,
};
const sub = (key: string, rawScore: number | null) => ({
  key, rawScore, evidenceStatus: rawScore == null ? "unavailable" : "measured",
});
// Bound broker quote, every gate open, but no forming bar: the merge seam is
// unmeasured, so the handshake WARNs and the basis is PARTIAL.
const seamUnmeasuredScore = {
  score: 85,
  subMetrics: [
    sub("ohlc_integrity", 100), sub("timeframe_accuracy", 100), sub("feed_freshness", 100),
    sub("historical_live_merge", null), sub("symbol_mirror_accuracy", 96), sub("render_accuracy", null),
  ],
  primaryConcern: "Not measured: Historical/Live Merge Quality, Render Accuracy.",
};
const SUCCESS_LINE = "Verified M15 candles · Live feed · Mirror synced · AACI warning";

function verifiedCtx(source: string | null): Ctx {
  return {
    symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M15", basis: "VERIFIED",
    confidentReadAllowed: true, hasFormingCandle: true, closedBarsCount: 80, limitedHistory: false,
    liveDelayed: false, trustLine: "Verified M15 candles · Live feed · Mirror synced · AACI verified",
    blockReason: null, aaciChartHandshakeOverall: "PASS",
    gateOutput: openGate,
    state: { stale: false, aiUsable: true, truthState: { source }, chartTruthScore: seamUnmeasuredScore },
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


test("a PARTIAL read with every gate open shows the gated line and names the unconfirmed check", async () => {
  ctx = {
    ...verifiedCtx("mt5_broker"), basis: "PARTIAL", trustLine: SUCCESS_LINE, blockReason: null,
    aaciChartHandshakeOverall: "WARN", gateOutput: openGate,
    state: { stale: false, aiUsable: true, truthState: { source: "mt5_broker" }, chartTruthScore: seamUnmeasuredScore },
  };
  const p = await draw({ symbol: "EURUSD", timeframe: "M15", side: "BUY" });
  assert.equal(p.verdict, "refused");
  assert.equal(p.dataFreshness.basis, "PARTIAL");
  assert.ok(!/^Verified M15 candles · Live feed/.test(p.dataFreshness.trustLine), p.dataFreshness.trustLine);
  // The feed is clean and current, so the gated line does not say "syncing":
  // it names that a chart check did not pass (fix-6's gated wording).
  assert.equal(p.dataFreshness.trustLine, "M15 candles clean · not every chart check passed · read gated");
  assert.ok(!/isn't confirmed yet/.test(p.refusalReason), p.refusalReason);
  assert.match(p.refusalReason, /seam between closed history and the live candle is not confirmed/);
});

test("a delayed (not stale) feed is called delayed in both the line and the refusal", async () => {
  ctx = {
    ...verifiedCtx("mt5_broker"), basis: "INSUFFICIENT", trustLine: SUCCESS_LINE, blockReason: null,
    gateOutput: openGate,
    state: { stale: false, aiUsable: false, truthState: { source: "mt5_broker", quality: "delayed" }, chartTruthScore: seamUnmeasuredScore },
  };
  const p = await draw({ symbol: "EURUSD", timeframe: "M15", side: "BUY" });
  assert.equal(p.dataFreshness.trustLine, "M15 candles syncing · feed delayed · read gated");
  assert.match(p.refusalReason, /delayed, not live/);
});

test("a chart that could not be loaded says so", async () => {
  ctx = null;
  const p = await draw({ symbol: "EURUSD", timeframe: "M15", side: "BUY" });
  assert.equal(p.dataFreshness.trustLine, "M15 candles syncing · feed unavailable · read gated");
  assert.match(p.refusalReason, /could not be loaded/);
});

// Only a feed graded "delayed" is a delayed feed. A current feed whose candles
// have gaps ("partial") or failed their integrity checks ("invalid") is also
// not AI-usable, and the refusal and line must name that candle problem.
function unusableFeedCtx(truthState: Record<string, unknown>, truthResult: Record<string, unknown> | null = null): Ctx {
  return {
    ...verifiedCtx("mt5_broker"), basis: "INSUFFICIENT", trustLine: SUCCESS_LINE, blockReason: null,
    gateOutput: openGate,
    state: { stale: false, aiUsable: false, truthState: { source: "mt5_broker", ...truthState }, truthResult,
      chartTruthScore: seamUnmeasuredScore },
  };
}

test("a partial (gapped) feed is named as an incomplete candle sequence, not a delayed feed", async () => {
  ctx = unusableFeedCtx({ quality: "partial", missingCandleCount: 2, duplicateCount: 0, outOfOrderCount: 1,
    warning: "Incomplete sequence: 2 missing, 0 duplicate, 1 out-of-order bar(s)." });
  const p = await draw({ symbol: "EURUSD", timeframe: "M15", side: "BUY" });
  assert.equal(p.verdict, "refused");
  assert.doesNotMatch(p.refusalReason, /delayed/i, p.refusalReason);
  assert.match(p.refusalReason, /candle sequence is incomplete \(2 missing bars, 1 out-of-order bar\)/);
  assert.equal(p.dataFreshness.trustLine, "M15 candles syncing · candle sequence incomplete · read gated");
});

test("an invalid feed names the failed integrity check, not a delayed feed", async () => {
  ctx = unusableFeedCtx({ quality: "invalid", invalidOhlcCount: 3,
    warning: "Candle integrity check failed: 3 bar(s) with invalid OHLC. Not safe for analysis." });
  let p = await draw({ symbol: "EURUSD", timeframe: "M15", side: "BUY" });
  assert.doesNotMatch(p.refusalReason, /delayed/i, p.refusalReason);
  assert.match(p.refusalReason, /candles failed their integrity checks \(3 bars with invalid OHLC\)/);
  assert.equal(p.dataFreshness.trustLine, "M15 candles syncing · candles failed integrity checks · read gated");
  // Simulated data and unconfirmed timestamps are also "invalid", named for what they are.
  ctx = unusableFeedCtx({ quality: "invalid", invalidOhlcCount: 0, warning: "Chart data is unavailable — feed is syncing. Please wait." },
    { mockDataDetected: true });
  p = await draw({ symbol: "EURUSD", timeframe: "M15", side: "BUY" });
  assert.match(p.refusalReason, /looks simulated, not real market data/);
  ctx = unusableFeedCtx({ quality: "invalid", invalidOhlcCount: 0,
    warning: "Candle timestamps could not be confirmed (newest bar is missing a usable time or is stamped in the future). Not safe for analysis." });
  p = await draw({ symbol: "EURUSD", timeframe: "M15", side: "BUY" });
  assert.match(p.refusalReason, /candle timestamps could not be confirmed/);
});

test("a feed with no grade is 'not confirmed', never assumed delayed", async () => {
  ctx = unusableFeedCtx({});
  const p = await draw({ symbol: "EURUSD", timeframe: "M15", side: "BUY" });
  assert.doesNotMatch(p.refusalReason, /delayed/i, p.refusalReason);
  assert.match(p.refusalReason, /has not passed its checks/);
  assert.equal(p.dataFreshness.trustLine, "M15 candles syncing · feed not confirmed · read gated");
});
