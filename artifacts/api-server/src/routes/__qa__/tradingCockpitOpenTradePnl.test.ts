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

const { priceOpenTrade } = await import("../tradingCockpit.js");

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
