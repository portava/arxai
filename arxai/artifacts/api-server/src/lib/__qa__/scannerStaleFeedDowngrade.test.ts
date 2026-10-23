// QA — A STALE live feed can never show a live-grade score after a real scan
// (Task #794).
//
// This is an INTEGRATION-lane sibling to scannerThinFeedDowngrade.test.ts. It
// exercises the SAME real scanner read path
//   scanSymbolTimeframe → analyzeViaRouter → routeCandles → mt5Provider
// against the live in-memory broker seam (no module mocks, no fabricated
// router) — but it covers the OTHER honesty branch: a feed with PLENTY of
// closed bars (well over the sufficiency floor) whose NEWEST bar is too OLD.
//
// The thin-feed test proves the closed-bar sufficiency downgrade
// (LIVE_FEED → AWAITING_FEED / "no_data"). The freshness demotion is a
// separate branch in scanSymbolTimeframe (the trailing-interval check around
// marketScanner.ts ~lines 1207-1219): when the newest bar trails the current
// bar by >= STALE_TRAILING_INTERVALS intervals, resolveSymbolFeedVerdict
// returns AWAITING and the row is demoted LIVE_FEED → STALE_FEED / "stale".
// Without this test a regression there would let a stale feed keep presenting a
// full-confidence live score over data the chart already calls stale.
//
// Contrast case: the SAME symbol with a sufficient FRESH feed stays LIVE_FEED /
// "live" — proving the demotion is freshness-driven, not a blanket downgrade.
//
// `export {}` scopes this file as a module (avoids the scripts/__qa__ global
// duplicate-identifier collision documented in memory).
export {};

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  updateCandlesFromMT5,
  __resetMt5ProviderStore,
} from "../data/providers/mt5Provider.js";
import { scanSymbolTimeframe } from "../marketScanner.js";
import { STALE_TRAILING_INTERVALS } from "../data/freshness.js";
import type { Candle } from "../data/types.js";

const M5_MS = 5 * 60_000;

// Build `n` interval-aligned M5 bars whose NEWEST bar opens `trailingIntervals`
// bar-intervals before the current expected interval boundary. With the
// mt5_broker open-time basis the trailing-interval gap equals `trailingIntervals`
// (time only moves forward between building these bars and the scan, so the gap
// can only grow — never shrink below the threshold).
function m5BarsTrailingBy(
  n: number,
  trailingIntervals: number,
  now = Date.now(),
): Candle[] {
  const latestOpen = Math.floor(now / M5_MS) * M5_MS - trailingIntervals * M5_MS;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const openMs = latestOpen - (n - 1 - i) * M5_MS;
    const t = new Date(openMs).toISOString();
    out.push({
      time: t,
      open: 1.07 + i * 0.0001,
      high: 1.0702 + i * 0.0001,
      low: 1.0699 + i * 0.0001,
      close: 1.0701 + i * 0.0001,
      volume: 100 + i,
    });
  }
  return out;
}

test("a SUFFICIENT but STALE LIVE feed is forced to STALE_FEED/stale after a real scan", async () => {
  __resetMt5ProviderStore();
  // Push a feed with plenty of closed bars (well over the sufficiency floor) so
  // the thin-feed downgrade can never fire — the ONLY thing wrong is freshness:
  // its newest bar trails the current bar by >= STALE_TRAILING_INTERVALS.
  const stale = m5BarsTrailingBy(120, STALE_TRAILING_INTERVALS);
  updateCandlesFromMT5("EURUSD", stale, "M5");

  const op = await scanSymbolTimeframe("EURUSD", "M5");
  assert.ok(op != null, "scanner must return a row for an approved symbol");
  // The honesty contract: a feed too OLD to be current can never stay live-grade.
  assert.equal(op.dataSource, "STALE_FEED");
  assert.equal(op.dataStatus, "stale");
  // Display-derived gating must stay locked on the demoted row.
  assert.equal(op.selectable, false);
  assert.equal(op.tradeable, false);
});

test("a sufficient FRESH LIVE feed stays LIVE_FEED/live (demotion is freshness-driven)", async () => {
  __resetMt5ProviderStore();
  // Same symbol, same provider seam, same bar count — but the newest bar opens
  // on the current interval boundary (trailing gap 0), so it stays live-grade.
  updateCandlesFromMT5("EURUSD", m5BarsTrailingBy(120, 0), "M5");

  const op = await scanSymbolTimeframe("EURUSD", "M5");
  assert.ok(op != null, "scanner must return a row for an approved symbol");
  assert.equal(op.dataSource, "LIVE_FEED");
  assert.equal(op.dataStatus, "live");
});
