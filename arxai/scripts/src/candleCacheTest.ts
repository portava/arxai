// ── Persisted candle cache test (Task #432) ─────────────────────────────────
//
// Locks the deep-history storage contract of `candleCache.ts` against the REAL
// `market_candles` table:
//   - upsertCandles dedupes by (symbol,timeframe,source,barTime) and updates
//     OHLCV in place — a re-fetched window NEVER creates duplicate rows.
//   - Invalid/garbage OHLC bars are dropped, never stored (no fabrication).
//   - readCachedCandles returns ascending bars, the `before` cursor pages
//     strictly OLDER bars, and hasOlderInCache flags remaining depth.
//   - getCacheCoverage reports honest oldest/newest/count.
//   - One coherent SOURCE per read — two sources for the same symbol/tf never
//     bleed into one series.
//
// MARKET-DATA / TELEMETRY ONLY. Touches no execution path. Uses a run-unique
// synthetic symbol and cleans up fail-closed: a leftover row is reported, never
// ignored.

import {
  __deleteCachedSymbol,
  getCacheCoverage,
  isValidCacheOhlc,
  readCachedCandles,
  upsertCandles,
} from "../../artifacts/api-server/src/lib/data/candleCache.js";
import type { Candle } from "../../artifacts/api-server/src/lib/data/types.js";

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

// Run-unique synthetic symbol so reruns never collide and never touch a real one.
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const SYMBOL = `__TEST_CACHE_${RUN}`.toUpperCase();
const TF = "M5";
const SOURCE = "deriv";
const OTHER_SOURCE = "assistant_real";

const BAR_MS = 5 * 60_000;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0); // fixed anchor, ascending bars

function mkCandle(i: number, close = 1.1 + i * 0.001): Candle {
  const open = close - 0.0005;
  return {
    time: new Date(BASE + i * BAR_MS).toISOString(),
    open,
    high: close + 0.0005,
    low: open - 0.0005,
    close,
    volume: 100 + i,
  };
}

