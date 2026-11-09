// Handshake MARKET_DATA layer: PASS needs market-data evidence — a serving
// price provider and symbol probes that actually returned candles and quotes.
// An OpenAI or NewsAPI key is not a market-data provider.
//
// The provider-health snapshot is mocked (no provider, DB, broker or network).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

type Activity = { assetClass: string; representativeSymbol: string; latestCandleProvider: string | null; latestQuoteProvider: string | null;
  lastCandleTime: string | null; lastQuoteTime: string | null; aiUsable: boolean; feedQuality: string; staleReason: string | null; fallbackReason: string | null };
type Snap = { providers: Array<{ id: string; category: string; status: string }>; symbolProbes: unknown[]; summary: Record<string, number>;
  assetClassActivity?: Activity[] };
let snap: Snap;
mock.module("../../data/providerHealth.js", {
  namedExports: { getProviderHealthSnapshot: async () => snap },
});
const { LAYER_ADAPTERS } = await import("../layerAdapters.js");
const adapter = LAYER_ADAPTERS.MARKET_DATA;

const probe = (symbol: string, candles: boolean, quote: boolean) => ({
  symbol, assetClass: "forex", timeframe: "M5",
  candles: { ok: candles, primaryProvider: candles ? "twelve_data" : null, candleCount: candles ? 5 : 0, attempts: [], userMessage: "", adminDetail: "" },
  quote: { ok: quote, primaryProvider: quote ? "twelve_data" : null, attempts: [], userMessage: "", adminDetail: "" },
});
function summary(providers: Snap["providers"]) {
  return { totalProviders: providers.length, healthy: providers.filter(p => p.status === "healthy").length,
    degraded: providers.filter(p => p.status === "degraded").length, failing: providers.filter(p => p.status === "failing").length,
    notConfigured: providers.filter(p => p.status === "not_configured").length, reserved: providers.filter(p => p.status === "reserved").length,
    configuredButUnused: 0 };
}
// The real snapshot always carries the per-asset-class feed truth (the same
// resolver the chart uses); a clean, current class is what PASS needs.
const activity = (assetClass: string, symbol: string, feedQuality: string, lastCandleTime: string | null = new Date().toISOString(),
  lastQuoteTime: string | null = null): Activity => ({
  assetClass, representativeSymbol: symbol, latestCandleProvider: "assistant_real:twelve_data", latestQuoteProvider: "assistant_real:twelve_data",
  lastCandleTime, lastQuoteTime, aiUsable: feedQuality === "clean", feedQuality, staleReason: null, fallbackReason: null,
});
const cleanForex = [activity("forex", "EURUSD", "clean")];
// null = a snapshot with no assetClassActivity field at all.
function set(providers: Snap["providers"], probes: unknown[], assetClassActivity: Activity[] | null = cleanForex) {
  snap = { providers, symbolProbes: probes, summary: summary(providers), ...(assetClassActivity ? { assetClassActivity } : {}) };
}

const keysOnly = [
  { id: "mt5_broker", category: "broker", status: "reserved" },
  { id: "deriv", category: "synthetic", status: "not_configured" },
  { id: "twelve_data", category: "market_data", status: "not_configured" },
  { id: "newsapi", category: "news", status: "healthy" },
  { id: "openai", category: "ai", status: "healthy" },
];

test("OpenAI and NewsAPI keys alone never make the market-data layer PASS", async () => {
  set(keysOnly, [probe("EURUSD", false, false), probe("XAUUSD", false, false)]);
  assert.equal(snap.summary.healthy, 2); assert.equal(snap.summary.degraded, 0);
  const r = await adapter();
  assert.notEqual(r.status, "PASS");
  assert.equal(r.status, "NOT_AVAILABLE");
  assert.match(r.detail, /no healthy market-data provider/);
});

test("a healthy market-data provider whose probes return nothing is not PASS", async () => {
  const providers = [...keysOnly.slice(0, 2), { id: "twelve_data", category: "market_data", status: "healthy" }];
  set(providers, [probe("EURUSD", false, false), probe("XAUUSD", false, false)]);
  const none = await adapter();
  assert.equal(none.status, "NOT_AVAILABLE"); assert.match(none.detail, /no probed symbol returned candles or a quote/);
  set(providers, [probe("EURUSD", true, true), probe("XAUUSD", false, false)]);
  const some = await adapter();
  assert.equal(some.status, "WARN"); assert.match(some.detail, /candles 1\/2, quotes 1\/2/); assert.match(some.detail, /XAUUSD/);
  set(providers, [probe("EURUSD", true, true), probe("XAUUSD", true, true)]);
  const all = await adapter();
  assert.equal(all.status, "PASS"); assert.match(all.detail, /candles 2\/2, quotes 2\/2/);
  set(providers, []);
  assert.equal((await adapter()).status, "NOT_AVAILABLE");
});

