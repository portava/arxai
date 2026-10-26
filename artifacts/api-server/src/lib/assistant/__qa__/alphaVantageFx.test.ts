import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getMarketProvider, _resetMarketProviderForTests, getMarketStatus } from "../marketProvider.js";
import { alphaUtcTimestamp, parseAlphaFxCandles } from "../alphaVantageFx.js";
import { getMarketHttpObservations, marketHttpJson } from "../marketHttp.js";
import { inspectMarketData } from "../marketDataReadiness.js";

const keys = ["TWELVEDATA_API_KEY", "POLYGON_API_KEY", "FINNHUB_API_KEY", "ALPHA_VANTAGE_API_KEY", "NEWSAPI_API_KEY"];
const originalFetch = globalThis.fetch, originalNow = Date.now;
let saved: Array<string | undefined>;
const NOW = Date.parse("2026-10-26T10:33:05Z");
const rate = (over: Record<string, unknown> = {}) => ({ "Realtime Currency Exchange Rate": {
  "1. From_Currency Code": "EUR", "3. To_Currency Code": "USD", "5. Exchange Rate": "1.12",
  "6. Last Refreshed": "2026-10-26 10:33:00", "7. Time Zone": "UTC",
  "8. Bid Price": "1.1199", "9. Ask Price": "1.1201", ...over,
} });
function candles() {
  const rows = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [new Date(NOW - 5_000 - i * 60_000).toISOString().replace("T", " ").slice(0,19),
    { "1. open": "1.12", "2. high": "1.13", "3. low": "1.11", "4. close": "1.12" }]));
  return { "Meta Data": { "2. From Symbol": "EUR", "3. To Symbol": "USD", "5. Interval": "1min", "7. Time Zone": "UTC" }, "Time Series FX (1min)": rows };
}
beforeEach(() => {
  saved = keys.map(k => process.env[k]); keys.forEach(k => { delete process.env[k]; });
  process.env.ALPHA_VANTAGE_API_KEY = "test-key-private"; Date.now = () => NOW;
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
  _resetMarketProviderForTests();
});
afterEach(() => { keys.forEach((k,i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  globalThis.fetch = originalFetch; Date.now = originalNow; _resetMarketProviderForTests(); });

test("FX quote uses the currency endpoint and preserves real bid, ask and UTC observation time", async () => {
  let calls = 0;
  globalThis.fetch = async input => { calls++; const u = new URL(String(input));
    assert.equal(u.searchParams.get("function"), "CURRENCY_EXCHANGE_RATE");
    assert.equal(u.searchParams.get("from_currency"), "EUR"); assert.equal(u.searchParams.get("to_currency"), "USD");
    return Response.json(rate()); };
  const p = getMarketProvider(), q = await p.getLiveQuote("EURUSD");
  assert.equal(q.freshness,"REALTIME"); assert.equal(q.bid,1.1199); assert.equal(q.ask,1.1201);
  assert.equal(q.asOf,"2026-10-26T10:33:00.000Z"); await p.getLiveQuote("EURUSD"); assert.equal(calls,1);
});
test("stock symbols retain the stock endpoint and delayed classification", async () => {
  globalThis.fetch = async input => { assert.equal(new URL(String(input)).searchParams.get("function"),"GLOBAL_QUOTE");
    return Response.json({ "Global Quote": { "05. price":"123", "07. latest trading day":"2026-10-23" } }); };
  const q = await getMarketProvider().getLiveQuote("AAPL"); assert.equal(q.price,123); assert.equal(q.freshness,"STALE");
});
test("FX identity mismatch, invalid price, and crossed spread are unavailable", async () => {
  for (const over of [{ "1. From_Currency Code":"GBP" }, { "5. Exchange Rate":"1.2oops" }, { "5. Exchange Rate":"0" }, { "8. Bid Price":"2" }]) {
    _resetMarketProviderForTests(); globalThis.fetch = async () => Response.json(rate(over));
    const q = await getMarketProvider().getLiveQuote("EURUSD"); assert.equal(q.freshness,"UNAVAILABLE"); assert.equal(q.price,null);
  }
});
test("missing, unknown-zone, impossible and future source time never becomes a current quote", async () => {
  for (const over of [{ "6. Last Refreshed":null }, { "7. Time Zone":"EST" }, { "6. Last Refreshed":"2026-02-30 10:00:00" }, { "6. Last Refreshed":"2026-10-27 10:33:00" }]) {
    _resetMarketProviderForTests(); globalThis.fetch = async () => Response.json(rate(over));
    const q = await getMarketProvider().getLiveQuote("EURUSD"); assert.equal(q.freshness,"STALE"); assert.equal(q.stale,true);
  }
  assert.equal(alphaUtcTimestamp("2026-10-26 10:33:00","UTC"),"2026-10-26T10:33:00.000Z");
});
test("FX intraday request uses supported interval, validates metadata and sorts actual bars", async () => {
  globalThis.fetch = async input => { const u = new URL(String(input)); assert.equal(u.searchParams.get("function"),"FX_INTRADAY");
    assert.equal(u.searchParams.get("interval"),"1min"); return Response.json(candles()); };
  const c = await getMarketProvider().getCandles("EURUSD","M1",5);
  assert.equal(c.candles.length,5); assert.equal(c.asOf,"2026-10-26T10:33:00.000Z"); assert.equal(c.freshness,"REALTIME");
  assert.ok(c.candles.every((b,i,all) => i===0 || b.t > all[i-1]!.t));
});
test("unsupported FX candle symbols and timeframes make no upstream request", async () => {
  for (const [symbol,tf] of [["AAPL","M1"],["EURUSD","H4"],["EURUSD","D1"],["XAUUSD","M1"]]) {
    assert.equal((await getMarketProvider().getCandles(symbol!,tf!)).freshness,"UNAVAILABLE");
  }
  assert.equal(getMarketHttpObservations().length,0);
});
test("invalid OHLC, future bars and mismatched FX metadata are never accepted", () => {
  const data = candles(); const keys = Object.keys(data["Time Series FX (1min)"]);
  data["Time Series FX (1min)"][keys[0]!]!["2. high"] = "1.0";
  assert.equal(parseAlphaFxCandles("EURUSD","M1",10,data,NOW).candles.length,9);
  data["Meta Data"]["2. From Symbol"]="GBP";
  assert.equal(parseAlphaFxCandles("EURUSD","M1",10,data,NOW).candles.length,0);
  assert.equal(parseAlphaFxCandles("EURUSD","M1",10,candles(),NOW-3_600_000).candles.length,0);
  assert.equal(parseAlphaFxCandles("EURUSD","M1",10,candles(),NOW+3_600_000).freshness,"DELAYED");
});
test("premium and quota responses stay unavailable with only safe diagnostic codes", async () => {
  for (const [payload,expected] of [[{ Information:"Premium endpoint; private-account test-key-private" },"ACCESS_RESTRICTED"],
    [{ Note:"API call frequency limit test-key-private" },"RATE_LIMITED"]] as const) {
    _resetMarketProviderForTests(); globalThis.fetch = async () => Response.json(payload);
    const c=await getMarketProvider().getCandles("EURUSD","M1"); assert.equal(c.candles.length,0);
    assert.equal(getMarketHttpObservations()[0]?.reason,expected);
    assert.doesNotMatch(JSON.stringify([c,getMarketStatus(),getMarketHttpObservations()]),/test-key-private|private-account/);
  }
});
test("transport errors and non-2xx responses cannot expose request URLs or keys", async () => {
  for (const status of [401,403,429,500]) {
    globalThis.fetch = async () => new Response("secret",{status});
    assert.equal(await marketHttpJson("https://www.alphavantage.co/query?apikey=test-key-private"),null);
  }
  globalThis.fetch = async () => { throw new Error("test-key-private at https://private.example"); };
  await marketHttpJson("https://www.alphavantage.co/query?apikey=test-key-private");
  assert.equal(getMarketHttpObservations().at(-1)?.reason,"TRANSPORT_ERROR");
  assert.doesNotMatch(JSON.stringify(getMarketHttpObservations()),/test-key-private|private.example|apikey/);
});
test("HTTP diagnostics are bounded, report malformed JSON and timeouts without raw payloads", async () => {
  globalThis.fetch = async () => new Response("not-json-private");
  for (let i=0;i<40;i++) await marketHttpJson("https://www.alphavantage.co/query");
  assert.equal(getMarketHttpObservations().length,32); assert.equal(getMarketHttpObservations()[0]?.reason,"INVALID_JSON");
  globalThis.fetch = async (_input,init) => new Promise((_resolve,reject) => init!.signal!.addEventListener("abort",() => reject(new Error("private"))));
  assert.equal(await marketHttpJson("https://www.alphavantage.co/query",undefined,5),null);
  assert.equal(getMarketHttpObservations().at(-1)?.reason,"TIMEOUT");
});
test("readiness requires current bid/ask and ten contiguous, valid recent minute bars", async () => {
  globalThis.fetch = async input => Response.json(new URL(String(input)).searchParams.get("function")==="FX_INTRADAY" ? candles() : rate());
  const provider=getMarketProvider(); const good=await inspectMarketData(provider,"EURUSD",() => NOW); assert.equal(good.ready,true);
  const q=await provider.getLiveQuote("EURUSD"), c=await provider.getCandles("EURUSD","M1",10);
  for (const quote of [{...q,bid:null},{...q,asOf:null},{...q,freshness:"DELAYED" as const}]) {
    assert.equal((await inspectMarketData({...provider,getLiveQuote:async()=>quote},"EURUSD",() => NOW)).ready,false);
  }
  for (const candle of [{...c,candles:c.candles.slice(1)},{...c,candles:[...c.candles.slice(0,9),c.candles[0]!]},{...c,candles:c.candles.map(b=>({...b,h:0}))}]) {
    assert.equal((await inspectMarketData({...provider,getCandles:async()=>candle},"EURUSD",() => NOW)).ready,false);
  }
});
