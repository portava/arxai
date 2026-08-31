// Trading-cockpit open-trade P&L honesty.
//
// paper_orders.profit_loss is written ONLY at close; for OPEN rows it is the
// schema default 0. The cockpit used to render that column for open trades,
// so a position deep underwater read as flat, in neutral color, for its
// entire open life. The summary route now prices each open row against a
// fresh DD quote at read time via priceOpenTrade(); this suite locks its
// contract:
//
//   * a real, fresh quote yields a signed dollar value (never the DB 0)
//   * every degraded input (no snapshot / MISSING / non-REAL source / stale
//     quote) yields a typed null WITH a reason — never a confident number
//
// Run: node --import tsx --test src/routes/__qa__/tradingCockpitOpenTradePnl.test.ts

// The route module reaches @workspace/db at import time; the placeholder keeps
// the lane offline (nothing here opens a connection).
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";

const { priceOpenTrade, summarizeTodayPerformance, TODAY_PERFORMANCE_READ_FAILED } = await import("../tradingCockpit.js");

const NOW = Date.parse("2026-08-30T12:00:00.000Z");

function snap(over: Record<string, unknown> = {}) {
  return {
    mid: 100,
    source: "REAL",
    timestamp: new Date(NOW - 1_000).toISOString(), // 1s old — fresh
    dataQuality: { status: "GOOD", latencyMs: 10, candlesAvailable: 100, warnings: [] as string[] },
    ...over,
  } as Parameters<typeof priceOpenTrade>[1];
}

test("an underwater BUY prices NEGATIVE from the quote — not the DB-default 0", () => {
  // BUY 0.01 lot @ 100, mid now 90 → 1 * (90-100) * 0.01 * 100 = -10.00
  const r = priceOpenTrade({ direction: "BUY", lotSize: 0.01, entryPrice: 100 }, snap({ mid: 90 }), NOW);
  assert.equal(r.value, -10);
  assert.equal(r.reason, null);
  assert.equal(r.quality, "GOOD");
});

test("a SELL gains when price falls (sign follows direction)", () => {
  const r = priceOpenTrade({ direction: "SELL", lotSize: 0.01, entryPrice: 100 }, snap({ mid: 90 }), NOW);
  assert.equal(r.value, 10);
});

test("no snapshot at all → typed null with a reason, never a number", () => {
  const r = priceOpenTrade({ direction: "BUY", lotSize: 0.01, entryPrice: 100 }, null, NOW);
  assert.equal(r.value, null);
  assert.ok(r.reason && r.reason.length > 0, "a null value must carry a reason");
});

test("DD's honest-empty snapshot (NaN mid, MISSING) → null and DD's own reason", () => {
  const why = "No real market-data provider served this request.";
  const r = priceOpenTrade(
    { direction: "BUY", lotSize: 0.01, entryPrice: 100 },
    snap({ mid: Number.NaN, source: "FALLBACK", dataQuality: { status: "MISSING", latencyMs: 0, candlesAvailable: 0, warnings: [why] } }),
    NOW,
  );
  assert.equal(r.value, null);
  assert.equal(r.reason, why);
});

test("a finite mid from a non-REAL source is refused — fabricated data never prices a position", () => {
  const r = priceOpenTrade({ direction: "BUY", lotSize: 0.01, entryPrice: 100 }, snap({ source: "FALLBACK" }), NOW);
  assert.equal(r.value, null);
  assert.match(r.reason ?? "", /FALLBACK/);
});

test("a stale REAL quote is refused with its age in the reason", () => {
  const r = priceOpenTrade(
    { direction: "BUY", lotSize: 0.01, entryPrice: 100 },
    snap({ timestamp: new Date(NOW - 5 * 60_000).toISOString() }),
    NOW,
  );
  assert.equal(r.value, null);
  assert.match(r.reason ?? "", /stale|old/);
});

test("a fresh REAL quote at the entry prices an honest 0 (a real flat, with no reason)", () => {
  const r = priceOpenTrade({ direction: "BUY", lotSize: 0.01, entryPrice: 100 }, snap({ mid: 100 }), NOW);
  assert.equal(r.value, 0);
  assert.equal(r.reason, null);
  assert.ok(r.asOf, "a priced value carries the quote timestamp");
});

test("values are rounded to cents, not floated raw", () => {
  const r = priceOpenTrade({ direction: "BUY", lotSize: 0.01, entryPrice: 100 }, snap({ mid: 100.123456 }), NOW);
  assert.equal(r.value, Number((1 * (100.123456 - 100) * 0.01 * 100).toFixed(2)));
});

