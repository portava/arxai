import test from "node:test";
import assert from "node:assert/strict";
import { prepareScannerCandles, scannerQuoteFor, scannerSourceIdentity, bindScannerSource, scannerRowSourceIdentity } from "../scannerInputIntegrity.js";
import type { MarketCandlesResult, MarketQuoteResult } from "../data/marketDataRouter.js";

const now = Date.parse("2026-10-26T12:02:00Z"), interval = 300_000;
const closedOpen = Date.parse("2026-10-26T11:55:00Z");
function bars(provider = "mt5_broker", count = 60): MarketCandlesResult {
  return { ok: true, symbol: "EURUSD", assetClass: "forex", primaryProvider: provider,
    attempts: [], userMessage: "", adminDetail: "", candles: Array.from({ length: count }, (_, i) => ({
      time: new Date(closedOpen - (count - 1 - i) * interval + (provider.startsWith("assistant_real") ? interval : 0)).toISOString(),
      open: 1.1, high: 1.12, low: 1.09, close: 1.11, volume: 100,
    })) };
}
function quote(): MarketQuoteResult { return { ok: true, symbol: "EURUSD", assetClass: "forex", primaryProvider: "mt5_broker", attempts: [], userMessage: "", adminDetail: "", quote: { symbol: "EURUSD", timestamp: new Date(now).toISOString(), bid: 1.11, ask: 1.1102, spread: 0.0002 } }; }

test("excludes forming and future bars; closed timestamps follow the actual provider convention", () => {
  for (const provider of ["mt5_broker", "deriv", "assistant_real:twelve_data"]) {
    const result = bars(provider);
    const original = structuredClone(result);
    result.candles.push({ ...result.candles[59]!, time: new Date(closedOpen + interval + (provider.startsWith("assistant_real") ? interval : 0)).toISOString(), close: 1.119 });
    result.candles.push({ ...result.candles[59]!, time: new Date(now + 86400_000).toISOString() });
    const prepared = prepareScannerCandles(result, "EURUSD", "M5", now)!;
    assert.equal(prepared.rawClosed.length, 60);
    assert.deepEqual(prepared.rawClosed, original.candles);
    assert.equal(prepared.openClosed.at(-1)?.time, new Date(closedOpen).toISOString());
    assert.deepEqual(prepareScannerCandles(original, "EURUSD", "M5", now)?.openClosed, prepared.openClosed);
  }
});

test("a forming bar becomes eligible only at its close, including a non-UTC-aligned session open", () => {
  const result = bars();
  result.candles = [{ ...result.candles[0]!, time: "2026-10-26T09:30:00Z" }];
  assert.equal(prepareScannerCandles(result, "EURUSD", "H1", Date.parse("2026-10-26T10:29:59.999Z"))?.rawClosed.length, 0);
  assert.equal(prepareScannerCandles(result, "EURUSD", "H1", Date.parse("2026-10-26T10:30:00Z"))?.rawClosed.length, 1);
});

test("accepts out-of-order and identical duplicate bars without mutating or inflating the count", () => {
  const result = bars(); result.candles.reverse(); result.candles.push({ ...result.candles[0]! });
  const before = structuredClone(result);
  const prepared = prepareScannerCandles(result, "EURUSD", "M5", now)!;
  assert.equal(prepared.rawClosed.length, 60);
  assert.equal(prepared.rawClosed.at(-1)?.time, new Date(closedOpen).toISOString());
  assert.deepEqual(result, before);
});

test("rejects invalid OHLC, conflicting duplicates, invalid timestamps and non-finite clocks", () => {
  for (const invalid of [ { close: NaN }, { high: 1.05 }, { low: 0 }, { time: "invalid" } ]) {
    const result = bars(); result.candles[20] = { ...result.candles[20]!, ...invalid };
    assert.equal(prepareScannerCandles(result, "EURUSD", "M5", now), null);
  }
  const conflict = bars(); conflict.candles.push({ ...conflict.candles[0]!, close: 1.115 });
  assert.equal(prepareScannerCandles(conflict, "EURUSD", "M5", now), null);
  assert.equal(prepareScannerCandles(bars(), "EURUSD", "M5", NaN), null);
});

