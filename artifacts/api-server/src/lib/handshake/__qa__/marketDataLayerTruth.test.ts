// Handshake MARKET_DATA layer: PASS needs market-data evidence — a serving
// price provider and symbol probes that actually returned candles and quotes.
// An OpenAI or NewsAPI key is not a market-data provider.
//
// The provider-health snapshot is mocked (no provider, DB, broker or network).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

type Snap = { providers: Array<{ id: string; category: string; status: string }>; symbolProbes: unknown[]; summary: Record<string, number> };
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
function set(providers: Snap["providers"], probes: unknown[]) { snap = { providers, symbolProbes: probes, summary: summary(providers) }; }

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
