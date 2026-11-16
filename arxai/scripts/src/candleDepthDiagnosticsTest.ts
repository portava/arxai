// ── Admin candle-depth diagnostics test (Task #434) ─────────────────────────
//
// Locks the honesty + structure contract of `buildCandleDepthReport()` — the
// read-only admin "Test Candle Depth" probe — WITHOUT depending on a live
// upstream provider. We drive the SAME router the real diagnostics use through
// two deterministic seams:
//
//   1. mt5_broker in-memory push (updateCandlesFromMT5) → a genuinely FRESH
//      newest window, so the router answers live. This is the ONLY way a row is
//      allowed to read "live".
//   2. the persisted DB cache (upsertCandles) of OLD bars for a symbol the
//      router can never fetch fresh → the service falls back to the cached
//      source and MUST label it "stale", never "live".
//
// Asserted spec behaviours:
//   - real data flowing ⇒ pass true; a fresh mt5 push ⇒ status "live".
//   - NO-FALSE-LIVE: a cache-only (old) symbol is "stale", never "live"; a
//     symbol with nothing anywhere is "unavailable" + pass false.
//   - pass honesty: NO row is ever pass=true while returned=0 / source=null /
//     status="unavailable".
//   - cross-timeframe isolation: seeding only M5 leaves M15 honestly empty.
//   - different-symbol separation: the fresh symbol and the stale symbol report
//     independently (live vs stale, different oldest bars).
//   - deep-history fields present + typed (depthTargetDays per-tf, coverageDays,
//     providerLimitReached / hasMoreHistory booleans) — no fabrication.
//   - executionSource is DESCRIPTIVE and present on the report and every row.
//
// MARKET-DATA / TELEMETRY ONLY. Uses run-unique synthetic symbols; touches no
// execution path, arx_live_* table, balance, or fill. Cleans up fail-closed
// (DB cache via __deleteCachedSymbol, mt5 seam via an empty push).

import {
  buildCandleDepthReport,
  type CandleDepthRow,
} from "../../artifacts/api-server/src/lib/data/candleDepthDiagnostics.js";
import {
  __deleteCachedSymbol,
  getCacheCoverage,
  upsertCandles,
} from "../../artifacts/api-server/src/lib/data/candleCache.js";
import {
  updateCandlesFromMT5,
  __resetMt5ProviderStore,
} from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";
import { depthTargetDaysFor } from "../../artifacts/api-server/src/lib/data/providerRoutingMap.js";
import type { Candle } from "../../artifacts/api-server/src/lib/data/types.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

let passes = 0;
let failures = 0;
const failureLabels: string[] = [];

function assert(cond: boolean, label: string): void {
  if (cond) {
    passes++;
  } else {
    failures++;
    failureLabels.push(label);
    // eslint-disable-next-line no-console
    console.error(`  \u2717 ${label}`);
  }
}
function eq<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const FRESH_SYMBOL = `__TEST_DEPTH_FRESH_${RUN}`.toUpperCase();
const STALE_SYMBOL = `__TEST_DEPTH_STALE_${RUN}`.toUpperCase();

const M5 = { label: "5m", timeframe: "M5" };
const M15 = { label: "15m", timeframe: "M15" };
const PROBE = [M5, M15];

const M5_MS = 5 * 60_000;
// Forward-only assistant source: a fake symbol can never be fetched fresh, so
// the service falls back to this cached source and must label it stale.
const STALE_SOURCE = "assistant_real";

function mkBar(timeMs: number, i: number, basePrice: number): Candle {
  const close = basePrice + i * 0.0001;
  const open = close - 0.00005;
  return {
    time: new Date(timeMs).toISOString(),
    open,
    high: Math.max(open, close) + 0.00005,
    low: Math.min(open, close) - 0.00005,
    close,
    volume: 100 + i,
  };
}

function row(rows: CandleDepthRow[], timeframe: string): CandleDepthRow {
  const r = rows.find((x) => x.timeframe === timeframe);
  if (!r) throw new Error(`row for ${timeframe} missing from report`);
  return r;
}