test("rejects mismatched symbol, unrecognized source and a denser wrong-timeframe series", () => {
  assert.equal(prepareScannerCandles(bars(), "GBPUSD", "M5", now), null);
  assert.equal(prepareScannerCandles(bars("mock"), "EURUSD", "M5", now), null);
  assert.equal(prepareScannerCandles(bars("unknown"), "EURUSD", "M5", now), null);
  assert.equal(prepareScannerCandles(bars(), "EURUSD", "H1", now), null);
  assert.equal(prepareScannerCandles(bars(), "EURUSD", "not-a-timeframe", now), null);
});

test("continuous markets use only the latest contiguous tail; session gaps are not filled", () => {
  const result = bars(); result.candles.splice(40, 1); result.assetClass = "crypto";
  assert.equal(prepareScannerCandles(result, "EURUSD", "M5", now)?.rawClosed.length, 19);
  result.assetClass = "forex";
  const prepared = prepareScannerCandles(result, "EURUSD", "M5", now)!;
  assert.equal(prepared.rawClosed.length, 59);
  assert.deepEqual(prepared.rawClosed, result.candles);
});

test("requires current matching quote identity and source, refuses stale/future/crossed/non-finite prices", () => {
    const valid = scannerQuoteFor(bars(), quote(), "EURUSD", now)!;
  assert.equal(valid.mid, 1.1101); assert.ok(Math.abs(valid.spread! - 0.0002) < 1e-12);
  const invalids = [
    { symbol: "GBPUSD" }, { primaryProvider: "assistant_real:twelve_data" },
    { quote: { ...quote().quote!, symbol: "GBPUSD" } },
    { quote: { ...quote().quote!, timestamp: new Date(now - 16_000).toISOString() } },
    { quote: { ...quote().quote!, timestamp: new Date(now + 60_000).toISOString() } },
    { quote: { ...quote().quote!, bid: 1.12, ask: 1.11 } },
    { quote: { symbol: "EURUSD", timestamp: new Date(now).toISOString(), last: NaN } },
    { quote: { symbol: "EURUSD", timestamp: new Date(now).toISOString(), last: 1.11 } },
  ];
  for (const invalid of invalids) assert.equal(scannerQuoteFor(bars(), { ...quote(), ...invalid }, "EURUSD", now), null);
});


test("provenance must bind the requested timeframe and the quote's bridge", () => {
  const result = bars();
  result.provenance = { providerId: "mt5_broker", subProviderId: null, brokerCode: "mt5", bridgeConnectionId: 1, userId: 8, brokerSymbol: "EURUSD", environment: "demo", receivedAt: new Date(now).toISOString(), delayed: false, source: "DERIVED", sourceId: "mt5_broker:EURUSD:M5" };
  assert.ok(prepareScannerCandles(result, "EURUSD", "M5", now));
  result.provenance.sourceId = "mt5_broker:EURUSD:H1";
  assert.equal(prepareScannerCandles(result, "EURUSD", "M5", now), null);
  result.provenance.sourceId = "mt5_broker:EURUSD:M5";
  const q = quote(); q.provenance = { ...result.provenance, source: "LIVE_TICK", sourceId: "mt5_broker:EURUSD", bridgeConnectionId: 2 };
  assert.equal(scannerQuoteFor(result, q, "EURUSD", now), null);
  q.provenance.bridgeConnectionId = 1;
  assert.ok(scannerQuoteFor(result, q, "EURUSD", now));
  q.provenance.delayed = true;
  assert.equal(scannerQuoteFor(result, q, "EURUSD", now), null);
});


test("private source binding survives spread decorators but cannot disclose identity in JSON", () => {
  const identity = scannerSourceIdentity(bars());
  const row = bindScannerSource({ symbol: "EURUSD", score: 70 }, identity);
  const decorated = { ...{ ...row, news: "fixture" }, score: 60 };
  assert.equal(scannerRowSourceIdentity(decorated), identity);
  assert.equal(JSON.stringify(decorated), '{"symbol":"EURUSD","score":60,"news":"fixture"}');
  assert.equal(JSON.stringify(decorated).includes(identity), false);
  assert.equal(scannerRowSourceIdentity(JSON.parse(JSON.stringify(decorated))), null);
});
