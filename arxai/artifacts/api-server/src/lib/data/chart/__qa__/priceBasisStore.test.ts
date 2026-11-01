import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __resetMt5ProviderStore,
  mergeCandleFromMT5,
  readMt5Candles,
} from "../../providers/mt5Provider.js";
import { mt5PriceBasisEvidence } from "../../candlePriceBasisEvidence.js";
import { runCandleTruth } from "../candleTruthEngine.js";

test("actual in-memory store replacement withdraws an old declaration without inferring from same OHLC", () => {
  __resetMt5ProviderStore();
  try {
    const now = Date.now(),
      time = new Date(now - 120000).toISOString();
    const bar = { time, open: 1.1, high: 1.102, low: 1.099, close: 1.101 };
    const bridge = { bridgeConnectionId: 987654321, userId: 987654321 };
    const opts = {
      symbol: "EURUSD",
      displaySymbol: "EUR/USD",
      timeframe: "M1" as const,
      source: "mt5_broker",
      assetClass: "forex" as const,
      limit: 1,
      now,
    };
    mergeCandleFromMT5(
      "EURUSD",
      { ...bar, priceBasisEvidence: mt5PriceBasisEvidence("bid") },
      "M1",
      bridge,
    );
    const before = readMt5Candles("EURUSD", "M1", 1, {
      bridgeConnectionId: bridge.bridgeConnectionId,
    });
    assert.equal(
      runCandleTruth(before.candles, opts).verifiedCandles[0]!.priceBasis,
      "BID",
    );
    mergeCandleFromMT5("EURUSD", bar, "M1", bridge);
    const after = readMt5Candles("EURUSD", "M1", 1, {
      bridgeConnectionId: bridge.bridgeConnectionId,
    });
    assert.equal(after.candles[0]!.priceBasisEvidence, undefined);
    const truth = runCandleTruth(after.candles, opts);
    assert.equal(truth.verifiedCandles[0]!.priceBasis, "UNKNOWN");
    assert.equal(
      truth.verifiedCandles[0]!.priceBasisEvidence?.kind,
      "unavailable",
    );
  } finally {
    __resetMt5ProviderStore();
  }
});
