// QA — Thin-feed markets can never show a live-grade score after a real scan
// (Task #792).
//
// This is an INTEGRATION-lane test: it exercises the REAL scanner read path
//   scanSymbolTimeframe → analyzeViaRouter → routeCandles → mt5Provider
// against the live in-memory broker seam (no module mocks, no fabricated
// router). It proves the sufficiency downgrade at the heart of scanner honesty:
// a LIVE_FEED symbol whose feed is too thin to analyse (fewer than the minimum
// closed bars) must be forced to dataSource === "AWAITING_FEED" +
// dataStatus === "no_data" so its feed-derived execution-readiness can never
// present a full-confidence live score over unanalysable data.
//
// Contrast case: the SAME symbol with a sufficient fresh feed stays LIVE_FEED /
// "live" — proving the downgrade is feed-depth-driven, not a blanket demotion.
//
// `export {}` scopes this file as a module (avoids the scripts/__qa__ global
// duplicate-identifier collision documented in memory).
export {};

import { test } from "node:test";
import assert from "node:assert/strict";

import { MIN_SUFFICIENT_CLOSED_BARS } from "@workspace/domain/market";

import {
  updateCandlesFromMT5,
  __resetMt5ProviderStore,
} from "../data/providers/mt5Provider.js";
import { scanSymbolTimeframe } from "../marketScanner.js";
import type { Candle } from "../data/types.js";

const M5_MS = 5 * 60_000;

// Build `n` fresh, interval-aligned M5 bars whose newest bar opens on the
// current expected interval boundary. With the mt5_broker open-time basis this
// keeps the trailing-interval gap at 0 (→ "clean" → feed verdict LIVE), so the
// scanner row stays LIVE_FEED until the closed-bar sufficiency check runs —
// otherwise a stale feed would demote LIVE_FEED → STALE_FEED *before* the
// downgrade under test could ever fire.
function freshM5Bars(n: number, now = Date.now()): Candle[] {
  const latestOpen = Math.floor(now / M5_MS) * M5_MS;
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

test("thin LIVE feed is forced to AWAITING_FEED/no_data after a real scan", async () => {
  __resetMt5ProviderStore();
  // Push a FRESH but THIN feed: fewer closed bars than the sufficiency floor.
  // The in-memory mt5Provider serves any non-empty series, so this wins the
  // router as mt5_broker / LIVE_FEED — yet it is too thin to analyse.
  const thin = MIN_SUFFICIENT_CLOSED_BARS - 1;
  assert.ok(thin >= 1, "need at least one bar so data_available passes");
  updateCandlesFromMT5("EURUSD", freshM5Bars(thin), "M5");

  const op = await scanSymbolTimeframe("EURUSD", "M5");
  assert.ok(op != null, "scanner must return a row for an approved symbol");
  // The honesty contract: a feed too thin to analyse can never stay live-grade.
  assert.equal(op.dataSource, "AWAITING_FEED");
  assert.equal(op.dataStatus, "no_data");
  // Display-derived gating must stay locked on the downgraded row.
  assert.equal(op.selectable, false);
  assert.equal(op.tradeable, false);
});

test("a sufficient fresh LIVE feed stays LIVE_FEED/live (downgrade is feed-depth-driven)", async () => {
  __resetMt5ProviderStore();
  // Same symbol, same provider seam — but enough fresh closed bars to analyse.
  updateCandlesFromMT5("EURUSD", freshM5Bars(120), "M5");

  const op = await scanSymbolTimeframe("EURUSD", "M5");
  assert.ok(op != null, "scanner must return a row for an approved symbol");
  assert.equal(op.dataSource, "LIVE_FEED");
  assert.equal(op.dataStatus, "live");
});
