// Truth: getMarketStatus().freshnessState is FRESH after ANY successful
// provider call (news, calendar, overview included), and dataFreshness keeps
// the quality of the last quote payload with no time attached. A consumer
// therefore could not tell "a real-time quote just arrived" from "a news fetch
// just succeeded; the last quote, hours ago, was real-time". dataFreshnessAt
// stamps when that quote quality was observed, so the page can require a recent
// real-time quote before it says FRESH.
import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  _markMarketFetchSuccessForTests,
  _resetMarketProviderForTests,
  getMarketProvider,
  getMarketStatus,
} from "../marketProvider.js";

afterEach(() => _resetMarketProviderForTests());

test("a DELAYED quote payload is reported with the time it was observed", () => {
  _resetMarketProviderForTests();
  const before = Date.now();
  _markMarketFetchSuccessForTests({ freshness: "DELAYED", source: "polygon" });
  const s = getMarketStatus() as ReturnType<typeof getMarketStatus> & { dataFreshnessAt?: string | null };
  assert.equal(s.dataFreshness, "DELAYED");
  assert.ok(s.dataFreshnessAt, "dataFreshnessAt must be set when a payload quality is observed");
  assert.ok(Date.parse(s.dataFreshnessAt!) >= before - 1000);
});

test("a success with no quote payload (news, calendar) does not stamp a quote observation", () => {
  _resetMarketProviderForTests();
  _markMarketFetchSuccessForTests();
  const s = getMarketStatus() as ReturnType<typeof getMarketStatus> & { dataFreshnessAt?: string | null };
  assert.equal(s.dataFreshness, null);
  assert.equal(s.dataFreshnessAt ?? null, null);
});

test("reset clears the last observed quote quality", () => {
  _markMarketFetchSuccessForTests({ freshness: "REALTIME", source: "twelve_data" });
  _resetMarketProviderForTests();
  const s = getMarketStatus() as ReturnType<typeof getMarketStatus> & { dataFreshnessAt?: string | null };
  assert.equal(s.dataFreshness, null);
  assert.equal(s.dataFreshnessAt ?? null, null);
});

// Truth: Finnhub (and the TD+Finnhub hybrid's quote path) and Polygon stock
// snapshots called markSuccess() with no observed quality, so a real-time quote
// left dataFreshness null and Market Health read NO RECENT QUOTE beside a
// FRESH provider. Only Twelve Data CANDLE fetches stamped "REALTIME", and the
// page called that candle fetch the "Last quote". Every served quote now
// records its quality as classified from its own timestamp, and the status
// says which kind of payload the observation was.
const KEYS = ["TWELVEDATA_API_KEY", "POLYGON_API_KEY", "FINNHUB_API_KEY", "ALPHA_VANTAGE_API_KEY", "NEWSAPI_API_KEY"];
const realFetch = globalThis.fetch;
function withOnlyKeys(env: Record<string, string>, body: (url: string) => unknown) {
  const saved = KEYS.map((k) => process.env[k]);
  KEYS.forEach((k) => { delete process.env[k]; });
  Object.assign(process.env, env);
  // No network: every provider request is answered by the fixture.
  globalThis.fetch = (async (url: string) => Response.json(body(String(url)))) as typeof fetch;
  _resetMarketProviderForTests();
  return () => {
    KEYS.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    globalThis.fetch = realFetch;
    _resetMarketProviderForTests();
  };
}
type Status = ReturnType<typeof getMarketStatus> & { dataFreshnessAt?: string | null; dataKind?: string | null };

test("a real-time Finnhub quote is recorded as a real-time quote observation", async () => {
  const restore = withOnlyKeys({ FINNHUB_API_KEY: "offline-fixture" }, () => ({ c: 1.0842, t: Math.floor(Date.now() / 1000) }));
  try {
    const q = await getMarketProvider().getLiveQuote("EURUSD");
    assert.equal(q.freshness, "REALTIME");
    const s = getMarketStatus() as Status;
    assert.equal(s.freshnessState, "FRESH");
    assert.equal(s.dataFreshness, "REALTIME");
    assert.equal(s.dataSource, "finnhub");
    assert.equal(s.dataKind, "quote");
    assert.ok(s.dataFreshnessAt);
  } finally { restore(); }
});

