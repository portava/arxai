// DATA-SUFFICIENCY TRUTH (Phase 2) — live ENTRY gate + backtest reliability.
//
// Phase 1 (marketDataSufficiency.test.ts) locks the PURE engine. This suite
// locks the two PHASE-2 compositions that ride on top of it:
//
//   PART A — the live-ENTRY gate adapter (`evaluateEntryDataSufficiency`). It is
//   BLOCK-ONLY, NEW-ENTRY only, FAIL-CLOSED, and composes the shared engine
//   THROUGH the chart-state adapter so it can never grant a trade or drift from
//   the scanner/Ruby/chart verdict. Driven via the injectable `deps.buildState`
//   seam so it needs NO provider IO and NO database.
//
//   PART B — the backtest reliability badge (`evaluateBacktestDataReliability` +
//   `backtestClosedCandleCount`). DISPLAY-only depth/approval verdict; it can
//   describe reliability but never block a run or grant a setup.
//
// The cross-cutting safety property both parts share with Phase 1: the verdict
// can only BLOCK / DOWNGRADE, NEVER grant. There is no execution-permission
// field anywhere in the returned shapes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateEntryDataSufficiency,
  LIVE_ENTRY_SUFFICIENCY_TIMEFRAME,
  type EntrySufficiencyDeps,
} from "../live/entryDataSufficiency.js";
import type { ChartIntelligenceState } from "../data/chart/chartIntelligence.js";
import {
  backtestClosedCandleCount,
  evaluateBacktestDataReliability,
} from "../backtest/backtestDataReliability.js";

const APPROVED = "EURUSD"; // a known approved ARX focus market
const UNAPPROVED = "ZZZ_NOT_A_MARKET";

// Minimal chart-state stub exposing ONLY the fields the sufficiency adapter
// reads (symbol, aiUsable, stale, truthState.quality, candleStats.barsAnalyzed).
// `quality` defaults to "clean" so the freshness derivation never enters its
// "delayed" branch (which would consult the Deriv tick cache / provider IO).
function chartState(opts: {
  symbol?: string;
  aiUsable: boolean;
  stale: boolean;
  quality?: string;
  barsAnalyzed: number;
}): ChartIntelligenceState {
  return {
    symbol: opts.symbol ?? APPROVED,
    aiUsable: opts.aiUsable,
    stale: opts.stale,
    truthState: { quality: opts.quality ?? "clean" },
    candleStats: { barsAnalyzed: opts.barsAnalyzed },
  } as unknown as ChartIntelligenceState;
}

/** A `deps` whose buildState returns a fixed stub state. */
function stubDeps(state: ChartIntelligenceState): EntrySufficiencyDeps {
  return { buildState: async () => state };
}

// ── PART A — live ENTRY gate ────────────────────────────────────────────────

test("ENTRY: approved + live feed + enough closed bars => NOT blocked", async () => {
  const r = await evaluateEntryDataSufficiency(
    APPROVED,
    stubDeps(chartState({ aiUsable: true, stale: false, barsAnalyzed: 50 })),
  );
  assert.equal(r.status, "sufficient");
  assert.equal(r.shouldBlock, false);
  assert.equal(r.freshnessVerdict, "LIVE");
  assert.equal(r.timeframe, LIVE_ENTRY_SUFFICIENCY_TIMEFRAME);
});

test("ENTRY: approved + live feed but too few closed bars => BLOCKED (honest count)", async () => {
  const r = await evaluateEntryDataSufficiency(
    APPROVED,
    stubDeps(chartState({ aiUsable: true, stale: false, barsAnalyzed: 3 })),
  );
  assert.equal(r.status, "insufficient");
  assert.equal(r.shouldBlock, true);
  assert.equal(r.availableClosedCandles, 3);
  assert.match(r.humanReason, /3/); // surfaces the real shortfall, never fabricates
});

test("ENTRY: approved + enough bars but feed NOT live (awaiting) => BLOCKED (partial)", async () => {
  const r = await evaluateEntryDataSufficiency(
    APPROVED,
    stubDeps(chartState({ aiUsable: false, stale: true, barsAnalyzed: 50 })),
  );
  assert.equal(r.freshnessVerdict, "AWAITING");
  assert.equal(r.status, "partial");
  assert.equal(r.shouldBlock, true);
});

