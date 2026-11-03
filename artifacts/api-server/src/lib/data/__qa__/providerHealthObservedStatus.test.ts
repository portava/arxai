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
  // Twelve Data comes first in the chain, so it was tried on every request
  // Polygon answered and gave nothing usable: failing, never "not checked".
  assert.equal(td.status, "failing");
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

// ── Status vocabulary: say what the state is ────────────────────────────────

test("MT5 bridge with no push in the freshness window is 'offline', not 'reserved'", async () => {
  const snap = await getProviderHealthSnapshot();
  const mt5 = byId(snap, "mt5_broker");
  assert.notEqual(mt5.status, "reserved");
  assert.equal(mt5.status, "offline");
  assert.match(mt5.statusReason, /no MT5 candle or quote push/i);
  assert.equal(snap.summary.offline, 1);
  assert.equal(snap.summary.reserved, 0);
});

test("a configured adapter the selected provider does not hold is idle, not 'degraded'", async () => {
  process.env.TWELVEDATA_API_KEY = "td-key-0000";
  process.env.POLYGON_API_KEY = "pg-key-1111";
  process.env.ALPHA_VANTAGE_API_KEY = "av-key-2222";
  assistantName = "twelve_data"; // the running provider holds Twelve Data only
  const snap = await getProviderHealthSnapshot();
  for (const id of ["polygon", "alpha_vantage"]) {
    const p = byId(snap, id);
    assert.notEqual(p.status, "degraded", id);
    assert.equal(p.status, "unverified", id);
    assert.equal(p.configuredButUnused, true, id);
    assert.match(p.statusReason, /not in the selected assistant provider/i);
  }
  assert.equal(snap.summary.degraded, 0);
});

// ── Active consumers: only providers something observed answering ──────────

test("active consumers never list a provider only because its key is set", async () => {
  process.env.FINNHUB_API_KEY = "fh-key-1234";
  process.env.NEWSAPI_API_KEY = "news-key-5678";
  process.env.OPENAI_API_KEY = "sk-test-9012";
  assistantName = "twelve_data_missing"; // Finnhub is not in the running provider
  const snap = await getProviderHealthSnapshot();
  const listed = new Set(snap.activeConsumers.flatMap((c) => c.providers));
  for (const id of ["finnhub", "newsapi", "openai"]) assert.equal(listed.has(id), false, id);
  for (const consumer of ["scanner", "chart", "trade_ticket", "ruby", "news"]) {
    const row = snap.activeConsumers.find((c) => c.consumer === consumer);
    assert.ok(!row || !row.providers.includes("finnhub"), consumer);
  }
});