test("an old Finnhub quote (Friday close read at the weekend) is not recorded as real-time", async () => {
  const restore = withOnlyKeys({ FINNHUB_API_KEY: "offline-fixture" }, () => ({ c: 1.0842, t: Math.floor((Date.now() - 40 * 3_600_000) / 1000) }));
  try {
    await getMarketProvider().getLiveQuote("EURUSD");
    const s = getMarketStatus() as Status;
    assert.notEqual(s.dataFreshness, "REALTIME");
    assert.equal(s.dataFreshness, "STALE");
    assert.equal(s.dataKind, "quote");
  } finally { restore(); }
});

test("a Twelve Data candle fetch is recorded as a candle observation, not a quote", async () => {
  const restore = withOnlyKeys({ TWELVEDATA_API_KEY: "offline-fixture", FINNHUB_API_KEY: "offline-fixture" }, () => ({
    status: "ok",
    values: Array.from({ length: 12 }, (_, i) => ({ datetime: new Date(Date.now() - i * 900_000).toISOString().slice(0, 19).replace("T", " "), open: "1.08", high: "1.09", low: "1.07", close: "1.085" })),
  }));
  try {
    const r = await getMarketProvider().getCandles("EURUSD", "M15", 12);
    assert.ok(r.candles.length > 0);
    const s = getMarketStatus() as Status;
    assert.equal(s.dataSource, "twelve_data");
    assert.equal(s.dataKind, "candles");
  } finally { restore(); }
});

// Truth: Twelve Data and Polygon candle fetches stamped a blanket "REALTIME"
// observation without looking at the bars. At the weekend a Finnhub quote was
// correctly recorded STALE, then the next candle fetch of Friday's bars
// replaced it with REALTIME, and Market Health showed a green FRESH with
// "Last candles: real-time from twelve_data". A candle observation is now
// age-checked from its newest bar, and it never replaces a quote observation
// seen within the stale window (a quote carries its own timestamp; a candle
// series does not say when its last price traded).
const H = 3_600_000;
function tdValues(newestMs: number, stepMs: number, n = 12) {
  return Array.from({ length: n }, (_, i) => ({
    datetime: new Date(newestMs - i * stepMs).toISOString().slice(0, 19).replace("T", " "),
    open: "1.08", high: "1.09", low: "1.07", close: "1.085",
  }));
}

test("old Twelve Data candles (Friday's bars read at the weekend) are not recorded as real-time", async () => {
  const fridayClose = Date.now() - 40 * H;
  const restore = withOnlyKeys({ TWELVEDATA_API_KEY: "offline-fixture" }, () => ({ status: "ok", values: tdValues(fridayClose, 900_000) }));
  try {
    const r = await getMarketProvider().getCandles("EURUSD", "M15", 12);
    assert.ok(r.candles.length > 0);
    const s = getMarketStatus() as Status;
    assert.equal(s.dataKind, "candles");
    assert.notEqual(s.dataFreshness, "REALTIME");
    assert.equal(s.dataFreshness, "STALE");
  } finally { restore(); }
});

test("in the Twelve Data + Finnhub hybrid a candle fetch does not overwrite the stale quote verdict", async () => {
  const fridayClose = Date.now() - 40 * H;
  const restore = withOnlyKeys({ TWELVEDATA_API_KEY: "offline-fixture", FINNHUB_API_KEY: "offline-fixture" }, (url) =>
    url.includes("twelvedata")
      // Even a series whose newest bar is current must not replace the quote.
      ? { status: "ok", values: tdValues(Date.now(), 900_000) }
      : { c: 1.0842, t: Math.floor(fridayClose / 1000) });
  try {
    const p = getMarketProvider();
    await p.getLiveQuote("EURUSD");
    await p.getCandles("EURUSD", "M15", 12);
    const s = getMarketStatus() as Status;
    assert.equal(s.dataFreshness, "STALE");
    assert.equal(s.dataKind, "quote");
    assert.equal(s.dataSource, "finnhub");
  } finally { restore(); }
});

