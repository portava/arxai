// The Self-Trade chart gate reads the deciding user's broker-bound chart state,
// not the shared placeholder. No DB, broker request, or trade is made.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selfTradeDecisionChart } from "../selfTradeDecisionChart.js";
import { selfTradeChartConfirmation } from "../selfTradeChartConfirmation.js";

const gateOutput = { selfTradeChartAllowed: true, autonomousChartActionAllowed: true, tradeConfirmationAllowed: true, primaryBlockReason: null };
const placeholder = { gateOutput, brokerAlignment: { brokerDataAvailable: false }, currentCandle: null } as any;
const bound = { ...placeholder, brokerAlignment: { brokerDataAvailable: true, quoteBinding: { status: "BOUND" } } };
const ctx = (state: object) => ({ state, truthResult: null, feedStatus: {}, seriesAttribution: null }) as any;

test("the shared placeholder can never pass; a bound user alignment can", async () => {
  assert.match(selfTradeChartConfirmation(placeholder).reason ?? "", /Broker price data not available/);
  const calls: unknown[] = [];
  const { state } = await selfTradeDecisionChart("V75", "M5", 70, {
    read: (_s, _tf, limit) => (limit === 300 ? ctx(placeholder) : null),
    enrich: async (s, args) => { calls.push(args); return { ...s, ...bound }; },
  });
  assert.deepEqual(calls, [{ userId: 70, symbol: "V75", timeframe: "M5", limit: 300 }]);
  assert.deepEqual(selfTradeChartConfirmation(state), { allowed: true, reason: null });
});

test("falls back to the 200-bar cache with its own limit", async () => {
  const limits: number[] = [];
  await selfTradeDecisionChart("V75", "M5", 70, {
    read: (_s, _tf, limit) => (limit === 200 ? ctx(placeholder) : null),
    enrich: async (s, args) => { limits.push(args.limit); return s; },
  });
  assert.deepEqual(limits, [200]);
});

test("an unbound or failed enrichment keeps the gate blocked", async () => {
  for (const enrich of [async (s: any) => s, async () => { throw new Error("quote lookup failed"); }]) {
    const { state } = await selfTradeDecisionChart("V75", "M5", 70, { read: () => ctx(placeholder), enrich });
    assert.equal(selfTradeChartConfirmation(state).allowed, false);
  }
});

test("no cached chart stays unavailable and never enriches", async () => {
  let enriched = false;
  const r = await selfTradeDecisionChart("V75", "M5", 70, { read: () => null, enrich: async (s) => { enriched = true; return s; } });
  assert.deepEqual(r, { cached: null, state: null });
  assert.equal(enriched, false);
  assert.equal(selfTradeChartConfirmation(r.state).allowed, false);
});

test("a forming bar still withholds confirmation after binding", async () => {
  const { state } = await selfTradeDecisionChart("V75", "M5", 70, {
    read: () => ctx(placeholder), enrich: async (s) => ({ ...s, ...bound, currentCandle: { open: 1 } }) as any,
  });
  assert.match(selfTradeChartConfirmation(state).reason ?? "", /Current candle has not closed/);
});
