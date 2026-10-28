// Truth regression: GET /api/data/quote must say when its price was observed,
// on what basis, and read stale past the quote budget. A failed lookup used to
// return `{ symbol, timestamp: <now> }` — a fresh-looking time for a quote that
// never existed. Now it carries no price, available=false and observedAt=null.
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const NOW = Date.now();
let nextRouted: Record<string, unknown> | null = null;

const realRouter = await import("../marketDataRouter.js");
mock.module("../marketDataRouter.js", {
  namedExports: { ...realRouter, routeQuote: async () => nextRouted },
});

const { default: router } = await import("../../../routes/data.js");
const { QUOTE_STALE_AFTER_MS } = await import("../freshness.js");

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown) => unknown }> } };
function quoteHandler() {
  const layer = (router as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === "/data/quote" && l.route.methods.get);
  assert.ok(layer?.route, "GET /data/quote must exist");
  return layer!.route!.stack[layer!.route!.stack.length - 1]!.handle;
}

async function get(symbol: string): Promise<Record<string, unknown>> {
  let body: unknown = null;
  let status = 200;
  const res = {
    status(c: number) { status = c; return res; },
    json(b: unknown) { body = b; return res; },
  };
  const req = { query: { symbol }, log: { error() {} } };
  await quoteHandler()(req, res);
  assert.equal(status, 200);
  return body as Record<string, unknown>;
}

function routed(provider: string, timestamp: string, tickTimeObserved: boolean) {
  return {
    ok: true, symbol: "EURUSD", assetClass: "forex",
    quote: { symbol: "EURUSD", bid: 1.0999, ask: 1.1001, last: 1.1, timestamp },
    primaryProvider: provider, attempts: [], userMessage: "", adminDetail: "",
    provenance: { providerId: provider }, tickTimeObserved,
  };
}

test("no provider served a quote: no price, no observation time, never a fresh-looking stamp", async () => {
  nextRouted = { ok: false, symbol: "EURUSD", assetClass: "forex", quote: null, primaryProvider: null, attempts: [], userMessage: "", adminDetail: "" };
  const b = await get("EURUSD");
  assert.equal(b.available, false);
  assert.equal(b.observedAt, null);
  assert.equal(b.timeBasis, "none");
  assert.equal(b.freshness, "unavailable");
  assert.equal(b.stale, true);
  assert.equal(b.last ?? null, null);
  assert.equal(b.source, null);
  assert.match(String(b.observationNote), /No price was available/);
});

test("producer-observed tick within budget is fresh, with its source and time", async () => {
  const ts = new Date(Date.now() - 2_000).toISOString();
  nextRouted = routed("mt5_broker", ts, true);
  const b = await get("EURUSD");
  assert.equal(b.available, true);
  assert.equal(b.source, "mt5_broker");
  assert.equal(b.timeBasis, "producer_tick");
  assert.equal(b.observedAt, ts);
  assert.equal(b.freshness, "fresh");
  assert.equal(b.stale, false);
  assert.equal(b.last, 1.1);
});

test("quote past the budget reads stale / last-known", async () => {
  nextRouted = routed("deriv", new Date(NOW - QUOTE_STALE_AFTER_MS - 60_000).toISOString(), true);
  const b = await get("EURUSD");
  assert.equal(b.stale, true);
  assert.equal(b.freshness, "stale");
  assert.match(String(b.observationNote), /last-known price, not a current one/);
});

test("receive-time stamp is labelled so and cannot read fresh", async () => {
  nextRouted = routed("assistant_real", new Date(Date.now() - 1_000).toISOString(), false);
  const b = await get("EURUSD");
  assert.equal(b.timeBasis, "server_receive");
  assert.equal(b.freshness, "delayed");
  assert.match(String(b.observationNote), /market tick may be older/);
});
