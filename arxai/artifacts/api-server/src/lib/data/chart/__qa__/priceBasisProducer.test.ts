import "./candleTimeBasis.test.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../../types.js";
import {
  normalizeCandles,
  priceBasisFromProvider,
} from "../candleNormalization.js";
import {
  mt5PriceBasisEvidence,
  resolveCandlePriceBasisEvidence,
} from "../../candlePriceBasisEvidence.js";
import { runCandleTruth } from "../candleTruthEngine.js";

const mirrored: Candle[] = [];
mock.module("../../candleCache.js", {
  namedExports: {
    isValidCacheOhlc: () => true,
    upsertCandles: async (
      _s: string,
      _tf: string,
      _src: string,
      rows: Candle[],
    ) => ({ written: rows.length }),
  },
});
mock.module("../../providers/mt5Provider.js", {
  namedExports: {
    mergeCandleFromMT5: (_s: string, candle: Candle) => {
      mirrored.push(candle);
    },
  },
});
const { ingestMt5CandleHistory } = await import("../../mt5History.js");
const now = Date.parse("2026-11-01T00:00:00Z");
const rows = Array.from({ length: 3 }, (_, i) => ({
  time: new Date(now - (3 - i) * 60_000).toISOString(),
  open: 1.1,
  high: 1.102,
  low: 1.099,
  close: 1.101,
  tickVolume: 10,
}));
const opts = {
  symbol: "EURUSD",
  displaySymbol: "EUR/USD",
  timeframe: "M1" as const,
  source: "mt5_broker",
  assetClass: "forex" as const,
  limit: 3,
  now,
};

test("MT5 provider name does not establish BID or LAST chart mode", () => {
  assert.equal(priceBasisFromProvider("mt5_broker"), "UNKNOWN");
});
test("actual legacy MT5 history producer -> Truth leaves undeclared basis UNKNOWN", async () => {
  mirrored.length = 0;
  const received = await ingestMt5CandleHistory(
    {
      symbol: "EURUSD",
      timeframe: "M1",
      bars: rows,
      sentAt: new Date(now).toISOString(),
    },
    { now },
  );
  assert.equal(received.accepted, 3);
  assert.equal(mirrored.length, 3);
  const normalized = normalizeCandles(mirrored, opts);
  const truth = runCandleTruth(mirrored, opts);
  assert.ok(normalized.candles.every((c) => c.priceBasis === "UNKNOWN"));
  assert.ok(truth.verifiedCandles.every((c) => c.priceBasis === "UNKNOWN"));
  assert.equal(truth.truthResult.priceBasis, "UNKNOWN");
  assert.match(truth.truthResult.sourceDocumentation.priceBasisNote, /UNKNOWN/);
});
test("synthetic classification cannot acquire MID or BID historical semantics", () => {
  const truth = runCandleTruth(rows, {
    ...opts,
    symbol: "R_75",
    displaySymbol: "V75",
    source: "deriv_public",
    assetClass: "synthetic",
  });
  assert.equal(truth.truthResult.priceBasis, "SYNTHETIC");
  assert.ok(truth.verifiedCandles.every((c) => c.priceBasis === "SYNTHETIC"));
});

for (const [declaration, basis] of [
  ["bid", "BID"],
  ["mid", "MID"],
  ["last", "LAST"],
  ["ask", "UNKNOWN"],
] as const) {
  test(`actual MT5 producer declaration ${declaration} survives normalization and Truth`, async () => {
    mirrored.length = 0;
    await ingestMt5CandleHistory(
      {
        symbol: "EURUSD",
        timeframe: "M1",
        bars: rows,
        priceBasis: declaration,
        sentAt: new Date(now).toISOString(),
      },
      { now },
    );
    const truth = runCandleTruth(mirrored, opts);
    assert.equal(truth.truthResult.priceBasis, basis);
    for (const candle of truth.verifiedCandles) {
      assert.equal(candle.priceBasis, basis);
      assert.deepEqual(
        candle.priceBasisEvidence,
        basis === "UNKNOWN"
          ? resolveCandlePriceBasisEvidence(
              mirrored[0]!.priceBasisEvidence,
              "mt5_broker",
            )
          : { kind: "producer_declared", basis, reason: null },
      );
    }
    assert.ok(
      truth.truthResult.sourceDocumentation.priceBasisNote.startsWith(basis),
    );
  });
}
for (const [symbol, assetClass] of [
  ["R_75", "synthetic"],
  ["BTCUSD", "crypto"],
  ["XAUUSD", "metals"],
  ["AAPL", "stocks"],
] as const)
  test(`MT5 original BID declaration wins over ${assetClass} profile`, () => {
    const raw = rows.map((c) => ({
      ...c,
      priceBasisEvidence: mt5PriceBasisEvidence("bid"),
    }));
    const truth = runCandleTruth(raw, { ...opts, symbol, assetClass });
    assert.equal(truth.truthResult.priceBasis, "BID");
    assert.ok(
      truth.verifiedCandles.every(
        (c) =>
          c.priceBasis === "BID" &&
          c.priceBasisEvidence?.kind === "producer_declared",
      ),
    );
  });