async function main(): Promise<void> {
  // ── 0. Validity guard ──────────────────────────────────────────────────────
  eq(isValidCacheOhlc({ open: 1, high: 2, low: 0.5, close: 1.5 }), true, "valid OHLC accepted");
  eq(isValidCacheOhlc({ open: 1, high: 0.5, low: 0.6, close: 1.5 }), false, "high<low rejected");
  eq(isValidCacheOhlc({ open: 1, high: 2, low: 0.5, close: NaN }), false, "NaN close rejected");
  eq(isValidCacheOhlc({ open: -1, high: 2, low: 0.5, close: 1 }), false, "non-positive open rejected");
  eq(isValidCacheOhlc({ open: 1, high: 0.9, low: 0.5, close: 0.8 }), false, "high<max(o,c) rejected");

  // Clean slate for this synthetic symbol.
  await __deleteCachedSymbol(SYMBOL);

  // ── 1. Initial upsert of 10 ascending bars ─────────────────────────────────
  const first = await upsertCandles(SYMBOL, TF, SOURCE, [
    mkCandle(0), mkCandle(1), mkCandle(2), mkCandle(3), mkCandle(4),
    mkCandle(5), mkCandle(6), mkCandle(7), mkCandle(8), mkCandle(9),
  ]);
  eq(first.written, 10, "first upsert wrote 10 bars");
  eq(first.rejected, 0, "first upsert rejected 0 bars");

  const cov1 = await getCacheCoverage(SYMBOL, TF, SOURCE);
  eq(cov1.count, 10, "coverage count is 10 after first upsert");
  eq(cov1.oldest, mkCandle(0).time, "coverage oldest is bar 0");
  eq(cov1.newest, mkCandle(9).time, "coverage newest is bar 9");

  // ── 2. Re-upsert overlapping window with CHANGED close → update-in-place ────
  const changed = { ...mkCandle(9, 9.9999) };
  const second = await upsertCandles(SYMBOL, TF, SOURCE, [
    mkCandle(8), changed, mkCandle(10),
  ]);
  eq(second.written, 3, "overlap upsert reports 3 written");
  const cov2 = await getCacheCoverage(SYMBOL, TF, SOURCE);
  eq(cov2.count, 11, "no duplicate rows after overlap upsert (10 + 1 new = 11)");
  const all = await readCachedCandles({ symbol: SYMBOL, timeframe: TF, source: SOURCE, limit: 100 });
  const bar9 = all.candles.find((c) => c.time === changed.time);
  eq(bar9?.close, 9.9999, "bar 9 close updated in place (upsert-newer)");

  // ── 3. Invalid bars dropped, never stored ──────────────────────────────────
  const withGarbage = await upsertCandles(SYMBOL, TF, SOURCE, [
    mkCandle(11),
    { time: new Date(BASE + 12 * BAR_MS).toISOString(), open: 1, high: 0.5, low: 0.6, close: 2 }, // high<low
    { time: "not-a-date", open: 1, high: 2, low: 0.5, close: 1.5 }, // bad time
  ]);
  eq(withGarbage.written, 1, "only the 1 valid bar written from garbage batch");
  eq(withGarbage.rejected, 2, "2 invalid bars rejected");
  const cov3 = await getCacheCoverage(SYMBOL, TF, SOURCE);
  eq(cov3.count, 12, "garbage never inflated the cache (11 + 1 = 12)");

  // ── 4. Ascending read + `before` cursor pages strictly OLDER ───────────────
  const pageNewest = await readCachedCandles({ symbol: SYMBOL, timeframe: TF, source: SOURCE, limit: 5 });
  eq(pageNewest.count, 5, "newest page returns 5 bars");
  ok(pageNewest.candles[0]!.time < pageNewest.candles[4]!.time, "page is ascending by time");
  eq(pageNewest.hasOlderInCache, true, "newest page reports older bars remain");
  eq(pageNewest.newest, mkCandle(11).time, "newest page newest is the latest bar");

  const olderPage = await readCachedCandles({
    symbol: SYMBOL, timeframe: TF, source: SOURCE, before: pageNewest.oldest, limit: 5,
  });
  eq(olderPage.count, 5, "back-page returns 5 older bars");
  ok(olderPage.newest! < pageNewest.oldest!, "back-page bars are strictly OLDER than the cursor");
  eq(olderPage.hasOlderInCache, true, "back-page still reports older bars remain (12 total)");

  // ── 5. One coherent SOURCE per read (no source bleed) ──────────────────────
  await upsertCandles(SYMBOL, TF, OTHER_SOURCE, [mkCandle(0), mkCandle(1)]);
  const derivOnly = await readCachedCandles({ symbol: SYMBOL, timeframe: TF, source: SOURCE, limit: 100 });
  eq(derivOnly.count, 12, "deriv read still 12 — other source never bleeds in");
  const otherOnly = await readCachedCandles({ symbol: SYMBOL, timeframe: TF, source: OTHER_SOURCE, limit: 100 });
  eq(otherOnly.count, 2, "assistant_real read isolated to its own 2 bars");

  // ── Cleanup (fail-closed) ──────────────────────────────────────────────────
  await __deleteCachedSymbol(SYMBOL);
  const leftDeriv = await getCacheCoverage(SYMBOL, TF, SOURCE);
  const leftOther = await getCacheCoverage(SYMBOL, TF, OTHER_SOURCE);
  eq(leftDeriv.count, 0, "cleanup removed all deriv synthetic rows");
  eq(leftOther.count, 0, "cleanup removed all assistant_real synthetic rows");
}

main()
  .then(() => {
    console.log(`\nCandle cache test: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
      process.exit(1);
    }
    console.log("All candle cache assertions passed.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("Candle cache test crashed:", e);
    process.exit(1);
  });

export {};
