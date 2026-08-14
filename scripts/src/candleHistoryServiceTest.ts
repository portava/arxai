// ── Candle history service test (Task #432) ─────────────────────────────────
//
// Locks the paginated, honesty-stamped read contract of `getCandleHistory()`
// WITHOUT depending on a live provider: we seed the persisted cache directly and
// drive reads with an explicit `source` (the continuation path), which skips the
// router/network entirely and stays fully deterministic & offline.
//
// Asserted honesty rules:
//   - newest window of OLD data → "stale" (never "live").
//   - a page reached via the `before` cursor → "historical_only" (never "live").
//   - one coherent source per response (provenance echoed back).
//   - hasMoreHistory + nextBefore reflect remaining cached depth.
//   - empty cache for the requested source → "unavailable", ok:false, never
//     fabricated bars.
//   - depthTargetDays is per-timeframe and present.
//
// MARKET-DATA / TELEMETRY ONLY. Uses a run-unique synthetic symbol; cleans up
// fail-closed (a leftover row is reported, never ignored).

import { getCandleHistory } from "../../artifacts/api-server/src/lib/data/candleHistoryService.js";
import {
  __deleteCachedSymbol,
  getCacheCoverage,
  upsertCandles,
} from "../../artifacts/api-server/src/lib/data/candleCache.js";
import { depthTargetDaysFor } from "../../artifacts/api-server/src/lib/data/providerRoutingMap.js";
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

const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const SYMBOL = `__TEST_HIST_${RUN}`.toUpperCase();
const EMPTY_SYMBOL = `__TEST_HIST_EMPTY_${RUN}`.toUpperCase();
const RECENT_SYMBOL = `__TEST_HIST_RECENT_${RUN}`.toUpperCase();
const TF = "M5";
// Forward-only source (no deep cursor) so a short window reports an honest limit
// rather than hitting a live provider — keeps the test offline & deterministic.
const SOURCE = "assistant_real";

const BAR_MS = 5 * 60_000;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0); // OLD anchor → newest window is stale

function mkCandle(i: number): Candle {
  const close = 1.1 + i * 0.001;
  const open = close - 0.0005;
  return {
    time: new Date(BASE + i * BAR_MS).toISOString(),
    open, high: close + 0.0005, low: open - 0.0005, close, volume: 100 + i,
  };
}

