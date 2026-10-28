// Trade-management snapshot truth (GET /trade-management/:id/snapshot, the
// Live Trades card). The snapshot must describe what was actually observed:
//
//   - with no quote for the symbol, Current / P&L / R / Health are NOT
//     measured, so they are null with a plain-English reason — never the entry
//     price, $0.00 and 0.00R shown as if the trade were flat;
//   - with a quote, the snapshot names the quote's timestamp;
//   - floating P&L is contract-size aware (lib/mt5/contractSize.ts, the rule
//     realized P/L and paper P&L use): 1.00 lot EURUSD +10 pips is ~$100, not
//     the old flat x100 figure of $0.10; when the contract size or FX factor
//     cannot be established the P&L is null with a reason.
//
// The market-data accessor and the broker-spec DB read are the only stubs;
// evaluateTrade and the contract-size math are the real code.
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

type Spec = { contractSize: number | null; profitCurrency: string | null } | null;
const brokerSpecs = new Map<string, Spec>();
let specReadFails = false;
const realContract = await import("../../mt5/contractSize.js");
mock.module("../../mt5/contractSize.js", {
  namedExports: {
    ...realContract,
    resolveContractSize: async (userId: number, symbol: string) => {
      if (specReadFails) throw new Error("db down");
      const row = brokerSpecs.get(`${userId}:${symbol}`) ?? null;
      return realContract.decideContractSize({
        symbol,
        brokerContractSize: row?.contractSize ?? null,
        brokerProfitCurrency: row?.profitCurrency ?? null,
      });
    },
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

test("EURUSD 1.00 lot +10 pips is ~$100 (contract size 100,000), not the flat x100 $0.10", async () => {
  nextQuote = { symbol: "EURUSD", timestamp: "2026-10-28T09:00:00.000Z", last: 1.101 };
  const snap = await evaluateTrade(trade({ entryPrice: 1.1, lot: 1, direction: "BUY" }));
  assert.ok(snap.floatingPnl != null);
  assert.ok(Math.abs(snap.floatingPnl - 100) < 0.01, `expected ~100, got ${snap.floatingPnl}`);
  assert.equal(snap.pnlUnavailableReason, null);
});

test("SELL loss is negative and USDJPY P&L is converted from JPY to USD", async () => {
  nextQuote = { symbol: "EURUSD", timestamp: "2026-10-28T09:00:00.000Z", last: 1.101 };
  const sell = await evaluateTrade(trade({ entryPrice: 1.1, lot: 0.5, direction: "SELL", stopLoss: 1.11 }));
  assert.ok(sell.floatingPnl != null && Math.abs(sell.floatingPnl + 50) < 0.01, `got ${sell.floatingPnl}`);

  nextQuote = { symbol: "USDJPY", timestamp: "2026-10-28T09:00:00.000Z", last: 150.5 };
  const jpy = await evaluateTrade(trade({ symbol: "USDJPY", entryPrice: 150, stopLoss: 149, takeProfit: 152, lot: 1 }));
  // 0.5 JPY x 100,000 = 50,000 JPY ~= $332.23 at 150.5 — not 50,000 "dollars".
  assert.ok(jpy.floatingPnl != null && Math.abs(jpy.floatingPnl - 50_000 / 150.5) < 0.01, `got ${jpy.floatingPnl}`);
});

test("non-FX symbol with no broker spec: P&L unavailable with a reason, price still shown", async () => {
  nextQuote = { symbol: "XAUUSD", timestamp: "2026-10-28T09:00:00.000Z", last: 2010 };
  const snap = await evaluateTrade(trade({ symbol: "XAUUSD", entryPrice: 2000, stopLoss: 1990, takeProfit: 2030, lot: 1 }));
  assert.equal(snap.currentPrice, 2010);
  assert.equal(snap.floatingPnl, null, "gold must not be sized as a guess");
  assert.match(snap.pnlUnavailableReason ?? "", /contract size for XAUUSD is unknown/);
  assert.ok(snap.rMultiple != null && Math.abs(snap.rMultiple - 1) < 1e-9, "R does not need a contract size");
});

test("broker spec is used when the trade has an owner; a failed spec read withholds P&L", async () => {
  brokerSpecs.set("42:XAUUSD", { contractSize: 100, profitCurrency: "USD" });
  nextQuote = { symbol: "XAUUSD", timestamp: "2026-10-28T09:00:00.000Z", last: 2010 };
  const gold = trade({ userId: 42, symbol: "XAUUSD", entryPrice: 2000, stopLoss: 1990, takeProfit: 2030, lot: 1 });
  const snap = await evaluateTrade(gold);
  assert.ok(snap.floatingPnl != null && Math.abs(snap.floatingPnl - 1000) < 0.01, `got ${snap.floatingPnl}`);

  specReadFails = true;
  try {
    const failed = await evaluateTrade(gold);
    assert.equal(failed.floatingPnl, null);
    assert.match(failed.pnlUnavailableReason ?? "", /could not read the broker symbol spec for XAUUSD/i);
  } finally {
    specReadFails = false;
  }
});

test("manual close: refused with no quote; sized P&L booked; unsized P&L recorded as UNKNOWN", async () => {
  const { paperCloseOutcome } = await import("../tradeManager.js");

  nextQuote = { symbol: "EURUSD", timestamp: "2026-10-28T09:00:00.000Z" };
  const eur = trade();
  const noQuote = paperCloseOutcome(eur, await evaluateTrade(eur));
  assert.equal(noQuote.ok, false, "a close with no quote would book the entry price and $0.00");

  nextQuote = { symbol: "EURUSD", timestamp: "2026-10-28T09:00:00.000Z", last: 1.101 };
  const sized = paperCloseOutcome(eur, await evaluateTrade(eur));
  assert.ok(sized.ok);
  assert.equal(sized.status, "CLOSED_WIN");
  assert.equal(sized.pnl, 100);
  assert.equal(sized.pnlStatus, null);
  assert.match(sized.resultText, /\$100\.00/);

  nextQuote = { symbol: "XAUUSD", timestamp: "2026-10-28T09:00:00.000Z", last: 1990 };
  const gold = trade({ symbol: "XAUUSD", entryPrice: 2000, stopLoss: 1980, takeProfit: 2030 });
  const unsized = paperCloseOutcome(gold, await evaluateTrade(gold));
  assert.ok(unsized.ok);
  assert.equal(unsized.status, "CLOSED_LOSS", "win/loss follows the price move even when P&L is unsized");
  assert.equal(unsized.pnl, null, "no guessed dollar figure is stored");
  assert.equal(unsized.pnlStatus, "UNKNOWN");
  assert.equal(unsized.dataQualityFlag, "MISSING_CONTRACT_SIZE");
  assert.doesNotMatch(unsized.resultText, /\$/);
});