async function cleanup(): Promise<void> {
  await __deleteCachedSymbol(FRESH_SYMBOL).catch(() => {});
  await __deleteCachedSymbol(STALE_SYMBOL).catch(() => {});
  // Fully reset the in-memory mt5 seam. An empty push is NOT enough: every
  // push (even []) stamps the GLOBAL `lastUpdate`, leaving mt5Provider's
  // process-wide `isConnected()` true for ~60s and leaking state into any
  // later in-process test. `__resetMt5ProviderStore()` clears the series store
  // AND zeroes `lastUpdate`. Safe here: this test process is separate from the
  // running api-server workflow (no live EA feed in-process) and this test runs
  // last in the in-process CI suite.
  __resetMt5ProviderStore();
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  failureLabels.length = 0;
  // eslint-disable-next-line no-console
  console.log("candleDepthDiagnosticsTest");
  // eslint-disable-next-line no-console
  console.log("=========================\n");

  await cleanup();

  try {
    // ── Seed 1: FRESH symbol — push a fresh mt5_broker M5 window (live path) ──
    // Newest bar at the current M5 bucket ⇒ trailing 0 ⇒ buildFeedStatus clean
    // ⇒ getCandleHistory status "live". M15 is left unpushed on purpose.
    const bucket = Math.floor(Date.now() / M5_MS) * M5_MS;
    const freshBars: Candle[] = Array.from({ length: 60 }, (_, i) =>
      mkBar(bucket - (59 - i) * M5_MS, i, 1.1),
    );
    updateCandlesFromMT5(FRESH_SYMBOL, freshBars, M5.timeframe);

    // ── Seed 2: STALE symbol — OLD bars in the DB cache only (M5), no M15 ─────
    // A 2026-01-01 anchor guarantees the newest cached bar is far in the past,
    // so even after the cache-fallback the status is "stale", never "live".
    const oldBase = Date.UTC(2026, 0, 1, 0, 0, 0);
    const staleBars: Candle[] = Array.from({ length: 40 }, (_, i) =>
      mkBar(oldBase + i * M5_MS, i, 1.2),
    );
    const w = await upsertCandles(STALE_SYMBOL, M5.timeframe, STALE_SOURCE, staleBars);
    eq(w.written, 40, "seeded 40 old M5 bars into DB cache for the stale symbol");
    const expectedStaleOldest = staleBars[0]!.time;

    // ── Build both reports through the REAL diagnostics path ─────────────────
    const freshReport = await buildCandleDepthReport(FRESH_SYMBOL, PROBE);
    const staleReport = await buildCandleDepthReport(STALE_SYMBOL, PROBE);

    // ── FRESH symbol: M5 is live + passes; M15 is honestly empty ─────────────
    const fM5 = row(freshReport.rows, "M5");
    eq(fM5.status, "live", "fresh mt5 push ⇒ M5 status live");
    eq(fM5.pass, true, "fresh M5 passes (real candles flowed)");
    assert(fM5.source != null, "fresh M5 has a coherent source");
    assert(fM5.returned > 0, "fresh M5 returned > 0 bars");
    assert(fM5.candleAgeMs != null && fM5.candleAgeMs >= 0 && fM5.candleAgeMs < 30 * 60_000,
      `fresh M5 candle age is recent (got ${fM5.candleAgeMs}ms)`);

    const fM15 = row(freshReport.rows, "M15");
    assert(fM15.status !== "live", "unpushed M15 is NOT labelled live (cross-tf isolation)");
    // Nothing anywhere (no mt5 push, no DB cache) for this run-unique fake
    // symbol ⇒ the router can never answer and there is no cache to fall back
    // to ⇒ honest "unavailable". This hard-locks the no-false-live baseline.
    eq(fM15.status, "unavailable", "fully-empty M15 ⇒ status unavailable (honest absence)");
    eq(fM15.pass, false, "unpushed M15 does not pass (no data flowed)");
    eq(fM15.returned, 0, "unavailable M15 returned 0 bars");
    eq(fM15.source, null, "unavailable M15 has no source");
    assert(fM5.pass !== fM15.pass, "M5 and M15 of the same symbol resolve independently");

    // ── STALE symbol: M5 cache-fallback is stale (never live) but passes ─────
    const sM5 = row(staleReport.rows, "M5");
    assert(sM5.status !== "live", "cache-only OLD M5 is NEVER labelled live");
    eq(sM5.status, "stale", "cache-only OLD M5 ⇒ stale");
    eq(sM5.pass, true, "stale M5 still passes (real cached candles flowed)");
    eq(sM5.oldest, expectedStaleOldest, "stale M5 reports the exact oldest seeded bar");
    assert(sM5.source != null, "stale M5 has a coherent (cached) source");
    assert(sM5.cacheCount >= 40, `stale M5 cacheCount reflects the seeded depth (got ${sM5.cacheCount})`);

    const sM15 = row(staleReport.rows, "M15");
    eq(sM15.pass, false, "stale symbol M15 (no cache) does not pass");
    assert(sM15.status !== "live", "stale symbol M15 is not live");

    // ── Different-symbol separation ──────────────────────────────────────────
    assert(freshReport.symbol !== staleReport.symbol, "the two reports are for different symbols");
    assert(fM5.status === "live" && sM5.status === "stale",
      "fresh and stale symbols resolve to independent statuses (live vs stale)");
    assert(fM5.oldest !== sM5.oldest, "fresh and stale M5 oldest bars differ (no cross-symbol bleed)");

    // ── Deep-history fields present + typed (no fabrication) ─────────────────
    eq(sM5.depthTargetDays, depthTargetDaysFor("M5"), "M5 depthTargetDays matches the per-tf target");
    assert(sM5.depthTargetDays > 0, "M5 depthTargetDays is positive");
    eq(typeof sM5.providerLimitReached, "boolean", "providerLimitReached is a boolean");
    eq(typeof sM5.hasMoreHistory, "boolean", "hasMoreHistory is a boolean");
    eq(typeof sM5.depthTargetMet, "boolean", "depthTargetMet is a boolean");
    assert(sM5.coverageDays != null && sM5.coverageDays >= 0,
      `stale M5 coverageDays is a non-negative number (got ${sM5.coverageDays})`);

    // ── executionSource is descriptive + present everywhere ──────────────────
    assert(typeof freshReport.executionSource === "string" && freshReport.executionSource.length > 0,
      "report executionSource is a non-empty descriptive string");
    assert(freshReport.executionSource.includes("mt5_broker"),
      "executionSource descriptively names the mt5_broker route");
    for (const r of [...freshReport.rows, ...staleReport.rows]) {
      assert(typeof r.executionSource === "string" && r.executionSource.length > 0,
        `row ${r.timeframe} carries a descriptive executionSource`);
    }

    // ── Global no-false-live + pass-honesty invariant across EVERY row ───────
    const allRows = [...freshReport.rows, ...staleReport.rows];
    for (const r of allRows) {
      assert(!(r.pass && (r.returned === 0 || r.source == null || r.status === "unavailable")),
        `row ${r.timeframe} never passes while empty/sourceless/unavailable`);
    }
    // The ONLY rows allowed to be "live" are the fresh-push symbol's rows.
    const liveRowsFromStale = staleReport.rows.filter((r) => r.status === "live");
    eq(liveRowsFromStale.length, 0, "the stale (cache-only) symbol produced ZERO live rows");

    // ── Summary integrity ────────────────────────────────────────────────────
    eq(freshReport.summary.total, PROBE.length, "summary.total equals the probed timeframe count");
    eq(freshReport.summary.passed + freshReport.summary.failed, PROBE.length,
      "summary passed + failed accounts for every probed timeframe");
    eq(freshReport.summary.passed, freshReport.rows.filter((r) => r.pass).length,
      "summary.passed equals the count of passing rows");

    // ── Broker resolution fields are present + typed ─────────────────────────
    assert(typeof freshReport.brokerSymbol === "string" && freshReport.brokerSymbol.length > 0,
      "report carries a resolved brokerSymbol string");
    eq(typeof freshReport.brokerDirectoryLoaded, "boolean", "brokerDirectoryLoaded is a boolean");
    eq(typeof freshReport.brokerDirectoryEntryCount, "number", "brokerDirectoryEntryCount is a number");

    // ── Live-quote availability is typed + honest about age ──────────────────
    // The fresh symbol pushed candles, not a tick quote, so no quote exists for
    // these run-unique fake symbols. The contract: absent quote ⇒ ageMs null;
    // present quote ⇒ ageMs a non-negative number. Never a fabricated age.
    for (const rep of [freshReport, staleReport]) {
      eq(typeof rep.liveQuote.present, "boolean", "liveQuote.present is a boolean");
      eq(typeof rep.liveQuote.fresh, "boolean", "liveQuote.fresh is a boolean");
      eq(typeof rep.liveQuote.hasPrice, "boolean", "liveQuote.hasPrice is a boolean");
      if (rep.liveQuote.present) {
        assert(typeof rep.liveQuote.ageMs === "number" && rep.liveQuote.ageMs >= 0,
          `present liveQuote carries a non-negative ageMs (got ${rep.liveQuote.ageMs})`);
      } else {
        eq(rep.liveQuote.ageMs, null, "absent liveQuote has null ageMs (no fabricated age)");
        eq(rep.liveQuote.fresh, false, "absent liveQuote is never 'fresh'");
      }
    }
  } finally {
    await cleanup();
  }

  // ── Cleanup verification (fail-closed) ─────────────────────────────────────
  const leftStale = await getCacheCoverage(STALE_SYMBOL, M5.timeframe, STALE_SOURCE).catch(() => ({ count: -1 }));
  eq(leftStale.count, 0, "cleanup removed all seeded stale-symbol cache rows");

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  if (failures > 0) {
    // eslint-disable-next-line no-console
    console.error("FAILURES:\n" + failureLabels.map((f) => `  - ${f}`).join("\n"));
  }
  return { name: "candleDepthDiagnosticsTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    async (err) => {
      await cleanup().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[candleDepthDiagnosticsTest] FAILED:", err);
      process.exit(1);
    },
  );
}

export {};