async function main(): Promise<void> {
  await __deleteCachedSymbol(SYMBOL);
  await __deleteCachedSymbol(EMPTY_SYMBOL);

  // Seed 30 ascending bars for one coherent source.
  const seed: Candle[] = Array.from({ length: 30 }, (_, i) => mkCandle(i));
  const w = await upsertCandles(SYMBOL, TF, SOURCE, seed);
  eq(w.written, 30, "seeded 30 bars into cache");

  // ── 1. Empty symbol → unavailable, honest, no fabrication ──────────────────
  const none = await getCandleHistory({ symbol: "", timeframe: TF, limit: 10 });
  eq(none.ok, false, "empty symbol → ok:false");
  eq(none.status, "unavailable", "empty symbol → status unavailable");
  eq(none.candles.length, 0, "empty symbol → zero candles");

  // ── 2. Newest window (no before) of OLD data → stale, NEVER live ───────────
  const newest = await getCandleHistory({ symbol: SYMBOL, timeframe: TF, limit: 10, source: SOURCE });
  eq(newest.ok, true, "newest window ok");
  eq(newest.source, SOURCE, "newest window echoes the coherent source");
  eq(newest.returnedCount, 10, "newest window returns the requested 10 bars");
  ok(newest.status !== "live", "OLD newest window is NOT labelled live");
  eq(newest.status, "stale", "OLD newest window → stale");
  eq(newest.cacheHit, true, "explicit-source read served from cache (no provider fetch)");
  eq(newest.hasMoreHistory, true, "more history available (older bars cached)");
  ok(newest.nextBefore != null, "nextBefore cursor present when more history exists");
  eq(newest.depthTargetDays, depthTargetDaysFor(TF), "depthTargetDays matches per-tf target");

  // ── 3. Back-page via `before` cursor → historical_only ─────────────────────
  const back = await getCandleHistory({
    symbol: SYMBOL, timeframe: TF, limit: 10, source: SOURCE, before: newest.oldest,
  });
  eq(back.status, "historical_only", "back-cursor page → historical_only");
  eq(back.returnedCount, 10, "back-page returns 10 older bars");
  ok(back.newest! < newest.oldest!, "back-page bars strictly OLDER than the cursor");
  eq(back.source, SOURCE, "back-page stays on the same coherent source");

  // ── 4. Exhausted history → no further nextBefore ───────────────────────────
  // Page all the way back: 30 bars, pages of 10 → third page is the oldest 10.
  const back2 = await getCandleHistory({
    symbol: SYMBOL, timeframe: TF, limit: 10, source: SOURCE, before: back.oldest,
  });
  eq(back2.returnedCount, 10, "third back-page returns the final 10 bars");
  eq(back2.hasMoreHistory, false, "no more history after the oldest page");
  eq(back2.nextBefore, null, "nextBefore null once history is exhausted");

  // ── 5. Empty cache for the requested source → unavailable, never fabricated ─
  const empty = await getCandleHistory({
    symbol: EMPTY_SYMBOL, timeframe: TF, limit: 10, source: SOURCE,
  });
  eq(empty.ok, false, "empty-cache source read → ok:false");
  eq(empty.status, "unavailable", "empty-cache source read → unavailable");
  eq(empty.candles.length, 0, "empty-cache source read → zero candles (no fabrication)");
  eq(empty.providerLimitReached, true, "forward-only source with no cache reports an honest limit");

  // ── 6. Invalid `before` cursor → fail-closed, NEVER a silent newest read ────
  // An unparsable cursor must not skip the cache filter and then get mislabeled
  // historical_only — it is rejected honestly.
  const badCursor = await getCandleHistory({
    symbol: SYMBOL, timeframe: TF, limit: 10, source: SOURCE, before: "not-a-date",
  });
  eq(badCursor.ok, false, "invalid before cursor → ok:false");
  eq(badCursor.status, "unavailable", "invalid before cursor → unavailable (fail-closed)");
  eq(badCursor.candles.length, 0, "invalid before cursor → zero candles (no newest fall-through)");

  // ── 7. Cache-only newest window with RECENT bars → still NOT live ──────────
  // Even when the cached newest bar is current, a read served from cache alone
  // (explicit source → router never consulted) can never claim "live": live
  // requires a fresh provider confirmation this call.
  const recentSeed: Candle[] = Array.from({ length: 5 }, (_, i) => {
    const close = 1.2 + i * 0.001;
    const open = close - 0.0005;
    return {
      time: new Date(Date.now() - (4 - i) * BAR_MS).toISOString(),
      open, high: close + 0.0005, low: open - 0.0005, close, volume: 200 + i,
    };
  });
  await upsertCandles(RECENT_SYMBOL, TF, SOURCE, recentSeed);
  const recent = await getCandleHistory({
    symbol: RECENT_SYMBOL, timeframe: TF, limit: 10, source: SOURCE,
  });
  eq(recent.ok, true, "recent cache-only newest window ok");
  eq(recent.cacheHit, true, "recent newest window served from cache (no provider fetch)");
  ok(recent.status !== "live", "RECENT cache-only newest window is NOT labelled live");
  eq(recent.status, "stale", "RECENT cache-only newest window → stale (no live confirmation)");

  // ── Cleanup (fail-closed) ──────────────────────────────────────────────────
  await __deleteCachedSymbol(SYMBOL);
  await __deleteCachedSymbol(EMPTY_SYMBOL);
  await __deleteCachedSymbol(RECENT_SYMBOL);
  const left = await getCacheCoverage(SYMBOL, TF, SOURCE);
  eq(left.count, 0, "cleanup removed all synthetic history rows");
  const leftRecent = await getCacheCoverage(RECENT_SYMBOL, TF, SOURCE);
  eq(leftRecent.count, 0, "cleanup removed recent-symbol history rows");
}

main()
  .then(() => {
    console.log(`\nCandle history service test: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
      process.exit(1);
    }
    console.log("All candle history service assertions passed.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("Candle history service test crashed:", e);
    process.exit(1);
  });

export {};
