// Truth: getMarketStatus().freshnessState is FRESH after ANY successful
// provider call (news, calendar, overview included), and dataFreshness keeps
// the quality of the last quote payload with no time attached. A consumer
// therefore could not tell "a real-time quote just arrived" from "a news fetch
// just succeeded; the last quote, hours ago, was real-time". dataFreshnessAt
// stamps when that quote quality was observed, so the page can require a recent
// real-time quote before it says FRESH.
import { test, afterEach } from "node:test";
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