test("ENTRY: unapproved market => BLOCKED (engine blocks, outranks everything)", async () => {
  const r = await evaluateEntryDataSufficiency(
    UNAPPROVED,
    stubDeps(chartState({ symbol: UNAPPROVED, aiUsable: true, stale: false, barsAnalyzed: 999 })),
  );
  assert.equal(r.status, "blocked");
  assert.equal(r.shouldBlock, true);
});

test("ENTRY: FAIL-CLOSED — buildState throwing blocks the entry (never lets it through)", async () => {
  const r = await evaluateEntryDataSufficiency(APPROVED, {
    buildState: async () => {
      throw new Error("provider down");
    },
  });
  assert.equal(r.shouldBlock, true);
  assert.equal(r.status, "insufficient");
  assert.equal(r.freshnessVerdict, "AWAITING");
  assert.equal(r.availableClosedCandles, 0);
  assert.match(r.humanReason, /block/i);
});

test("ENTRY: BLOCK-ONLY — verdict exposes a refusal flag, never an execution-permission field", async () => {
  const r = await evaluateEntryDataSufficiency(
    APPROVED,
    stubDeps(chartState({ aiUsable: true, stale: false, barsAnalyzed: 50 })),
  );
  const keys = Object.keys(r);
  assert.ok(keys.includes("shouldBlock"));
  for (const forbidden of [
    "shouldAllow", "allow", "tradeExecutionAllowed", "allowOrderExecution",
    "commandExecutionAllowed", "allowExecution", "allowTrade", "canTrade",
    "canShowTradeSetup",
  ]) {
    assert.ok(!keys.includes(forbidden), `entry verdict must not expose ${forbidden}`);
  }
});

test("ENTRY: LOCKSTEP — identical state yields the identical verdict (preflight === dispatch)", async () => {
  const state = chartState({ aiUsable: true, stale: false, barsAnalyzed: 4 });
  const preflight = await evaluateEntryDataSufficiency(APPROVED, stubDeps(state));
  const dispatch = await evaluateEntryDataSufficiency(APPROVED, stubDeps(state));
  assert.deepEqual(preflight, dispatch);
  assert.equal(preflight.shouldBlock, true); // 4 < MIN(5)
});

test("ENTRY: probes the shortest real MT5 timeframe (most conservative freshness)", () => {
  assert.equal(LIVE_ENTRY_SUFFICIENCY_TIMEFRAME, "M1");
});

// ── PART B — backtest reliability badge (DISPLAY only) ───────────────────────

test("BACKTEST: exact closed-candle count from the run window", () => {
  // generator anchors endTime = start + (n-1)·tfMs, so (end-start)/tfMs + 1 = n.
  const tfMs = 5 * 60_000; // M5
  const start = 1_000_000;
  const end = start + 499 * tfMs; // 500-bar run
  assert.equal(backtestClosedCandleCount(tfMs, start, end), 500);
  assert.equal(backtestClosedCandleCount(tfMs, start, start), 1); // single bar
  assert.equal(backtestClosedCandleCount(0, start, end), 0); // guard: bad tf
});

test("BACKTEST: deep history => reliable badge", () => {
  const dr = evaluateBacktestDataReliability({
    symbol: APPROVED, timeframe: "M5", availableClosedCandles: 500,
  });
  assert.equal(dr.status, "sufficient");
  assert.equal(dr.reliable, true);
  assert.equal(dr.availableClosedCandles, 500);
});

test("BACKTEST: thin history => NOT reliable badge (display downgrade, never a block)", () => {
  const dr = evaluateBacktestDataReliability({
    symbol: APPROVED, timeframe: "M5", availableClosedCandles: 3,
  });
  assert.equal(dr.status, "insufficient");
  assert.equal(dr.reliable, false);
  assert.equal(dr.minimumRequiredCandles, 5);
});

test("BACKTEST: unapproved market => blocked status, NOT reliable", () => {
  const dr = evaluateBacktestDataReliability({
    symbol: UNAPPROVED, timeframe: "M5", availableClosedCandles: 999,
  });
  assert.equal(dr.status, "blocked");
  assert.equal(dr.reliable, false);
});

test("BACKTEST: badge shape exposes no execution-permission field (display only)", () => {
  const dr = evaluateBacktestDataReliability({
    symbol: APPROVED, timeframe: "M5", availableClosedCandles: 500,
  });
  const keys = Object.keys(dr);
  for (const forbidden of [
    "canShowTradeSetup", "shouldBlock", "allowTrade", "canTrade", "tradeExecutionAllowed",
  ]) {
    assert.ok(!keys.includes(forbidden), `backtest badge must not expose ${forbidden}`);
  }
});