test("mixed declarations remain per-bar and aggregate UNKNOWN, never flattened to MID", () => {
  const raw = rows.map((c, i) => ({
    ...c,
    priceBasisEvidence: mt5PriceBasisEvidence(i === 0 ? "bid" : "last"),
  }));
  const truth = runCandleTruth(raw, opts);
  assert.equal(truth.truthResult.priceBasis, "UNKNOWN");
  assert.deepEqual(
    truth.verifiedCandles.map((c) => c.priceBasis),
    ["BID", "LAST", "LAST"],
  );
});
test("numeric-only cache history cannot inherit a current declaration", () => {
  const raw = rows.map((c, i) => ({
    ...c,
    ...(i === 0 ? { priceBasisEvidence: mt5PriceBasisEvidence("bid") } : {}),
  }));
  const truth = runCandleTruth(raw, opts);
  assert.deepEqual(
    truth.verifiedCandles.map((c) => c.priceBasis),
    ["BID", "UNKNOWN", "UNKNOWN"],
  );
  assert.equal(truth.truthResult.priceBasis, "UNKNOWN");
});
for (const evidence of [
  null,
  {},
  { kind: "producer_declared", basis: "BID", reason: "contradiction" },
  { kind: "producer_declared", basis: "ASK", reason: null },
  { kind: "unavailable", basis: "BID", reason: null },
])
  test(`inconsistent or absent declaration is withheld: ${JSON.stringify(evidence)}`, () => {
    const raw = rows.map((c) => ({
      ...c,
      priceBasisEvidence: evidence as never,
    }));
    assert.ok(
      runCandleTruth(raw, opts).verifiedCandles.every(
        (c) =>
          c.priceBasis === "UNKNOWN" &&
          c.priceBasisEvidence?.kind === "unavailable",
      ),
    );
  });
for (const source of [
  "assistant_real:twelve_data",
  "assistant_real:finnhub",
  "deriv_public",
  "mock",
])
  test(`${source} cannot borrow an MT5 declaration`, () => {
    const raw = rows.map((c) => ({
      ...c,
      priceBasisEvidence: mt5PriceBasisEvidence("bid"),
    }));
    const truth = runCandleTruth(raw, { ...opts, source });
    assert.ok(
      truth.verifiedCandles.every(
        (c) => c.priceBasisEvidence?.kind === "unavailable",
      ),
    );
    if (source === "deriv_public")
      assert.equal(truth.truthResult.priceBasis, "SYNTHETIC");
  });
test("metadata correction does not change OHLC or existing assessment", () => {
  const undeclared = runCandleTruth(rows, opts),
    declared = runCandleTruth(
      rows.map((c) => ({
        ...c,
        priceBasisEvidence: mt5PriceBasisEvidence("bid"),
      })),
      opts,
    );
  const values = (r: typeof declared) =>
    r.verifiedCandles.map((c) => [
      c.openTime,
      c.open,
      c.high,
      c.low,
      c.close,
      c.isFinal,
      c.qualityFlags,
    ]);
  assert.deepEqual(values(undeclared), values(declared));
  assert.equal(
    undeclared.truthResult.assessment,
    declared.truthResult.assessment,
  );
  assert.deepEqual(
    undeclared.truthResult.assessmentReasons,
    declared.truthResult.assessmentReasons,
  );
});