test("yesterday's closed Polygon daily bar is not recorded as real-time", async () => {
  const dayMs = 24 * H;
  const yesterdayOpen = Math.floor(Date.now() / dayMs) * dayMs - dayMs;
  const restore = withOnlyKeys({ POLYGON_API_KEY: "offline-fixture" }, () => ({
    status: "OK",
    // sort=desc: newest first.
    results: Array.from({ length: 12 }, (_, i) => ({ t: yesterdayOpen - i * dayMs, o: 1.08, h: 1.09, l: 1.07, c: 1.085 })),
  }));
  try {
    const r = await getMarketProvider().getCandles("EURUSD", "D1", 12);
    assert.ok(r.candles.length > 0);
    const s = getMarketStatus() as Status;
    assert.equal(s.dataKind, "candles");
    assert.equal(s.dataSource, "polygon");
    assert.notEqual(s.dataFreshness, "REALTIME");
  } finally { restore(); }
});

test("a candle series whose newest bar is stamped seconds ago is recorded as real-time", async () => {
  const restore = withOnlyKeys({ TWELVEDATA_API_KEY: "offline-fixture" }, () => ({ status: "ok", values: tdValues(Date.now() - 2_000, 60_000) }));
  try {
    await getMarketProvider().getCandles("EURUSD", "M1", 12);
    const s = getMarketStatus() as Status;
    assert.equal(s.dataKind, "candles");
    assert.equal(s.dataFreshness, "REALTIME");
  } finally { restore(); }
});

// Truth: Twelve Data stamps each bar with its OPEN time and includes the bar
// still forming. At 14:07 UTC an M15 fetch's newest bar is the 14:00 bar, 7
// minutes "old" — past the 15 s real-time window, so not REALTIME — yet the
// shared trailing-interval rule (the one the chart router applies to the same
// bars) calls the series clean. The observation was recorded DELAYED anyway,
// so Market Health showed an amber DELAYED badge ("Last candles: delayed from
// twelve_data") while the chart called the same feed current, and the M1
// verdict flipped with the wall-clock second of the fetch. DELAYED is now
// recorded only when the shared rule says delayed; a clean series that is not
// stamped within the real-time window is recorded as CANDLES_CURRENT (the
// candles are current, no real-time price was confirmed).
const WED_1400 = Date.UTC(2026, 10, 4, 14, 0);

async function observedAt(nowMs: number, tf: string, values: unknown[]): Promise<Status> {
  mock.timers.enable({ apis: ["Date"], now: nowMs });
  const restore = withOnlyKeys({ TWELVEDATA_API_KEY: "offline-fixture" }, () => ({ status: "ok", values }));
  try {
    const r = await getMarketProvider().getCandles("EURUSD", tf, 12);
    assert.ok(r.candles.length > 0);
    return getMarketStatus() as Status;
  } finally { restore(); mock.timers.reset(); }
}

test("a clean Twelve Data M15 series whose forming bar opened 7 minutes ago is current candles, not DELAYED", async () => {
  const s = await observedAt(WED_1400 + 7 * 60_000, "M15", tdValues(WED_1400, 900_000));
  assert.equal(s.dataKind, "candles");
  assert.notEqual(s.dataFreshness, "DELAYED");
  assert.notEqual(s.dataFreshness, "REALTIME");
  assert.equal(s.dataFreshness, "CANDLES_CURRENT");
});

test("an M1 fetch 40 seconds into the minute is current candles, not DELAYED", async () => {
  const s = await observedAt(WED_1400 + 7 * 60_000 + 40_000, "M1", tdValues(WED_1400 + 7 * 60_000, 60_000));
  assert.notEqual(s.dataFreshness, "DELAYED");
  assert.equal(s.dataFreshness, "CANDLES_CURRENT");
});

test("a Twelve Data M15 series one bar overdue under the shared rule is still DELAYED", async () => {
  const s = await observedAt(WED_1400 + 7 * 60_000, "M15", tdValues(WED_1400 - 900_000, 900_000));
  assert.equal(s.dataFreshness, "DELAYED");
});

