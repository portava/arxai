// ── Deep chart history scroll-back test (Task #438) ─────────────────────────
//
// Locks the deep-history contract that the two frontend charts rely on when the
// user scrolls left to load older bars. It exercises `getCandleHistory()`
// directly against a seeded cache with an explicit `source` (the continuation
// path), so it is fully offline & deterministic — no live provider, no network.
//
// Asserted #438 behaviour (additive to the #432 history-service test):
//   - Raised per-timeframe depth targets are surfaced (DEPTH_TARGET_DAYS / the
//     result's depthTargetDays), so the badge can report coverage vs target.
//   - The honest provenance block is present: sourcePriorityUsed is the real
//     history provider chain, echoed on every page.
//   - Scroll-back pages strictly OLDER bars (cursor advances) and a back-page is
//     ALWAYS `historical_only` — never `live`.
//   - A forward-only provider with a short window reports an honest
//     providerLimitReached + limitationReason (=== providerMessage), never a
//     fabricated bar.
//   - A cache-only newest window is `stale`, never `live`.
//   - NO response is ever labelled `live` in this offline test.
//
// MARKET-DATA / TELEMETRY ONLY: this touches no execution path, no 16-gate, no
// arx_live_* table, no balance/fill. Uses run-unique synthetic symbols and
// cleans up fail-closed (a leftover row is reported, never ignored).

