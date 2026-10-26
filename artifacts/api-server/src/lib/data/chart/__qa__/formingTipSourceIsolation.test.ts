import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const now = 1_800_000_030_000;
const interval = 300_000;
const currentOpen = Math.floor(now / interval) * interval;
let historySource = "mt5_broker";
const bars = Array.from({ length: 60 }, (_, i) => ({
  time: new Date(currentOpen - (60 - i) * interval).toISOString(),
  open: 1000 + i, high: 1002 + i, low: 999 + i, close: 1001 + i, volume: 100,
}));
mock.module("../../marketDataRouter.js", { namedExports: {
  classifySymbol: () => "synthetic",
  routeCandles: async () => ({ ok: true, symbol: "V75", assetClass: "synthetic", candles: bars,
    primaryProvider: historySource, attempts: [], provenance: null, userMessage: null }),
} });
mock.module("../sessionProfile.js", { namedExports: { getSessionProfile: async () => null, isSlotExpected: () => true } });
const { foldFormingTick, getFormingBar, getFeedFreshness, __resetFormingBarStore } = await import("../formingBarComposer.js");
const { getChartCandles } = await import("../chartDataService.js");
const { handleChartTickStream } = await import("../../../../routes/chartTickStream.js");
const { startDerivFormingBridge, __stopDerivFormingBridgeForTests } = await import("../derivFormingBridge.js");

beforeEach(() => { __resetFormingBarStore(); __stopDerivFormingBridgeForTests(); });

const sources = ["mt5_broker", "deriv", "deriv_public"] as const;
for (const history of sources) {
  test(`HTTP ${history} candles only receive their own tip`, async () => {
    historySource = history;
    const oldNow = Date.now;
    Date.now = () => now;
    try {
      for (const other of sources.filter((s) => s !== history)) {
        foldFormingTick("R_75", 9000, now, now, other);
      }
      const refused = await getChartCandles("V75", "M5", 60, true);
      assert.equal(refused.source, history);
      assert.equal(refused.candles.at(-1)?.close, bars.at(-1)?.close);
      assert.equal(refused.candles.some((bar) => bar.isForming), false);
      foldFormingTick("R_75", 1200, now, now, history);
      const accepted = await getChartCandles("V75", "M5", 60, true);
      assert.equal(accepted.candles.at(-1)?.close, 1200);
      assert.equal(accepted.candles.at(-1)?.isForming, true);
      assert.equal(accepted.candles.at(-1)?.source, history);
      const analysis = await getChartCandles("V75", "M5", 60);
      assert.equal(analysis.candles.some((bar) => bar.isForming), false);
    } finally { Date.now = oldNow; }
  });
}

test("another provider cannot alter matching OHLC or its freshness clock", () => {
  foldFormingTick("V75", 1000, now - 1000, now - 1000, "mt5_broker");
  foldFormingTick("R_75", 9000, now, now, "deriv_public");
  assert.equal(getFormingBar("V75", "M5", now, "mt5_broker")?.high, 1000);
  assert.equal(getFormingBar("V75", "M5", now, "deriv_public")?.high, 9000);
  assert.equal(getFeedFreshness("V75", now, "mt5_broker")?.wallStaleMs, 1000);
  assert.equal(getFeedFreshness("V75", now, "deriv_public")?.wallStaleMs, 0);
});

function openStream(source?: unknown) {
  const req = Object.assign(new EventEmitter(), { query: { symbol: "R_75", timeframe: "M5", source } });
  const frames: any[] = [];
  let status = 200;
  const res = { setHeader() {}, flushHeaders() {}, status(value: number) { status = value; return this; },
    json(value: unknown) { frames.push(value); }, write(value: string) { frames.push(JSON.parse(value.slice(6))); } };
  handleChartTickStream(req as any, res as any);
  return { req, frames, status };
}

for (const source of sources) {
  test(`SSE ${source} rejects both other providers, including alias bus events`, () => {
    const stream = openStream(source);
    try {
      for (const other of sources.filter((s) => s !== source)) {
        foldFormingTick("V75", 9000, Date.now(), Date.now(), other);
      }
      assert.equal(stream.frames.length, 0);
      foldFormingTick("V75", 1200, Date.now(), Date.now(), source);
      assert.equal(stream.frames.length, 2);
      assert.equal(stream.frames[0].type, "forming_bar");
      assert.equal(stream.frames[0].bar.close, 1200);
      assert.equal(stream.frames[0].source, source);
      assert.equal(stream.frames[1].source, source);
    } finally { stream.req.emit("close"); }
  });
}

test("SSE missing, unsupported and array sources fail before opening a stream", () => {
  for (const source of [undefined, "", "unknown", "assistant_real", ["deriv_public"]]) {
    const stream = openStream(source);
    assert.equal(stream.status, 400);
    assert.equal(stream.req.listenerCount("close"), 0);
  }
});

test("unidentified ticks cannot enter any known provider stream", () => {
  foldFormingTick("V75", 5000, now, now);
  for (const source of sources) assert.equal(getFormingBar("V75", "M5", now, source), null);
});

test("injected public bridge keeps public and legacy Deriv ticks separate", () => {
  let emit: ((tick: { symbol: string; epoch: number; quote: number }) => void) | null = null;
  startDerivFormingBridge({ onTick(listener) { emit = listener; return () => { emit = null; }; } }, "deriv_public");
  emit!({ symbol: "R_75", epoch: Date.now() / 1000, quote: 1200 });
  assert.equal(getFormingBar("V75", "M5", Date.now(), "deriv_public")?.close, 1200);
  assert.equal(getFormingBar("V75", "M5", Date.now(), "deriv"), null);
  __stopDerivFormingBridgeForTests();
});