// Truth: only the Market Health observation was age-checked. The CandleResult
// that Twelve Data, Polygon and Finnhub return from getCandles still said
// freshness "REALTIME" without looking at the bars — Friday's bars at the
// weekend, yesterday's daily bar. The router turns that into the provenance
// fact "delayed: false" (known real-time) and the release probe prints it.
// A "REALTIME" CandleResult from those adapters is now age-checked from its
// newest bar (cache hits included): STALE when the shared rule says stale,
// UNCONFIRMED when the series is not stale but no real-time price was
// confirmed. Neither maps to "delayed: true", so the scanner's quote binding
// and market-read evidence (which act only on delayed === true / truthy)
// behave exactly as before.
async function candlesAt(nowMs: number, tf: string, env: Record<string, string>, body: (url: string) => unknown) {
  mock.timers.enable({ apis: ["Date"], now: nowMs });
  const restore = withOnlyKeys(env, body);
  try {
    return await getMarketProvider().getCandles("EURUSD", tf, 12);
  } finally { restore(); mock.timers.reset(); }
}
const SAT_NOON = Date.UTC(2026, 9, 31, 12, 0);
const FRI_2145 = Date.UTC(2026, 9, 30, 21, 45);

test("Friday's Twelve Data bars read at the weekend are not returned as REALTIME", async () => {
  const r = await candlesAt(SAT_NOON, "M15", { TWELVEDATA_API_KEY: "offline-fixture" }, () => ({ status: "ok", values: tdValues(FRI_2145, 900_000) }));
  assert.ok(r.candles.length > 0);
  assert.notEqual(r.freshness, "REALTIME");
  assert.equal(r.freshness, "STALE");
});

test("yesterday's Polygon daily bar is not returned as REALTIME", async () => {
  const dayMs = 24 * H;
  const now = WED_1400;
  const yesterdayOpen = Math.floor(now / dayMs) * dayMs - dayMs;
  const r = await candlesAt(now, "D1", { POLYGON_API_KEY: "offline-fixture" }, () => ({
    status: "OK", results: Array.from({ length: 12 }, (_, i) => ({ t: yesterdayOpen - i * dayMs, o: 1.08, h: 1.09, l: 1.07, c: 1.085 })),
  }));
  assert.ok(r.candles.length > 0);
  assert.notEqual(r.freshness, "REALTIME");
});

test("a clean Twelve Data series not stamped within the real-time window is UNCONFIRMED, not REALTIME or DELAYED", async () => {
  const r = await candlesAt(WED_1400 + 7 * 60_000, "M15", { TWELVEDATA_API_KEY: "offline-fixture" }, () => ({ status: "ok", values: tdValues(WED_1400, 900_000) }));
  assert.equal(r.freshness, "UNCONFIRMED");
});

test("a Twelve Data series whose newest bar is stamped seconds ago stays REALTIME", async () => {
  const r = await candlesAt(WED_1400 + 2_000, "M1", { TWELVEDATA_API_KEY: "offline-fixture" }, () => ({ status: "ok", values: tdValues(WED_1400, 60_000) }));
  assert.equal(r.freshness, "REALTIME");
});

test("a cached REALTIME candle result is re-checked when served again later", async () => {
  mock.timers.enable({ apis: ["Date"], now: WED_1400 + 2_000 });
  let calls = 0;
  const restore = withOnlyKeys({ TWELVEDATA_API_KEY: "offline-fixture" }, () => { calls++; return { status: "ok", values: tdValues(WED_1400, 60_000) }; });
  try {
    const p = getMarketProvider();
    assert.equal((await p.getCandles("EURUSD", "M1", 12)).freshness, "REALTIME");
    mock.timers.setTime(WED_1400 + 40_000);
    const again = await p.getCandles("EURUSD", "M1", 12);
    assert.equal(calls, 1, "served from the candle cache");
    assert.equal(again.freshness, "UNCONFIRMED");
  } finally { restore(); mock.timers.reset(); }
});
