// QA — Provider Health only says "healthy" when something was observed.
//
// A key being set is not a health check. Twelve Data / Polygon / Finnhub /
// Alpha Vantage were "healthy" whenever their key was set (or they were the
// selected adapter), NewsAPI / OpenAI whenever their key was set, and
// "failing" was unreachable — so an expired key or an upstream outage still
// showed a green badge and the Failing tile always read 0. Status must come
// from this snapshot's self-test: answered → healthy, every request that
// reached the assistant feed failed → failing, nothing checked → unverified.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//   src/lib/data/__qa__/providerHealthObservedStatus.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

type Attempt = { provider: string; ok: boolean; reason: string | null; ms: number };
type Leg = "candles" | "quote";
// Per-test router behaviour: what each probe leg reports.
let routerPlan: (leg: Leg, symbol: string) => { ok: boolean; primaryProvider: string | null; attempts: Attempt[] } | "throw" =
  () => "throw";
let assistantName = "none";

function legResult(leg: Leg, symbol: string) {
  const plan = routerPlan(leg, symbol);
  if (plan === "throw") throw new Error("offline");
  return leg === "candles"
    ? { ...plan, symbol, assetClass: "forex", candles: plan.ok ? [{ time: 1, open: 1, high: 1, low: 1, close: 1 }] : [], userMessage: "", adminDetail: "" }
    : { ...plan, symbol, assetClass: "forex", quote: null, userMessage: "", adminDetail: "" };
}

mock.module("../marketDataRouter.js", { namedExports: {
  classifySymbol: () => "forex",
  getRouterDiagnostics: () => ({ chainsByAssetClass: { forex: ["mt5_broker", "assistant_real"] } }),
  routeCandles: async (symbol: string) => legResult("candles", symbol),
  routeQuote: async (symbol: string) => legResult("quote", symbol),
} });
mock.module("../../assistant/marketProvider.js", { namedExports: {
  getMarketProvider: () => ({ name: assistantName }),
  getMarketStatus: () => ({
    provider: assistantName, connected: false, configured: assistantName !== "none",
    freshnessState: "NEVER_FETCHED", dataFreshness: null, dataSource: null,
    lastSuccessfulFetchAt: null, lastErrorAt: null, unavailableReason: null,
  }),
} });
mock.module("../providers/derivProvider.js", { namedExports: {
  getDerivFeedStatus: () => ({
    mode: "public", configured: false, connected: false, healthSummary: "unconfigured",
    feedReadinessState: "UNCONFIGURED", lastTickAt: null, lastCandleAt: null,
    hasRecentTick: false, activeSymbolsLoaded: false, message: "Deriv not configured.",
  }),
} });
mock.module("../chart/chartDataService.js", { namedExports: { getChartFeedStatus: async () => null } });
mock.module("../../mt5/currentConnectedBridgeDetector.js", { namedExports: { detectCurrentConnectedBridge: async () => null } });
mock.module("../../news/economicCalendarProvider.js", { namedExports: {
  getCalendarHealthSnapshot: async () => { throw new Error("offline"); },
} });

const { __resetMt5ProviderStore } = await import("../providers/mt5Provider.js");
const { getProviderHealthSnapshot } = await import("../providerHealth.js");

const KEYS = ["TWELVEDATA_API_KEY", "POLYGON_API_KEY", "FINNHUB_API_KEY", "ALPHA_VANTAGE_API_KEY", "NEWSAPI_API_KEY", "OPENAI_API_KEY"];
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  __resetMt5ProviderStore();
  routerPlan = () => "throw";
  assistantName = "none";
});

const mt5Miss: Attempt = { provider: "mt5_broker", ok: false, reason: "MT5_BROKER_FEED_NOT_ACTIVE", ms: 1 };
const byId = (snap: Awaited<ReturnType<typeof getProviderHealthSnapshot>>, id: string) => {
  const p = snap.providers.find((x) => x.id === id);
  assert.ok(p, `provider ${id} listed`);
  return p;
};

test("a set key with no check behind it is not 'healthy' (Finnhub / NewsAPI / OpenAI)", async () => {
  process.env.FINNHUB_API_KEY = "fh-expired-key-1234";
  process.env.NEWSAPI_API_KEY = "news-key-5678";
  process.env.OPENAI_API_KEY = "sk-test-9012";
  assistantName = "finnhub";
  // The self-test could not run at all (router threw) — nothing was observed.
  const snap = await getProviderHealthSnapshot();
  for (const id of ["finnhub", "newsapi", "openai"]) {
    const p = byId(snap, id);
    assert.equal(p.configured, true);
    assert.notEqual(p.status, "healthy", `${id} has no observed check`);
    assert.equal(p.status, "unverified");
    assert.match(p.statusReason, /not checked/i);
  }
  assert.equal(snap.summary.healthy, 0);
  assert.equal(snap.summary.unverified, 3);
});

