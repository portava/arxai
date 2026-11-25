// The Self-Trade chart gate reads the deciding user's broker-bound chart state,
// not the shared placeholder. No DB, broker request, or trade is made.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selfTradeDecisionChart } from "../selfTradeDecisionChart.js";

const placeholder = { brokerAlignment: { brokerDataAvailable: false }, currentCandle: null } as any;
const bound = { ...placeholder, brokerAlignment: { brokerDataAvailable: true, quoteBinding: { status: "BOUND" } } };
const ctx = (state: object) => ({ state, truthResult: null, feedStatus: {}, seriesAttribution: null }) as any;

test("the gate receives the user's bound alignment, not the shared placeholder", async () => {
  const calls: unknown[] = [];
  const { state } = await selfTradeDecisionChart("V75", "M5", 70, {
    read: (_s, _tf, limit) => (limit === 300 ? ctx(placeholder) : null),
    enrich: async (s, args) => { calls.push(args); return { ...s, ...bound }; },
  });
  assert.deepEqual(calls, [{ userId: 70, symbol: "V75", timeframe: "M5", limit: 300 }]);
  assert.equal(state?.brokerAlignment.brokerDataAvailable, true);
  assert.equal(placeholder.brokerAlignment.brokerDataAvailable, false, "shared cached state is not mutated");
});

test("falls back to the 200-bar cache with its own limit", async () => {
  const limits: number[] = [];
  await selfTradeDecisionChart("V75", "M5", 70, {
    read: (_s, _tf, limit) => (limit === 200 ? ctx(placeholder) : null),
    enrich: async (s, args) => { limits.push(args.limit); return s; },
  });
  assert.deepEqual(limits, [200]);
});

test("an unbound or failed enrichment keeps the placeholder", async () => {
  for (const enrich of [async (s: any) => s, async () => { throw new Error("quote lookup failed"); }]) {
    const { state } = await selfTradeDecisionChart("V75", "M5", 70, { read: () => ctx(placeholder), enrich });
    assert.equal(state?.brokerAlignment.brokerDataAvailable, false);
  }
});

test("no cached chart stays unavailable and never enriches", async () => {
  let enriched = false;
  const r = await selfTradeDecisionChart("V75", "M5", 70, { read: () => null, enrich: async (s) => { enriched = true; return s; } });
  assert.deepEqual(r, { cached: null, state: null });
  assert.equal(enriched, false);
});