test("every priced (and unpriced) result declares its unit as SIM_POINTS — never implied currency", () => {
  // The formula dir × Δprice × lot × 100 is symbol-blind and maps to no real
  // currency amount, so the payload must carry the honest unit for the UI.
  const priced = priceOpenTrade({ direction: "BUY", lotSize: 0.01, entryPrice: 100 }, snap({ mid: 90 }), NOW);
  assert.equal(priced.unit, "SIM_POINTS");
  const unpriced = priceOpenTrade({ direction: "BUY", lotSize: 0.01, entryPrice: 100 }, null, NOW);
  assert.equal(unpriced.unit, "SIM_POINTS");
});

// ── Today's performance: failure is typed, never a confident flat day ───────

test("a failed paper-orders read yields typed nulls + reason — NOT the all-zero NO_TRADES shape", () => {
  const f = TODAY_PERFORMANCE_READ_FAILED;
  assert.equal(f.readFailed, true);
  assert.ok(f.readFailedReason && f.readFailedReason.length > 0, "failure must carry a reason");
  // Every count is null (unknown), never 0 (measured flat).
  assert.equal(f.totalTrades, null);
  assert.equal(f.wins, null);
  assert.equal(f.losses, null);
  assert.equal(f.breakEven, null);
  assert.equal(f.netPnl, null);
  assert.equal(f.winRate, null);
  // And the rating must not claim a measured empty day.
  assert.notEqual(f.dayRating, "NO_TRADES");
  assert.equal(f.dayRating, "UNKNOWN");
});

test("a genuinely-empty day is a real NO_TRADES zero — distinct from the failed read", () => {
  const t = summarizeTodayPerformance([]);
  assert.equal(t.readFailed, false);
  assert.equal(t.readFailedReason, null);
  assert.equal(t.totalTrades, 0);
  assert.equal(t.netPnl, 0);
  assert.equal(t.dayRating, "NO_TRADES");
});

test("aggregates sum correctly and count synthetic-model-settled closes (non-EE rows)", () => {
  const t = summarizeTodayPerformance([
    { profitLoss: 10, strategyId: null },                          // Build Q → synthetic-settled
    { profitLoss: -4, strategyId: "some_plan" },                   // Build Q → synthetic-settled
    { profitLoss: 0, strategyId: "build_ee_paper_execution" },     // EE → DD market data
  ]);
  assert.equal(t.totalTrades, 3);
  assert.equal(t.wins, 1);
  assert.equal(t.losses, 1);
  assert.equal(t.breakEven, 1);
  assert.equal(t.netPnl, 6);
  assert.equal(t.winRate, 33);
  assert.equal(t.dayRating, "GREEN");
  assert.equal(t.pnlUnit, "SIM_POINTS");
  // 2 of 3 closes were settled by the seeded deterministic candle generator,
  // not the market — the UI badges the total with this count.
  assert.equal(t.syntheticPricedTrades, 2);
});

// ── Fill model: the assumption travels with the number ─────────────────────
// Both settlers (paperExecutionMonitor and paperTrading's mark-to-market) close
// SL/TP at EXACTLY the level, even when the observed price has already run past
// it. That is an optimistic bound, not a measured fill, so the totals panel may
// not present it bare — the assumption must ship inside the payload.

test("closed totals declare the stop/target fill assumption — gaps are not modelled", () => {
  const t = summarizeTodayPerformance([{ profitLoss: 25, strategyId: "build_ee_paper_execution" }]);
  assert.equal(t.fillModel, "STOP_AND_TARGET_FILL_AT_LEVEL_NO_GAP_OR_SLIPPAGE");
  assert.ok(t.fillModelNote && t.fillModelNote.length > 0, "the fill model must carry renderable prose");
  assert.match(t.fillModelNote, /gap/i, "the note must name the unmodelled gap risk");
});

test("the fill assumption is a model property, so it survives a failed read", () => {
  // Unlike the counts, this is not a measurement — a DB outage does not make
  // the fill model unknown, and dropping it would let a later render of the
  // failed shape omit the caveat.
  assert.equal(TODAY_PERFORMANCE_READ_FAILED.fillModel, "STOP_AND_TARGET_FILL_AT_LEVEL_NO_GAP_OR_SLIPPAGE");
  assert.ok((TODAY_PERFORMANCE_READ_FAILED.fillModelNote ?? "").length > 0);
});
