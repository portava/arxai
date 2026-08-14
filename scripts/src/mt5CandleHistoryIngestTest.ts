// ── MT5 candle-history ingest test (Task #432) ──────────────────────────────
//
// The EA producer side is UNTESTABLE in this environment, so the
// `/api/mt5/sync-candle-history` contract (`ingestMt5CandleHistory`) is locked
// here via crafted, real-shaped payloads against the REAL cache table.
//
// Asserted honesty rules:
//   - A valid backfill is accepted, stored under source `mt5_broker`, and
//     readable back from the deep cache (provenance-coherent with the live feed).
//   - Garbage OHLC / bad timestamps are dropped, never stored.
//   - A STALE/replayed transport (`sentAt` too far in the past) is refused and
//     stores NOTHING (an old/replayed bar must never masquerade as live).
//   - An unparsable `sentAt` is refused (fail-closed).
//   - An all-invalid / empty payload returns no_valid_bars and NEVER clears an
//     existing good series.
//   - Duplicate bar times within one batch collapse (last write wins).
//
// MARKET-DATA / TELEMETRY ONLY — no execution, no 16-gate, no arx_live_*. Uses a
// run-unique synthetic symbol; cleans up fail-closed.

import {
  ingestMt5CandleHistory,
  MT5_HISTORY_SOURCE,
  type Mt5CandleHistoryIngest,
} from "../../artifacts/api-server/src/lib/data/mt5History.js";
import {
  __deleteCachedSymbol,
  getCacheCoverage,
  readCachedCandles,
} from "../../artifacts/api-server/src/lib/data/candleCache.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push(label);
  }
}
function eq<T>(actual: T, expected: T, label: string): void {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const SYMBOL = `__TEST_MT5HIST_${RUN}`.toUpperCase();
const TF = "M15";
const BAR_MS = 15 * 60_000;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const NOW = BASE + 40 * BAR_MS; // injected "now" anchored near the bars

function mkBar(i: number, over: Partial<Record<string, number | string>> = {}) {
  const close = 1.2 + i * 0.001;
  const open = close - 0.0006;
  return {
    time: new Date(BASE + i * BAR_MS).toISOString(),
    open, high: close + 0.0006, low: open - 0.0006, close, tickVolume: 50 + i,
    ...over,
  };
}

function payload(bars: unknown[], over: Partial<Mt5CandleHistoryIngest> = {}): Mt5CandleHistoryIngest {
  return {
    symbol: SYMBOL,
    timeframe: TF,
    isHistoryBackfill: true,
    bars: bars as Mt5CandleHistoryIngest["bars"],
    sentAt: new Date(NOW).toISOString(),
    eaVersion: "1.50",
    ...over,
  };
}

async function main(): Promise<void> {
  await __deleteCachedSymbol(SYMBOL);

  // ── 1. Valid backfill accepted, stored under mt5_broker, readable back ──────
  const valid = payload([mkBar(0), mkBar(1), mkBar(2), mkBar(3), mkBar(4)]);
  const r1 = await ingestMt5CandleHistory(valid, { now: NOW });
  eq(r1.accepted, 5, "valid backfill accepted 5 bars");
  eq(r1.rejected, 0, "valid backfill rejected 0 bars");
  eq(r1.stored, 5, "valid backfill stored 5 bars");
  eq(r1.oldestBarTime, mkBar(0).time, "newest/oldest stamped honestly (oldest)");
  eq(r1.newestBarTime, mkBar(4).time, "newest/oldest stamped honestly (newest)");

  const back = await readCachedCandles({ symbol: SYMBOL, timeframe: TF, source: MT5_HISTORY_SOURCE, limit: 100 });
  eq(back.count, 5, "5 bars readable from the deep cache under mt5_broker");
  eq(back.candles[0]!.time, mkBar(0).time, "cache read is ascending from oldest");

  // ── 2. Garbage OHLC / bad time dropped, never stored ───────────────────────
  const garbage = payload([
    mkBar(5),
    mkBar(6, { high: 0.1 }), // high < low/open/close → invalid
    { time: "nope", open: 1, high: 2, low: 0.5, close: 1.5, tickVolume: 1 }, // bad time
  ]);
  const r2 = await ingestMt5CandleHistory(garbage, { now: NOW });
  eq(r2.accepted, 1, "garbage batch accepted only the 1 valid bar");
  eq(r2.rejected, 2, "garbage batch rejected 2 invalid bars");
  const cov2 = await getCacheCoverage(SYMBOL, TF, MT5_HISTORY_SOURCE);
  eq(cov2.count, 6, "garbage never inflated the cache (5 + 1 = 6)");

  // ── 3. STALE transport refused, stores nothing ────────────────────────────
  const stale = payload([mkBar(7), mkBar(8)], {
    sentAt: new Date(NOW - 10 * 60_000).toISOString(), // 10 min old → replay
  });
  const r3 = await ingestMt5CandleHistory(stale, { now: NOW });
  eq(r3.accepted, 0, "stale transport accepted 0 bars");
  eq(r3.stored, 0, "stale transport stored 0 bars");
  eq(r3.note, "stale_push_timestamp", "stale transport flagged honestly");
  const cov3 = await getCacheCoverage(SYMBOL, TF, MT5_HISTORY_SOURCE);
  eq(cov3.count, 6, "stale transport never grew the cache");

  // ── 4. Unparsable sentAt refused (fail-closed) ─────────────────────────────
  const badTs = payload([mkBar(9)], { sentAt: "not-a-time" });
  const r4 = await ingestMt5CandleHistory(badTs, { now: NOW });
  eq(r4.accepted, 0, "unparsable sentAt accepted 0 bars");
  eq(r4.note, "invalid_push_timestamp", "unparsable sentAt flagged honestly");

  // ── 5. All-invalid payload → no_valid_bars, NEVER clears existing series ────
  const allBad = payload([mkBar(10, { low: 99 })]); // low > min(o,c) → invalid
  const r5 = await ingestMt5CandleHistory(allBad, { now: NOW });
  eq(r5.stored, 0, "all-invalid payload stored nothing");
  eq(r5.note, "no_valid_bars", "all-invalid payload flagged no_valid_bars");
  const cov5 = await getCacheCoverage(SYMBOL, TF, MT5_HISTORY_SOURCE);
  eq(cov5.count, 6, "all-invalid payload did NOT clear the existing 6-bar series");

  // ── 6. Duplicate bar times within a batch collapse (last write wins) ───────
  const dupClose = 7.7777;
  const dup = payload([
    mkBar(11),
    mkBar(11, { close: dupClose, high: dupClose + 0.01 }), // same time, newer values
  ]);
  const r6 = await ingestMt5CandleHistory(dup, { now: NOW });
  eq(r6.accepted, 1, "duplicate-time batch collapses to 1 bar");
  const afterDup = await readCachedCandles({ symbol: SYMBOL, timeframe: TF, source: MT5_HISTORY_SOURCE, limit: 100 });
  const bar11 = afterDup.candles.find((c) => c.time === mkBar(11).time);
  eq(bar11?.close, dupClose, "duplicate collapse kept the last-written values");

  // ── Cleanup (fail-closed) ──────────────────────────────────────────────────
  await __deleteCachedSymbol(SYMBOL);
  const left = await getCacheCoverage(SYMBOL, TF, MT5_HISTORY_SOURCE);
  eq(left.count, 0, "cleanup removed all synthetic mt5_broker rows");
}

main()
  .then(() => {
    console.log(`\nMT5 candle-history ingest test: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
      process.exit(1);
    }
    console.log("All MT5 candle-history ingest assertions passed.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("MT5 candle-history ingest test crashed:", e);
    process.exit(1);
  });

export {};
