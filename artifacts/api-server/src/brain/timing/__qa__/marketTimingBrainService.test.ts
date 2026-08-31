// Unit tests for the Market-Timing-Brain composer. Run via:
//   node --import tsx --test src/brain/timing/__qa__/marketTimingBrainService.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:timing-composer`)
//
// The market-data router, news/broad-flow engines, and DB persistence are all
// injected so the composed read is fully deterministic and never touches a live
// feed, the wall clock, or the database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTimingRead, type TimingBrainDeps } from "../marketTimingBrainService.js";

type CandlesResult = Awaited<ReturnType<NonNullable<TimingBrainDeps["routeCandlesFn"]>>>;
type QuoteResult = Awaited<ReturnType<NonNullable<TimingBrainDeps["routeQuoteFn"]>>>;
type NewsOverlay = Awaited<ReturnType<NonNullable<TimingBrainDeps["computeNewsHeatFn"]>>>;
type BroadFlow = Awaited<ReturnType<NonNullable<TimingBrainDeps["computeBroadFlowFn"]>>>;

function candlesOk(n: number): CandlesResult {
  const candles = Array.from({ length: n }, (_, i) => ({
    time: new Date(Date.UTC(2026, 0, 5, 0, i)).toISOString(),
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100.2,
    volume: 1000,
  }));
  return {
    ok: true, symbol: "EURUSD", assetClass: "forex", candles,
    primaryProvider: "test", attempts: [], userMessage: "", adminDetail: "",
  };
}

const candlesEmpty: CandlesResult = {
  ok: false, symbol: "EURUSD", assetClass: "forex", candles: [],
  primaryProvider: null, attempts: [], userMessage: "no data", adminDetail: "",
};

function quoteOk(): QuoteResult {
  return {
    ok: true, symbol: "EURUSD", assetClass: "forex",
    quote: { symbol: "EURUSD", bid: 1.0999, ask: 1.1001, spread: 0.0002, last: 1.1, timestamp: "" },
    primaryProvider: "test", attempts: [], userMessage: "", adminDetail: "",
  };
}

const quoteEmpty: QuoteResult = {
  ok: false, symbol: "EURUSD", assetClass: "forex", quote: null,
  primaryProvider: null, attempts: [], userMessage: "no data", adminDetail: "",
};

const newsNone: NewsOverlay = {
  phase: "NONE", eventName: null, minutesUntil: null, minutesSince: null,
  eventType: "none", surpriseScore: null, heatAdjustment: 0, blocksTrade: false,
};

const broadAligned: BroadFlow = {
  verdict: "ALIGNED", institutionalFlowScore: 75, competingCatalyst: false,
  description: "", correlatedAssets: [], dataQuality: "real",
};

const broadUnavailable: BroadFlow = {
  verdict: "UNAVAILABLE", institutionalFlowScore: 50, competingCatalyst: false,
  description: "", correlatedAssets: [], dataQuality: "unavailable",
};

function baseDeps(over: Partial<TimingBrainDeps> = {}): TimingBrainDeps {
  return {
    classifyFn: () => "forex",
    routeCandlesFn: async () => candlesOk(80),
    routeQuoteFn: async () => quoteOk(),
    computeNewsHeatFn: async () => newsNone,
    computeBroadFlowFn: async () => broadAligned,
    persist: async () => {},
    ...over,
  };
}

test("no candles and no quote → honest unavailable label, and never a clock-only GO", async () => {
  const read = await computeTimingRead(
    { symbol: "EURUSD", persistSnapshot: false },
    baseDeps({
      routeCandlesFn: async () => candlesEmpty,
      routeQuoteFn: async () => quoteEmpty,
      computeBroadFlowFn: async () => broadUnavailable,
    }),
  );
  // Feed fully down: the only reachable label is "unavailable" — the frontend's
  // honest collapse branch keys on exactly this. "basic_timing_estimate" must
  // never be emitted for a fully-down feed (it read as a usable estimate).
  assert.equal(read.dataQuality.label, "unavailable");
  assert.equal(read.dataQuality.hasCandleData, false);
  assert.equal(read.dataQuality.hasQuoteData, false);
  assert.match(read.dataQuality.note, /unavailable/);
  // The wall clock alone (session bonus) must never grant a green GO.
  assert.notEqual(read.entryPermission, "GO");
  assert.equal(read.entryPermission, "WAIT_FOR_ENTRY");
});

