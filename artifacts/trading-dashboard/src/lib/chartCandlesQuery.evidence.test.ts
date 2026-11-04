import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChartCandles, fetchChartHistory } from "./chartCandlesQuery";

afterEach(() => vi.unstubAllGlobals());

describe("chart history identity transport", () => {
  const evidence = { symbol: "V75", timeframe: "M15", source: "mt5_broker", sourceIdentity: "opaque-account-one", lastClosedCandleAt: "2026-10-26T18:00:00Z" };
  function reply(marketEvidence: unknown) {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ candles: [], feedStatus: { source: "mt5_broker" }, marketEvidence }) })));
  }
  it("preserves matching opaque evidence without deriving an account ID", async () => {
    reply(evidence);
    expect((await fetchChartCandles("V75", "M15", 200)).marketEvidence).toEqual(evidence);
  });
  it.each([
    null, { ...evidence, symbol: "V25" }, { ...evidence, timeframe: "M5" },
    { ...evidence, source: "deriv_public" }, { ...evidence, sourceIdentity: "" },
    { ...evidence, sourceIdentity: 123 },
  ])("does not invent usable evidence from absent or mismatched metadata: %s", async value => {
    reply(value);
    expect((await fetchChartCandles("V75", "M15", 200)).marketEvidence).toBeUndefined();
  });
});

describe("strict history continuation transport", () => {
  const args = { symbol: "V75", apiTf: "M1", source: "deriv_public", sourceIdentity: "a".repeat(64), before: "2026-01-01T00:00:00Z" };
  const evidence = { symbol: "V75", timeframe: "M1", source: "deriv_public", sourceIdentity: args.sourceIdentity,
    lastClosedCandleAt: "2025-12-31T23:59:00Z", scope: "public_provider" };
  function reply(historyEvidence: unknown, source = "deriv_public") {
    const fetch = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ ok: true, source, candles: [], historyEvidence }) }));
    vi.stubGlobal("fetch", fetch); return fetch;
  }
  it("sends the opaque expectation and preserves only actual matching producer evidence", async () => {
    const transport = reply(evidence);
    expect((await fetchChartHistory(args)).historyEvidence).toEqual(evidence);
    expect(String(transport.mock.calls[0]?.[0])).toContain(`sourceIdentity=${args.sourceIdentity}`);
  });
  it.each([null, { ...evidence, sourceIdentity: "b".repeat(64) }, { ...evidence, source: "mt5_broker" },
    { ...evidence, symbol: "V25" }, { ...evidence, timeframe: "M5" },
    { ...evidence, scope: "current_account" }, { ...evidence, lastClosedCandleAt: "invalid" },
    { ...evidence, lastClosedCandleAt: "2099-01-01T00:00:00Z" },
    { ...evidence, lastClosedCandleAt: "2026-01-01T00:01:00Z" },
  ])("does not turn absent/mismatched historical metadata into evidence: %s", async value => {
    reply(value); expect((await fetchChartHistory(args)).historyEvidence).toBeNull();
  });
});

describe("original candle evidence retention", () => {
  function reply(data: unknown) {
    const transport = vi.fn(async () => ({ok:true,json:async () => data}));
    vi.stubGlobal("fetch",transport);
    return transport;
  }
  it("retains the complete original normalized response alongside legacy display bars", async () => {
    const bar = {symbol:"V75",timeframe:"H12",source:"mt5_broker",
      openTime:"2026-10-27T00:00:00Z",closeTime:"2026-10-27T12:00:00Z",
      open:100,high:110,low:90,close:105,volume:42,tickVolume:82,
      isComplete:true,isFinal:true,isForming:false,qualityFlags:["SOURCE_OBSERVATION"],
      sourceMode:"demo",priceBasis:"BID",brokerSymbol:"Volatility75",receivedAt:"2026-10-27T12:01:00Z"};
    const original = {symbol:"V75",timeframe:"H12",source:"mt5_broker",candles:[bar],feedStatus:{source:"mt5_broker"},
      marketEvidence:{symbol:"V75",timeframe:"H12",source:"mt5_broker",sourceIdentity:"a".repeat(64),
        lastClosedCandleAt:bar.closeTime,userId:7},additionalProviderEvidence:{clock:"observed"}};
    reply(original);
    const result = await fetchChartCandles("V75","H12",200);
    expect(result.originalResponse).toBe(original);
    expect((result.originalResponse as typeof original).candles[0]).toEqual(bar);
    expect(result.candles).toEqual([{time:Date.parse(bar.openTime),open:100,high:110,low:90,close:105}]);
    result.candles[0]!.close=999;
    expect(bar.close).toBe(105);
    expect((result.originalResponse as typeof original).marketEvidence.userId).toBe(7);
  });
  it("does not add close, source or finality metadata to legacy OHLC", async () => {
    const original = [{time:1700000000000,open:100,high:110,low:90,close:105}];
    reply(original);
    const result = await fetchChartCandles("V75","M15",200);
    expect(result.originalResponse).toBe(original);
    expect(result.marketEvidence).toBeUndefined();
    expect(Object.keys(original[0]!)).toEqual(["time","open","high","low","close"]);
  });
  it("retains contradictory untrusted evidence without promoting or repairing it", async () => {
    const original = {candles:[{openTime:"2026-10-27T00:00:00Z",open:100,high:110,low:90,close:105,
      isComplete:true,isFinal:false,isForming:true}],feedStatus:{source:"mt5_broker"},
      marketEvidence:{symbol:"V25",timeframe:"M5",source:"deriv_public",sourceIdentity:"other-source"}};
    reply(original);
    const result = await fetchChartCandles("V75","M15",200);
    expect(result.originalResponse).toBe(original);
    expect(result.marketEvidence).toBeUndefined();
    expect((result.originalResponse as typeof original).candles[0]).toMatchObject({isComplete:true,isFinal:false,isForming:true});
    expect((result.originalResponse as typeof original).candles[0]).not.toHaveProperty("closeTime");
  });
});
