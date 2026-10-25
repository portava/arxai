import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { getMarketProvider, _resetMarketProviderForTests, refreshMarketProvider } from "../marketProvider.js";
import { QUOTE_FRESH_TTL_MS, QUOTE_STALE_AFTER_MS } from "../../data/freshness.js";

const keys = ["TWELVEDATA_API_KEY", "POLYGON_API_KEY", "FINNHUB_API_KEY", "ALPHA_VANTAGE_API_KEY", "NEWSAPI_API_KEY"];
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let saved: Array<string | undefined>;
let now: number;
beforeEach(() => {
  saved = keys.map(k => process.env[k]);
  keys.forEach(k => { delete process.env[k]; });
  now = Date.parse("2026-10-25T12:00:00Z");
  Date.now = () => now;
  // Any accidental network use fails this suite.
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
  _resetMarketProviderForTests();
});
afterEach(() => {
  keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  _resetMarketProviderForTests();
});
function finnhub(timestamp: unknown) {
  process.env.FINNHUB_API_KEY = "offline-fixture";
  globalThis.fetch = async () => Response.json({ c: 123, t: timestamp });
  return getMarketProvider();
}

for (const [label, age, expected, stale] of [
  ["current", 1000, "REALTIME", false],
  ["fresh boundary", QUOTE_FRESH_TTL_MS, "REALTIME", false],
  ["delayed", QUOTE_FRESH_TTL_MS + 1000, "DELAYED", false],
  ["stale boundary", QUOTE_STALE_AFTER_MS, "DELAYED", false],
  ["old", QUOTE_STALE_AFTER_MS + 1000, "STALE", true],
  ["Friday quote on Sunday", 40 * 60 * 60_000, "STALE", true],
  ["future dated", -1000, "STALE", true],
] as const) {
  test(`single provider classifies ${label} by observation time`, async () => {
    const q = await finnhub((now - age) / 1000).getLiveQuote("AAPL");
    assert.equal(q.freshness, expected);
    assert.equal(q.stale, stale);
    assert.equal(q.asOf, new Date(now - age).toISOString());
    assert.equal(q.price, 123);
  });
}

for (const timestamp of [undefined, null, 0, "bad-date", 1e30]) {
  test(`missing/invalid source timestamp (${timestamp}) never becomes now`, async () => {
    const q = await finnhub(timestamp).getLiveQuote("AAPL");
    assert.equal(q.asOf, null);
    assert.equal(q.freshness, "STALE");
    assert.equal(q.stale, true);
  });
}

test("cached quote ages across stale cutoff without another request", async () => {
  const p = finnhub((now - QUOTE_STALE_AFTER_MS + 1000) / 1000);
  const fetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => { calls++; return fetch(...args); };
  const first = await p.getLiveQuote("AAPL");
  assert.equal(first.freshness, "DELAYED");
  now += 2000;
  const second = await p.getLiveQuote("AAPL");
  assert.equal(second.freshness, "STALE");
  assert.equal(second.stale, true);
  assert.equal(first.stale, false);
  assert.equal(calls, 1);
});

test("composite skips old primary in favor of a current fallback", async () => {
  finnhub(now / 1000);
  process.env.POLYGON_API_KEY = "offline-fixture";
  _resetMarketProviderForTests();
  const calls: string[] = [];
  globalThis.fetch = async input => {
    const host = new URL(String(input)).hostname;
    calls.push(host);
    return Response.json(host === "api.polygon.io"
      ? { ticker: { lastTrade: { p: 120, t: (now - 40 * 60 * 60_000) * 1e6 } } }
      : { c: 123, t: now / 1000 });
  };
  const q = await getMarketProvider().getLiveQuote("AAPL");
  assert.equal(q.source, "finnhub");
  assert.equal(q.price, 123);
  assert.equal(q.freshness, "REALTIME");
  assert.deepEqual(calls, ["api.polygon.io", "finnhub.io"]);
});

test("an old real quote does not pass a readiness refresh", async () => {
  finnhub((now - 40 * 60 * 60_000) / 1000);
  const r = await refreshMarketProvider(["AAPL"]);
  assert.equal(r.probes[0]?.ok, false);
  assert.equal(r.probes[0]?.freshness, "STALE");
});

for (const [key, payload] of [
  ["TWELVEDATA_API_KEY", { close: "123" }],
  ["POLYGON_API_KEY", { results: [{ c: 1.12 }] }],
  ["ALPHA_VANTAGE_API_KEY", { "Global Quote": { "05. price": "123" } }],
] as const) {
  test(`${key} also preserves missing observation time`, async () => {
    process.env[key] = "offline-fixture";
    globalThis.fetch = async () => Response.json(payload);
    const q = await getMarketProvider().getLiveQuote("EURUSD");
    assert.equal(q.asOf, null);
    assert.equal(q.freshness, "STALE");
    assert.equal(q.stale, true);
  });
}

test("provider-declared delayed data is never upgraded to realtime", async () => {
  process.env.POLYGON_API_KEY = "offline-fixture";
  globalThis.fetch = async () => Response.json({ results: [{ c: 1.12, t: now }] });
  const q = await getMarketProvider().getLiveQuote("EURUSD");
  assert.equal(q.freshness, "DELAYED");
  assert.equal(q.stale, false);
});

test("unavailable quote stays unavailable", async () => {
  finnhub(now / 1000);
  globalThis.fetch = async () => Response.json({ c: 0 });
  const q = await getMarketProvider().getLiveQuote("AAPL");
  assert.equal(q.freshness, "UNAVAILABLE");
  assert.equal(q.price, null);
});

test("a recent Polygon snapshot update cannot freshen its old trade", async () => {
  process.env.POLYGON_API_KEY = "offline-fixture";
  const old = now - 40 * 60 * 60_000;
  globalThis.fetch = async () => Response.json({ ticker: { updated: now * 1e6, lastTrade: { p: 123, t: old * 1e6 } } });
  const q = await getMarketProvider().getLiveQuote("AAPL");
  assert.equal(q.asOf, new Date(old).toISOString());
  assert.equal(q.freshness, "STALE");
});

test("Polygon day close without its own observation time stays unknown", async () => {
  process.env.POLYGON_API_KEY = "offline-fixture";
  globalThis.fetch = async () => Response.json({ ticker: { updated: now * 1e6, day: { c: 123 } } });
  const q = await getMarketProvider().getLiveQuote("AAPL");
  assert.equal(q.asOf, null);
  assert.equal(q.freshness, "STALE");
});

test("unified router refuses unknown time and preserves a dated stale quote", async () => {
  const priorDatabase = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";
  try {
    const { routeQuote } = await import("../../data/marketDataRouter.js");
    finnhub(undefined);
    const unknown = await routeQuote("AAPL");
    assert.equal(unknown.ok, false);
    assert.equal(unknown.quote, null);
    assert.ok(unknown.attempts.some(a => a.reason === "QUOTE_TIMESTAMP_UNKNOWN"));
    _resetMarketProviderForTests();
    const old = now - 40 * 60 * 60_000;
    finnhub(old / 1000);
    const dated = await routeQuote("AAPL");
    assert.equal(dated.ok, true);
    assert.equal(dated.quote?.timestamp, new Date(old).toISOString());
    assert.equal(dated.provenance?.source, "STALE");
  } finally {
    if (priorDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabase;
  }
});