test("active consumers list an adapter once it answered this snapshot's self-test", async () => {
  process.env.FINNHUB_API_KEY = "fh-key-1234";
  assistantName = "finnhub";
  routerPlan = () => ({
    ok: true, primaryProvider: "assistant_real:finnhub",
    attempts: [mt5Miss, { provider: "assistant_real:finnhub", ok: true, reason: null, ms: 30 }],
  });
  const snap = await getProviderHealthSnapshot();
  assert.deepEqual(snap.activeConsumers.find((c) => c.consumer === "scanner")?.providers, ["finnhub"]);
  assert.match(snap.activeConsumersBasis, /answered this snapshot's self-test/i);
});

// ── Composite chain order: what was tried, and what was never called ────────
// The composite walks its adapters in order and falls through only when one
// gives no usable answer. An adapter ahead of the one that answered was tried
// and failed; an adapter behind it was never called.

test("composite: an adapter tried before the one that answered, on every request, is 'failing' (not 'not checked')", async () => {
  process.env.TWELVEDATA_API_KEY = "td-expired-key-0000";
  process.env.POLYGON_API_KEY = "pg-key-1111";
  assistantName = "composite(twelve_data,polygon)";
  routerPlan = () => ({
    ok: true, primaryProvider: "assistant_real:polygon",
    attempts: [mt5Miss, { provider: "assistant_real:polygon", ok: true, reason: null, ms: 25 }],
  });
  const snap = await getProviderHealthSnapshot();
  const td = byId(snap, "twelve_data");
  assert.equal(td.status, "failing", td.statusReason);
  assert.match(td.statusReason, /did not answer any of the 12 self-test requests/i);
  assert.match(td.statusReason, /On 12 of them it was tried before Polygon/i);
  assert.match(td.statusReason, /no usable answer/i);
  assert.doesNotMatch(td.statusReason, /not checked|not called/i);
  assert.equal(td.lastSelfTestOk, false);
  assert.equal(byId(snap, "polygon").status, "healthy");
  assert.equal(snap.summary.failing, 1);
  assert.equal(snap.summary.unverified, 0);
});

test("composite: an adapter behind the one that answered every request was never called — 'unverified', not 'did not answer'", async () => {
  process.env.TWELVEDATA_API_KEY = "td-key-0000";
  process.env.POLYGON_API_KEY = "pg-key-1111";
  assistantName = "composite(twelve_data,polygon)";
  routerPlan = () => ({
    ok: true, primaryProvider: "assistant_real:twelve_data",
    attempts: [mt5Miss, { provider: "assistant_real:twelve_data", ok: true, reason: null, ms: 20 }],
  });
  const snap = await getProviderHealthSnapshot();
  const pg = byId(snap, "polygon");
  assert.equal(pg.status, "unverified");
  assert.doesNotMatch(pg.statusReason, /did not answer/i, pg.statusReason);
  assert.match(pg.statusReason, /not called/i);
  assert.match(pg.statusReason, /Twelve Data answered first/i);
  assert.equal(byId(snap, "twelve_data").status, "healthy");
});

test("composite: an adapter that answered some requests and was passed over on others says both", async () => {
  process.env.TWELVEDATA_API_KEY = "td-key-0000";
  process.env.POLYGON_API_KEY = "pg-key-1111";
  assistantName = "composite(twelve_data,polygon)";
  // Twelve Data answers quotes; its candles come back empty, so Polygon serves them.
  routerPlan = (leg) => leg === "quote"
    ? { ok: true, primaryProvider: "assistant_real:twelve_data", attempts: [mt5Miss, { provider: "assistant_real:twelve_data", ok: true, reason: null, ms: 20 }] }
    : { ok: true, primaryProvider: "assistant_real:polygon", attempts: [mt5Miss, { provider: "assistant_real:polygon", ok: true, reason: null, ms: 25 }] };
  const snap = await getProviderHealthSnapshot();
  const td = byId(snap, "twelve_data");
  assert.equal(td.status, "healthy");
  assert.match(td.statusReason, /answered 6 of the 12/i);
  assert.match(td.statusReason, /on the other 6 it was tried before Polygon/i);
  const pg = byId(snap, "polygon");
  assert.equal(pg.status, "healthy");
  assert.match(pg.statusReason, /answered 6 of the 12/i);
});

test("TD + Finnhub hybrid in a composite: a quote Polygon served means Finnhub (the hybrid's quote leg) was tried, not Twelve Data", async () => {
  process.env.TWELVEDATA_API_KEY = "td-key-0000";
  process.env.FINNHUB_API_KEY = "fh-key-1234";
  process.env.POLYGON_API_KEY = "pg-key-1111";
  assistantName = "composite(twelve_data,polygon)";
  routerPlan = (leg) => leg === "quote"
    ? { ok: true, primaryProvider: "assistant_real:polygon", attempts: [mt5Miss, { provider: "assistant_real:polygon", ok: true, reason: null, ms: 25 }] }
    : { ok: true, primaryProvider: "assistant_real:twelve_data", attempts: [mt5Miss, { provider: "assistant_real:twelve_data", ok: true, reason: null, ms: 20 }] };
  const snap = await getProviderHealthSnapshot();
  const fh = byId(snap, "finnhub");
  assert.equal(fh.status, "failing", fh.statusReason);
  assert.match(fh.statusReason, /On 6 of them it was tried before Polygon/i);
  const td = byId(snap, "twelve_data");
  assert.equal(td.status, "healthy");
  assert.doesNotMatch(td.statusReason, /tried before/i, td.statusReason);
});

test("TD + Finnhub hybrid: Finnhub is counted only over the quote requests it could be sent, and Twelve Data only over candles", async () => {
  process.env.TWELVEDATA_API_KEY = "td-key-0000";
  process.env.FINNHUB_API_KEY = "fh-key-1234";
  process.env.POLYGON_API_KEY = "pg-key-1111";
  assistantName = "composite(twelve_data,polygon)";
  routerPlan = (leg) => leg === "quote"
    ? { ok: true, primaryProvider: "assistant_real:polygon", attempts: [mt5Miss, { provider: "assistant_real:polygon", ok: true, reason: null, ms: 25 }] }
    : { ok: true, primaryProvider: "assistant_real:twelve_data", attempts: [mt5Miss, { provider: "assistant_real:twelve_data", ok: true, reason: null, ms: 20 }] };
  const snap = await getProviderHealthSnapshot();
  const fh = byId(snap, "finnhub");
  assert.equal(fh.status, "failing", fh.statusReason);
  // 6 quote requests could reach Finnhub; the 6 candle requests never could.
  assert.doesNotMatch(fh.statusReason, /any of the 12/i, fh.statusReason);
  assert.match(fh.statusReason, /did not answer any of the 6 self-test requests/i, fh.statusReason);
  assert.match(fh.statusReason, /not used for candle requests, so the other 6 were never sent to it/i, fh.statusReason);
  const td = byId(snap, "twelve_data");
  assert.equal(td.status, "healthy");
  assert.doesNotMatch(td.statusReason, /of the 12/i, td.statusReason);
  assert.match(td.statusReason, /answered 6 of the 6 self-test requests/i, td.statusReason);
  assert.match(td.statusReason, /not used for quote requests, so the other 6 were never sent to it/i, td.statusReason);
});