test("high trap score renders as N/100 in actionReason — never with a % sign", async () => {
  // 79 baseline candles + a PDH sweep candle with weak follow-through, plus a
  // CONFLICTED broad flow: trap score = 35 (sweep) + 20 (weak body) + 15
  // (broad conflict) = 70 (+ up to ~2 from kill-zone fakeout), which crosses
  // the >65 WATCH_ONLY branch deterministically while danger stays below the
  // STAND_DOWN bar regardless of wall-clock session state.
  const base = candlesOk(80);
  const sweep = {
    time: new Date(Date.UTC(2026, 0, 5, 2, 0)).toISOString(),
    open: 100.45, high: 101.0, low: 100.3, close: 100.4, volume: 1000,
  };
  const candles = [...base.candles.slice(0, 79), sweep];
  const broadConflicted: BroadFlow = {
    ...broadAligned, verdict: "CONFLICTED",
  };
  const read = await computeTimingRead(
    { symbol: "EURUSD", persistSnapshot: false },
    baseDeps({
      routeCandlesFn: async () => ({ ...base, candles }),
      computeBroadFlowFn: async () => broadConflicted,
    }),
  );
  assert.ok(read.trapProbability > 65, `expected trap > 65, got ${read.trapProbability}`);
  assert.equal(read.bestAction, "WATCH_ONLY");
  assert.match(read.actionReason, /High trap score \(\d+\/100\)/);
  // Uncalibrated rule-points score: a "%" would present it as a measured
  // probability (codebase honesty rule — see liveScanner signalStrength).
  assert.ok(!read.actionReason.includes("%"), `actionReason must not use %: ${read.actionReason}`);
});

test("real candles + quote + news + broad flow → dataQuality real", async () => {
  const read = await computeTimingRead({ symbol: "EURUSD", persistSnapshot: false }, baseDeps());
  assert.equal(read.dataQuality.label, "real");
  assert.equal(read.dataQuality.hasCandleData, true);
  assert.equal(read.dataQuality.hasQuoteData, true);
  // Every score is a bounded number.
  for (const v of [read.heatScore, read.tradeabilityScore, read.edgeScore, read.dangerScore, read.trapProbability, read.roomToMove]) {
    assert.ok(typeof v === "number" && v >= 0 && v <= 100, `score ${v} out of range`);
  }
});

test("news blocking the trade forces bestAction WAIT_FOR_NEWS", async () => {
  const read = await computeTimingRead(
    { symbol: "EURUSD", persistSnapshot: false },
    baseDeps({
      computeNewsHeatFn: async () => ({ ...newsNone, blocksTrade: true, eventName: "FOMC Rate Decision" }),
    }),
  );
  assert.equal(read.bestAction, "WAIT_FOR_NEWS");
});

test("snapshot persistence receives the computed values when enabled", async () => {
  let captured: { symbol: string; heatScore: number } | null = null;
  const read = await computeTimingRead(
    { symbol: "EURUSD", persistSnapshot: true },
    baseDeps({
      persist: async (values) => { captured = { symbol: values.symbol, heatScore: values.heatScore as number }; },
    }),
  );
  assert.notEqual(captured, null);
  assert.equal(captured!.symbol, "EURUSD");
  assert.equal(captured!.heatScore, read.heatScore);
});

test("snapshot persistence failure is non-fatal — the read is still returned", async () => {
  const read = await computeTimingRead(
    { symbol: "EURUSD", persistSnapshot: true },
    baseDeps({ persist: async () => { throw new Error("db down"); } }),
  );
  assert.equal(read.symbol, "EURUSD");
  assert.ok(typeof read.heatScore === "number");
});

test("buy-pressure-dominant candles surface a BUY pressure bias", async () => {
  // All candles close above open → buy pressure dominant.
  const read = await computeTimingRead(
    { symbol: "EURUSD", persistSnapshot: false },
    baseDeps({ routeCandlesFn: async () => candlesOk(80) }),
  );
  assert.equal(read.pressureBias, "BUY");
});