import { getCandleHistory } from "../../artifacts/api-server/src/lib/data/candleHistoryService.js";
import {
  __deleteCachedSymbol,
  getCacheCoverage,
  upsertCandles,
} from "../../artifacts/api-server/src/lib/data/candleCache.js";
import {
  DEPTH_TARGET_DAYS,
  depthTargetDaysFor,
} from "../../artifacts/api-server/src/lib/data/providerRoutingMap.js";
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
const SYMBOL = `__TEST_DEEP_${RUN}`.toUpperCase();
const SHORT_SYMBOL = `__TEST_DEEP_SHORT_${RUN}`.toUpperCase();
const TF = "M5";
// Forward-only source (no deep cursor) → a short window reports an honest limit
// rather than hitting a live provider; keeps the test offline & deterministic.
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
  await __deleteCachedSymbol(SHORT_SYMBOL);

  const seenStatuses: string[] = [];

  // ── 0. Raised per-timeframe depth targets surfaced (T001) ──────────────────
  eq(DEPTH_TARGET_DAYS.M1, 365, "depth target M1 raised to 365d");
  eq(DEPTH_TARGET_DAYS.M5, 730, "depth target M5 raised to 730d");
  eq(DEPTH_TARGET_DAYS.M15, 1095, "depth target M15 raised to 1095d");
  eq(DEPTH_TARGET_DAYS.M30, 1095, "depth target M30 inherits 1095d");
  eq(DEPTH_TARGET_DAYS.H1, 1825, "depth target H1 raised to 1825d");
  eq(DEPTH_TARGET_DAYS.H4, 2555, "depth target H4 raised to 2555d");
  eq(DEPTH_TARGET_DAYS.D1, 3650, "depth target D1 raised to 3650d");

  // Seed 30 ascending bars for one coherent source.
  const seed: Candle[] = Array.from({ length: 30 }, (_, i) => mkCandle(i));
  const w = await upsertCandles(SYMBOL, TF, SOURCE, seed);
  eq(w.written, 30, "seeded 30 bars into cache");

  // ── 1. Newest window: honest provenance + depth metadata, NEVER live ───────
  const newest = await getCandleHistory({ symbol: SYMBOL, timeframe: TF, limit: 10, source: SOURCE });
  seenStatuses.push(newest.status);
  eq(newest.ok, true, "newest window ok");
  ok(Array.isArray(newest.sourcePriorityUsed) && newest.sourcePriorityUsed.length > 0,
    "sourcePriorityUsed is the real history provider chain (non-empty)");
  eq(newest.depthTargetDays, depthTargetDaysFor(TF), "depthTargetDays surfaced per-timeframe");
  ok(newest.coverageDays != null, "coverageDays surfaced for a seeded series");
  eq(newest.depthTargetMet, false, "short seed does not meet the raised depth target");
  ok(newest.status !== "live", "OLD newest window is NOT labelled live");
  eq(newest.status, "stale", "cache-only newest window → stale");
  ok(newest.nextBefore != null, "nextBefore cursor present when more history exists");
  eq(newest.providerLimitReached, false, "newest window with more cached bars is not capped");
  eq(newest.limitationReason, null, "limitationReason null when not capped");

  // ── 2. Scroll-back pages strictly OLDER bars, always historical_only ───────
  let cursor = newest.oldest;
  let prevOldest = newest.oldest!;
  let pagedOlder = 0;
  for (let i = 0; i < 2 && cursor != null; i += 1) {
    const back = await getCandleHistory({
      symbol: SYMBOL, timeframe: TF, limit: 10, source: SOURCE, before: cursor,
    });
    seenStatuses.push(back.status);
    eq(back.status, "historical_only", `back-page #${i + 1} → historical_only (never live)`);
    eq(back.source, SOURCE, `back-page #${i + 1} stays on the coherent source`);
    ok(Array.isArray(back.sourcePriorityUsed) && back.sourcePriorityUsed.length > 0,
      `back-page #${i + 1} echoes sourcePriorityUsed`);
    if (back.returnedCount > 0) {
      ok(back.newest! < prevOldest, `back-page #${i + 1} bars strictly OLDER than the cursor`);
      prevOldest = back.oldest!;
      pagedOlder += 1;
    }
    cursor = back.hasMoreHistory ? back.nextBefore : null;
  }
  ok(pagedOlder >= 1, "deep history paged at least one strictly-older window");

  // ── 3. Forward-only short window → honest providerLimitReached + reason ─────
  // Seed FEWER bars than the requested window so the service wants older bars
  // but the forward-only source cannot page deeper → honest limit, no fabrication.
  const shortSeed: Candle[] = Array.from({ length: 5 }, (_, i) => mkCandle(i));
  await upsertCandles(SHORT_SYMBOL, TF, SOURCE, shortSeed);
  const capped = await getCandleHistory({
    symbol: SHORT_SYMBOL, timeframe: TF, limit: 50, source: SOURCE,
  });
  seenStatuses.push(capped.status);
  eq(capped.returnedCount, 5, "short window returns only the 5 real bars (no fabrication)");
  eq(capped.providerLimitReached, true, "forward-only short window reports an honest provider limit");
  ok(capped.limitationReason != null, "limitationReason populated when capped");
  eq(capped.limitationReason, capped.providerMessage, "limitationReason mirrors providerMessage when capped");
  ok(capped.status !== "live", "capped short window is NOT labelled live");

  // ── 4. Cross-cut: NOTHING in this offline test is ever labelled live ───────
  ok(!seenStatuses.includes("live"), `no response labelled live (saw: ${seenStatuses.join(", ")})`);

  // ── Cleanup (fail-closed) ──────────────────────────────────────────────────
  await __deleteCachedSymbol(SYMBOL);
  await __deleteCachedSymbol(SHORT_SYMBOL);
  const left = await getCacheCoverage(SYMBOL, TF, SOURCE);
  eq(left.count, 0, "cleanup removed all synthetic history rows");
  const leftShort = await getCacheCoverage(SHORT_SYMBOL, TF, SOURCE);
  eq(leftShort.count, 0, "cleanup removed short-symbol history rows");
}

main()
  .then(() => {
    console.log(`\nChart deep-history test: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
      process.exit(1);
    }
    console.log("All chart deep-history assertions passed.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("Chart deep-history test crashed:", e);
    process.exit(1);
  });

export {};