test("every self-test request to the selected adapter failed → 'failing', and the Failing tile counts it", async () => {
  process.env.FINNHUB_API_KEY = "fh-expired-key-1234";
  assistantName = "finnhub";
  routerPlan = () => ({
    ok: false, primaryProvider: null,
    attempts: [mt5Miss, { provider: "assistant_real:finnhub", ok: false, reason: "PROVIDER_FETCH_ERROR", ms: 40 }],
  });
  const snap = await getProviderHealthSnapshot();
  const fh = byId(snap, "finnhub");
  assert.equal(fh.status, "failing");
  assert.match(fh.statusReason, /failed/);
  assert.match(fh.statusReason, /PROVIDER_FETCH_ERROR/);
  assert.equal(fh.lastSelfTestOk, false);
  assert.equal(snap.summary.failing, 1);
  assert.equal(snap.summary.healthy, 0);
});

test("selected Twelve Data whose probes all failed is 'failing', not 'healthy'", async () => {
  process.env.TWELVEDATA_API_KEY = "td-key-0000";
  assistantName = "twelve_data";
  routerPlan = () => ({
    ok: false, primaryProvider: null,
    attempts: [mt5Miss, { provider: "assistant_real:twelve_data", ok: false, reason: "NO_CANDLES_RETURNED", ms: 12 }],
  });
  const snap = await getProviderHealthSnapshot();
  assert.equal(byId(snap, "twelve_data").status, "failing");
});

test("an adapter that answered this snapshot's self-test is 'healthy' and says how many it answered", async () => {
  process.env.FINNHUB_API_KEY = "fh-good-key-1234";
  assistantName = "finnhub";
  routerPlan = () => ({
    ok: true, primaryProvider: "assistant_real:finnhub",
    attempts: [mt5Miss, { provider: "assistant_real:finnhub", ok: true, reason: null, ms: 30 }],
  });
  const snap = await getProviderHealthSnapshot();
  const fh = byId(snap, "finnhub");
  assert.equal(fh.status, "healthy");
  assert.match(fh.statusReason, /answered 12 of the 12 self-test requests/i);
});

test("composite chain: members are selected, and one that never answered is not 'healthy'", async () => {
  process.env.TWELVEDATA_API_KEY = "td-key-0000";
  process.env.POLYGON_API_KEY = "pg-key-1111";
  assistantName = "composite(twelve_data,polygon)";
  // Twelve Data returned nothing; Polygon (the fallback) answered everything.
  routerPlan = () => ({
    ok: true, primaryProvider: "assistant_real:polygon",
    attempts: [mt5Miss, { provider: "assistant_real:polygon", ok: true, reason: null, ms: 25 }],
  });
  const snap = await getProviderHealthSnapshot();
  const td = byId(snap, "twelve_data");
  const pg = byId(snap, "polygon");
  assert.equal(pg.status, "healthy");
  assert.equal(td.status, "unverified");
  assert.match(td.statusReason, /did not answer any/i);
  // Both are in the selected chain — neither is "configured but unused".
  assert.equal(td.configuredButUnused, false);
  assert.equal(pg.configuredButUnused, false);
  assert.deepEqual(pg.selectedForAssetClasses, ["forex"]);
});

test("MT5 answered first so the assistant feed was never reached → keyed adapters are 'unverified'", async () => {
  process.env.TWELVEDATA_API_KEY = "td-key-0000";
  process.env.FINNHUB_API_KEY = "fh-key-1234";
  assistantName = "twelve_data"; // TD + Finnhub hybrid keeps the TD name
  routerPlan = () => ({
    ok: true, primaryProvider: "mt5_broker",
    attempts: [{ provider: "mt5_broker", ok: true, reason: null, ms: 1 }],
  });
  const snap = await getProviderHealthSnapshot();
  for (const id of ["twelve_data", "finnhub"]) {
    const p = byId(snap, id);
    assert.equal(p.status, "unverified", id);
    assert.match(p.statusReason, /no self-test request in this snapshot reached the assistant feed/i);
  }
});
