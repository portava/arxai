// Truth regression: the internal getLatestQuote accessor must not hand callers
// a quote stamped "now" when no provider served one. A failed lookup is null
// (no price, no observation time), and a served quote says whether its
// timestamp is the producer's tick time and which provider served it, so a
// caller can judge its age on the right basis.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

type Routed = Record<string, unknown>;
let nextRouted: Routed = {};
const realRouter = await import("../marketDataRouter.js");
mock.module("../marketDataRouter.js", {
  namedExports: { ...realRouter, routeQuote: async () => nextRouted },
});

const { getLatestQuote } = await import("../dataManager.js");

test("no provider served a quote: null, not {symbol, timestamp: now}", async () => {
  nextRouted = { ok: false, symbol: "EURUSD", assetClass: "forex", quote: null, primaryProvider: null, attempts: [], userMessage: "", adminDetail: "" };
  const q = await getLatestQuote("EURUSD");
  assert.equal(q, null);
});

test("a served quote carries its time basis and source", async () => {
  nextRouted = {
    ok: true, symbol: "EURUSD", assetClass: "forex",
    quote: { symbol: "EURUSD", bid: 1.1, ask: 1.1002, last: 1.1001, timestamp: "2026-10-28T12:00:00.000Z" },
    primaryProvider: "mt5_broker", attempts: [], userMessage: "", adminDetail: "",
    provenance: { providerId: "mt5_broker" }, tickTimeObserved: true,
  };
  const q = await getLatestQuote("EURUSD");
  assert.ok(q);
  assert.equal(q!.last, 1.1001);
  assert.equal(q!.timestamp, "2026-10-28T12:00:00.000Z");
  assert.equal(q!.tickTimeObserved, true);
  assert.equal(q!.source, "mt5_broker");
});

test("a served quote whose time is a receive stamp says so", async () => {
  nextRouted = {
    ok: true, symbol: "EURUSD", assetClass: "forex",
    quote: { symbol: "EURUSD", last: 1.1001, timestamp: "2026-10-28T12:00:00.000Z" },
    primaryProvider: "assistant_real", attempts: [], userMessage: "", adminDetail: "",
  };
  const q = await getLatestQuote("EURUSD");
  assert.equal(q!.tickTimeObserved, false);
  assert.equal(q!.source, "assistant_real");
});
