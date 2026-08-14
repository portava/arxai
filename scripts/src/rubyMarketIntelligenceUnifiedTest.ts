// Test: Ruby's broad market-intelligence surfaces are UNIFIED onto the ONE
// shared truth layer the chart uses (Task #495). What Ruby says about a market
// must match exactly what the chart shows for the same symbol at the same
// moment, every "unavailable" must state the REAL cause, the scanner ENRICHES
// (never gates) the per-symbol picture, and a simulator/awaiting/history-only
// row can NEVER appear as a tradeable setup.
//
// FIVE deterministic honesty cases (mirrors task step 4):
//   1. Broker-source surfaces correctly via the broker seam — a clean, fresh
//      M15 window pushed through the genuine MT5 bridge seam
//      (updateCandlesFromMT5, FIRST in the forex router chain) makes the shared
//      snapshot report source=broker, quality "clean", aiUsable, isLive,
//      freshness REALTIME, and a real last price. getMarketSnapshot (the Ruby
//      tool) reports feedConfirmed=true off the SAME shared verdict.
//   2. Scanner-idle keeps the per-symbol picture intact with an honest idle
//      note — the overview's per-symbol snapshots are computed independently of
//      the scanner: a good snapshot stays good even when setups are empty, and
//      when the scanner is idle the snapshots array is still present (never
//      blanked) and the setups note honestly says "no live setups".
//   3. Provider-limited states the REAL cause — a symbol with no feed/coverage
//      returns aiUsable=false, freshness UNAVAILABLE, and a non-empty cause
//      taken straight from the feed status (never a speculative reason).
//   4. Broad snapshot vs chart read report identical source + quality at the
//      same moment — getSymbolSnapshot and getChartCandles, called with the same
//      (symbol, timeframe, limit), agree on source, quality, aiUsable, isLive.
//   5. No simulator row ever appears as a setup — scanCoreOpportunities keeps
//      ONLY dataStatus==="live" rows; every non-live row produced by the raw
//      single scoring path (scanSymbolTimeframe) is dropped before it can reach
//      Ruby.
//
// HOW THE STATES ARE REACHED (deterministically, no real provider data):
//   - "clean/REALTIME": push a clean, fresh, >=150-bar M15 window through the
//     MT5 bridge seam whose NEWEST bar opens at the CURRENT M15 bucket
//     (trailing 0). Forex is non-synthetic, so isLive needs no live tick — a
//     current closed-bar window is enough → quality "clean" → aiUsable=true →
//     freshness REALTIME. The seam is FIRST in the forex chain so the push wins
//     outright regardless of which API keys this env carries.
//   - "unavailable": a clearly non-existent ticker with NO feed pushed and no
//     provider coverage → the resolver honestly reports unavailable/empty with a
//     stated cause, never fabricating data.
//
// SAFETY / ISOLATION
//   - Pure in-process: calls the real functions directly. Never spins up the EA,
//     never inserts arx_live_commands, never places or closes a trade. Advisory
//     /read-only intelligence only — touches NO 16-gate / live / safety path.
//   - The candle "live feed" is injected via the SAME in-memory seam the real
//     MT5 bridge uses — a genuine real-data path, not fabricated simulator OHLC.
//   - Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:ruby-market-intelligence

import {
  getSymbolSnapshot,
  scanCoreOpportunities,
  getMarketOverview,
  __resetMarketOverviewCacheForTest,
  CORE_OVERVIEW_SYMBOLS,
} from "../../artifacts/api-server/src/lib/data/marketOverview.js";
import { getChartCandles } from "../../artifacts/api-server/src/lib/data/chart/chartDataService.js";
import { scanSymbolTimeframe } from "../../artifacts/api-server/src/lib/marketScanner.js";
import { getMarketSnapshot } from "../../artifacts/api-server/src/lib/assistant/tools.js";
import { updateCandlesFromMT5 } from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