// "Some data came back" is not "the data is current": a probe quote that the
// adapter marked STALE or DELAYED still has ok:true. The per-asset-class feed
// truth in the same snapshot says whether the data is current.
test("probes that all returned data on a stale or delayed feed are not PASS", async () => {
  const providers = [...keysOnly.slice(0, 2), { id: "twelve_data", category: "market_data", status: "healthy" }];
  const probes = [probe("EURUSD", true, true), probe("XAUUSD", true, true), probe("BTCUSD", true, true)];
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  set(providers, probes, [
    activity("forex", "EURUSD", "stale", dayAgo),
    activity("metals", "XAUUSD", "delayed", hourAgo),
    activity("crypto", "BTCUSD", "clean"),
  ]);
  const r = await adapter();
  assert.notEqual(r.status, "PASS");
  assert.equal(r.status, "WARN");
  assert.match(r.detail, /candles 3\/3, quotes 3\/3/);
  assert.match(r.detail, /not current/i);
  assert.match(r.detail, /forex \(EURUSD\) stale/);
  assert.match(r.detail, /metals \(XAUUSD\) delayed/);
  assert.doesNotMatch(r.detail, /crypto/);
  // Age of the oldest not-current class (the stale forex series, about a day).
  assert.ok(r.ageMs != null && r.ageMs >= 86_000_000 && r.ageMs < 90_000_000, String(r.ageMs));
});

test("feed freshness that could not be checked is not PASS", async () => {
  const providers = [...keysOnly.slice(0, 2), { id: "twelve_data", category: "market_data", status: "healthy" }];
  const probes = [probe("EURUSD", true, true)];
  set(providers, probes, [activity("forex", "EURUSD", "unknown", null)]);
  const unknown = await adapter();
  assert.equal(unknown.status, "WARN");
  assert.match(unknown.detail, /forex \(EURUSD\) freshness could not be checked/);
  set(providers, probes, null);
  assert.equal("assetClassActivity" in snap, false);
  const missing = await adapter();
  assert.equal(missing.status, "WARN");
  assert.match(missing.detail, /feed freshness was not reported/i);
  set(providers, probes, []);
  assert.equal((await adapter()).status, "WARN");
});

// A closed market is not a stale feed. The row's staleReason carries the
// feed's own words (the chart's lag warning: "Market closed ... Not a feed
// fault"), so the detail names the class with that reason, not the bare grade.
test("a closed-market class is described with the feed's own reason, not as a 'stale' feed", async () => {
  const providers = [...keysOnly.slice(0, 2), { id: "twelve_data", category: "market_data", status: "healthy" }];
  const probes = [probe("EURUSD", true, true), probe("AAPL", true, true)];
  const friday = "2026-10-30T20:55:00.000Z";
  set(providers, probes, [
    { ...activity("forex", "EURUSD", "stale", friday),
      staleReason: "Market closed for EURUSD since the scheduled weekend close (2026-10-30 21:00 UTC); newest bar opened 2026-10-30 20:55 UTC. Not a feed fault, and not live data." },
    { ...activity("stocks", "AAPL", "stale", friday),
      staleReason: "No new AAPL bar since one opened 2026-10-30 20:55 UTC (40 bars behind the current bar). The market may be closed or the feed delayed; this is not live data." },
  ]);
  const r = await adapter();
  assert.equal(r.status, "WARN");
  assert.doesNotMatch(r.detail, /\(EURUSD\) stale|\(AAPL\) stale/, r.detail);
  assert.match(r.detail, /forex \(EURUSD\): Market closed for EURUSD since the scheduled weekend close .*Not a feed fault, and not live data \(last candle 2026-10-30 20:55 UTC\)/, r.detail);
  assert.match(r.detail, /stocks \(AAPL\): No new AAPL bar since .*The market may be closed or the feed delayed; this is not live data \(last candle 2026-10-30 20:55 UTC\)/, r.detail);
});
