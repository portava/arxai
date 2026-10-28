// Trade-management snapshot truth (GET /trade-management/:id/snapshot, the
// Live Trades card). The snapshot must describe what was actually observed:
//
//   - with no quote for the symbol, Current / P&L / R / Health are NOT
//     measured, so they are null with a plain-English reason — never the entry
//     price, $0.00 and 0.00R shown as if the trade were flat;
//   - with a quote, the snapshot names the quote's timestamp.
//
// The market-data accessor is the only stub; evaluateTrade is the real code.
//
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Trade } from "@workspace/db";

type Quote = { symbol: string; timestamp: string; last?: number; bid?: number; ask?: number };
let nextQuote: Quote = { symbol: "EURUSD", timestamp: "2026-10-28T09:00:00.000Z" };
const realData = await import("../../data/dataManager.js");
mock.module("../../data/dataManager.js", {
  namedExports: {
    ...realData,
    getLatestQuote: async (symbol: string): Promise<Quote> => ({ ...nextQuote, symbol }),
  },
});

const { evaluateTrade } = await import("../tradeManager.js");

function trade(over: Partial<Trade> = {}): Trade {
  return {
    id: 7, userId: null, symbol: "EURUSD", direction: "BUY", lot: 1,
    entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, strategy: "qa", confidence: 70,
    status: "OPEN", mode: "DEMO", pnl: null, pnlStatus: null, dataQualityFlag: null,
    reportedEaVersion: null, closedAt: null, createdAt: new Date(Date.now() - 30 * 60_000),
    ...over,
  };
}

test("no quote: Current, P&L, R and Health are unavailable, not entry / $0.00 / 0.00R", async () => {
  nextQuote = { symbol: "EURUSD", timestamp: new Date().toISOString() }; // router had no quote
  const snap = await evaluateTrade(trade());
  assert.equal(snap.currentPrice, null, "currentPrice must not fall back to the entry price");
  assert.equal(snap.floatingPnl, null, "floatingPnl must not read $0.00 without a price");
  assert.equal(snap.rMultiple, null, "rMultiple must not read 0.00R without a price");
  assert.equal(snap.health, null, "no health score can be computed without a price");
  assert.equal(snap.quoteAt, null, "no quote timestamp when there is no quote");
  assert.match(snap.priceUnavailableReason ?? "", /no current quote for EURUSD/i);
  assert.match(snap.primarySuggestion, /no current quote/i);
  assert.equal(snap.invalidated, false);
  for (const s of Object.values(snap.suggestions)) {
    assert.equal(s.recommended, false, "no management action can be recommended without a price");
  }
});

test("non-finite or non-positive last is treated as no quote", async () => {
  for (const last of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    nextQuote = { symbol: "EURUSD", timestamp: "2026-10-28T09:00:00.000Z", last };
    const snap = await evaluateTrade(trade());
    assert.equal(snap.currentPrice, null, `last=${last} is not a price`);
    assert.equal(snap.floatingPnl, null);
  }
});

test("with a quote: measured values carry the quote timestamp", async () => {
  nextQuote = { symbol: "EURUSD", timestamp: "2026-10-28T09:00:00.000Z", last: 1.105 };
  const snap = await evaluateTrade(trade());
  assert.equal(snap.currentPrice, 1.105);
  assert.equal(snap.quoteAt, "2026-10-28T09:00:00.000Z");
  assert.equal(snap.priceUnavailableReason, null);
  assert.ok(snap.rMultiple != null && Math.abs(snap.rMultiple - 0.5) < 1e-9);
  assert.ok(snap.health != null && typeof snap.health.score === "number");
});