// A forex symbol routes through [mt5_broker, ...]; the mt5_broker seam is FIRST,
// so a pushed window wins outright (deterministic even if API providers exist).
const VERIFIED_SYMBOL = "EURUSD";
// Clearly non-existent tickers: no feed pushed, no provider coverage.
const NO_FEED_A = "ZZNOFEEDAA";
const NO_FEED_B = "ZZNOFEEDBB";
const M15 = "M15" as const;
const M15_MS = 15 * 60 * 1000;
const SNAPSHOT_LIMIT = 200;
// Comfortably above MIN_CANDLE_HISTORY_COUNT (150) for the M15 chart-truth gate.
const CANDLE_COUNT = 220;

let passes = 0;
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passes++;
    // eslint-disable-next-line no-console
    console.log(`  \u2713 ${label}`);
  } else {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`  \u2717 ${label}`);
  }
}

/**
 * A clean, steady, low-drift M15 window whose NEWEST bar opens at the CURRENT
 * M15 bucket (trailing 0 → feed quality "clean" → aiUsable=true; forex isLive
 * needs no live tick). Equal candle ranges, zero gaps, valid OHLC — no
 * anomalies that would degrade the truth assessment below CLEAN.
 */
function buildCleanWindow(): Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> {
  const out: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  const base = 1.1000;
  const stepUp = 0.00002; // tiny per-bar drift → no spike/outlier anomalies
  const body = 0.00010;
  const wick = 0.00015;
  const currentBucket = Math.floor(Date.now() / M15_MS) * M15_MS;
  const start = currentBucket - (CANDLE_COUNT - 1) * M15_MS;
  for (let i = 0; i < CANDLE_COUNT; i++) {
    const close = base + i * stepUp;
    const open = close - body;
    const high = close + wick;
    const low = open - wick;
    out.push({
      time: new Date(start + i * M15_MS).toISOString(),
      open: Number(open.toFixed(5)),
      high: Number(high.toFixed(5)),
      low: Number(low.toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 1000,
    });
  }
  return out;
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("rubyMarketIntelligenceUnifiedTest");
  // eslint-disable-next-line no-console
  console.log("=================================\n");

  // ── 1. Broker-source surfaces correctly via the broker seam ───────────────
  // eslint-disable-next-line no-console
  console.log(`1) Broker-source via seam (${VERIFIED_SYMBOL}) — clean M15 window pushed`);
  updateCandlesFromMT5(VERIFIED_SYMBOL, buildCleanWindow(), M15);
  const snap1 = await getSymbolSnapshot(VERIFIED_SYMBOL, M15, SNAPSHOT_LIMIT);
  assert(typeof snap1.source === "string" && snap1.source.length > 0, `broker: source is a non-empty string (got ${String(snap1.source)})`);
  assert(/mt5|broker/i.test(String(snap1.source)), `broker: source names the broker feed (got ${String(snap1.source)})`);
  assert(snap1.quality === "clean", `broker: quality === "clean" (got ${snap1.quality})`);
  assert(snap1.aiUsable === true, `broker: aiUsable === true (got ${String(snap1.aiUsable)})`);
  assert(snap1.isLive === true, `broker: isLive === true (got ${String(snap1.isLive)})`);
  assert(snap1.freshness === "REALTIME", `broker: freshness === "REALTIME" (got ${snap1.freshness})`);
  assert(typeof snap1.lastPrice === "number" && snap1.lastPrice > 0, `broker: lastPrice positive number (got ${String(snap1.lastPrice)})`);
  assert(snap1.cause === null, `broker: cause === null on clean feed (got ${String(snap1.cause)})`);

  // getMarketSnapshot (the Ruby tool) must derive feedConfirmed off the SAME
  // shared verdict, and report the SAME source/quality (no separate truth).
  const tool1 = await getMarketSnapshot(VERIFIED_SYMBOL) as {
    source?: string | null; quality?: string; aiUsable?: boolean; isLive?: boolean;
    freshness?: string; feedConfirmed?: boolean; feedCaveat?: string | null;
  };
  assert(tool1.feedConfirmed === true, `broker: getMarketSnapshot feedConfirmed === true (got ${String(tool1.feedConfirmed)})`);
  assert(tool1.feedCaveat === null, `broker: getMarketSnapshot feedCaveat omitted (got ${String(tool1.feedCaveat)})`);
  assert(tool1.source === snap1.source, `broker: tool source matches shared snapshot (tool=${String(tool1.source)}, snap=${String(snap1.source)})`);
  assert(tool1.quality === snap1.quality, `broker: tool quality matches shared snapshot (tool=${String(tool1.quality)}, snap=${snap1.quality})`);

  // ── 2. Scanner-idle keeps the per-symbol picture intact + honest idle note ─
  // eslint-disable-next-line no-console
  console.log(`\n2) Scanner enrich-not-gate — per-symbol picture independent of scanner`);
  // 2a. Good snapshot present regardless of the setups state (push keeps it clean).
  __resetMarketOverviewCacheForTest();
  updateCandlesFromMT5(VERIFIED_SYMBOL, buildCleanWindow(), M15);
  const ovGood = await getMarketOverview({ symbols: [VERIFIED_SYMBOL], force: true });
  assert(ovGood.snapshots.length === 1, `enrich: per-symbol snapshots present (got ${ovGood.snapshots.length})`);
  assert(ovGood.snapshots[0]?.aiUsable === true, `enrich: good snapshot stays AI-usable irrespective of setups (got ${String(ovGood.snapshots[0]?.aiUsable)})`);
  assert(typeof ovGood.setups?.note === "string" && ovGood.setups.note.length > 0, `enrich: setups note is a non-empty string (got ${String(ovGood.setups?.note)})`);

  // 2b. Idle path — no-feed symbols: snapshots STILL present (never blanked),
  // setups idle with an honest "no live setups" note, zero opportunities.
  __resetMarketOverviewCacheForTest();
  const ovIdle = await getMarketOverview({ symbols: [NO_FEED_A], force: true });
  assert(ovIdle.snapshots.length === 1, `idle: per-symbol picture NOT blanked when scanner idle (got ${ovIdle.snapshots.length})`);
  assert(typeof ovIdle.snapshots[0]?.message === "string" && ovIdle.snapshots[0]!.message.length > 0, `idle: honest per-symbol message present (got ${String(ovIdle.snapshots[0]?.message)})`);
  assert(ovIdle.setups.scannerIdle === true, `idle: setups.scannerIdle === true (got ${String(ovIdle.setups.scannerIdle)})`);
  assert(ovIdle.setups.opportunities.length === 0, `idle: zero setups when scanner idle (got ${ovIdle.setups.opportunities.length})`);
  assert(/idle|no live setups/i.test(ovIdle.setups.note), `idle: note honestly states scanner idle (got "${ovIdle.setups.note}")`);

  // ── 3. Provider-limited states the REAL cause ─────────────────────────────
  // eslint-disable-next-line no-console
  console.log(`\n3) Provider-limited (${NO_FEED_A}) — states the real cause, no guess`);
  const snap3 = await getSymbolSnapshot(NO_FEED_A, M15, SNAPSHOT_LIMIT);
  assert(snap3.aiUsable === false, `cause: aiUsable === false on no feed (got ${String(snap3.aiUsable)})`);
  assert(snap3.freshness === "UNAVAILABLE", `cause: freshness === "UNAVAILABLE" (got ${snap3.freshness})`);
  assert(snap3.quality === "unavailable" || snap3.quality === "empty", `cause: quality unavailable/empty (got ${snap3.quality})`);
  assert(typeof snap3.cause === "string" && snap3.cause!.length > 0, `cause: a real (non-empty) cause is stated (got ${String(snap3.cause)})`);
  assert(typeof snap3.message === "string" && snap3.message.length > 0, `cause: a user-safe message is present (got ${String(snap3.message)})`);
  assert(snap3.lastPrice === null, `cause: lastPrice null when unavailable (got ${String(snap3.lastPrice)})`);

  // ── 4. Broad snapshot vs chart read — identical source + quality ──────────
  // eslint-disable-next-line no-console
  console.log(`\n4) Snapshot vs chart read (${VERIFIED_SYMBOL}) — identical source/quality at one moment`);
  updateCandlesFromMT5(VERIFIED_SYMBOL, buildCleanWindow(), M15);
  const [snap4, chart4] = await Promise.all([
    getSymbolSnapshot(VERIFIED_SYMBOL, M15, SNAPSHOT_LIMIT),
    getChartCandles(VERIFIED_SYMBOL, M15, SNAPSHOT_LIMIT),
  ]);
  assert(snap4.source === chart4.source, `match: source identical (snap=${String(snap4.source)}, chart=${String(chart4.source)})`);
  assert(snap4.quality === chart4.quality, `match: quality identical (snap=${snap4.quality}, chart=${chart4.quality})`);
  assert(snap4.aiUsable === chart4.aiUsable, `match: aiUsable identical (snap=${String(snap4.aiUsable)}, chart=${String(chart4.aiUsable)})`);
  assert(snap4.isLive === chart4.feedStatus.isLive, `match: isLive identical (snap=${String(snap4.isLive)}, chart=${String(chart4.feedStatus.isLive)})`);

  // ── 5. No simulator row ever appears as a setup ───────────────────────────
  // eslint-disable-next-line no-console
  console.log(`\n5) Never-simulator — core scan keeps ONLY dataStatus==="live" rows`);
  // 5a. Core invariant: whatever the live providers serve, EVERY returned
  // opportunity is dataStatus "live", and the slice only ever holds live rows.
  const scan5 = await scanCoreOpportunities([...CORE_OVERVIEW_SYMBOLS], [M15], 10);
  assert(
    scan5.opportunities.every((o) => o.dataStatus === "live"),
    `nosim: every returned opportunity is dataStatus "live" (statuses=${JSON.stringify(scan5.opportunities.map((o) => o.dataStatus))})`,
  );
  assert(
    scan5.opportunities.length === Math.min(scan5.liveRows, 10),
    `nosim: setups slice holds only live rows (setups=${scan5.opportunities.length}, liveRows=${scan5.liveRows})`,
  );

  // 5b. Active-drop proof — a nonsense ticker is served by NO provider
  // (mt5_broker has no push; the real chain returns empty), so it can NEVER
  // produce a confirmed-live row. The raw single-scoring path may still emit a
  // non-live (simulator/awaiting/history-only) row for it; scanCoreOpportunities
  // MUST drop it. Deterministic regardless of which API keys this env carries.
  const rawNoFeed = await scanSymbolTimeframe(NO_FEED_A, M15).catch(() => null);
  if (rawNoFeed) {
    // eslint-disable-next-line no-console
    console.log(`   raw single-path row for ${NO_FEED_A}: dataStatus="${rawNoFeed.dataStatus}" (must be dropped)`);
    assert(rawNoFeed.dataStatus !== "live", `nosim: no-feed raw row is non-live (got ${rawNoFeed.dataStatus})`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`   raw single-path row for ${NO_FEED_A}: none (unscorable — nothing to leak)`);
  }
  const dropScan = await scanCoreOpportunities([NO_FEED_A, NO_FEED_B], [M15], 10);
  assert(dropScan.liveRows === 0, `nosim: no-feed symbols yield zero live rows (got ${dropScan.liveRows})`);
  assert(dropScan.opportunities.length === 0, `nosim: non-live/empty rows are dropped before reaching Ruby (got ${dropScan.opportunities.length})`);

  // 5c. The shared overview path enforces the SAME invariant.
  __resetMarketOverviewCacheForTest();
  const ov5 = await getMarketOverview({ symbols: [NO_FEED_A, NO_FEED_B], force: true });
  assert(
    ov5.setups.opportunities.every((o) => o.dataStatus === "live"),
    `nosim: overview setups are all live (statuses=${JSON.stringify(ov5.setups.opportunities.map((o) => o.dataStatus))})`,
  );

  // Restore a clean cache state for any subsequent in-process consumer.
  __resetMarketOverviewCacheForTest();

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "rubyMarketIntelligenceUnifiedTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => {
      process.exit(r.failures > 0 ? 1 : 0);
    },
    (err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    },
  );
}
