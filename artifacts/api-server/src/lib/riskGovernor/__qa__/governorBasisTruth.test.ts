// Risk Governor (PAPER) — round-3 review, group r2-governor: every refusal
// names the basis it read, and no rule reads a figure that no basis has.
//
//   - widening a stop (MODIFY) while the equity the caps are valued on is 0 or
//     below is refused even when an amount cap is set: a percent of that
//     equity allows no risk, the same as for a new trade (the OPEN path);
//
// Pure: the evaluator runs over hand-built contexts.
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/governorBasisTruth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePreTradeRisk, resolveEffectiveLimits, type RiskContext, type TradeIntent,
} from "../preTrade.js";

const NOW = new Date("2026-10-23T12:00:00Z");
const FX = { contractSize: 100_000, quoteToAccountFx: 1, volumeStep: 0.01, minVolume: 0.01, maxVolume: 50, source: "FX_STANDARD_LOT" };
const USER = {
  maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null as number | null, maxDailyLossPercent: 3, maxDailyLossAmount: null,
  maxOpenTrades: 3, maxPositionSize: null, blockAfterDailyLossHit: true, requireStopLoss: true,
};

function ctxOf(over: Partial<RiskContext> = {}, user: Partial<typeof USER> = {}): RiskContext {
  return {
    now: NOW,
    limits: resolveEffectiveLimits({ userSettings: { ...USER, ...user } }),
    account: { equity: 10_000, freeMargin: 9_000, leverage: 100, currency: "USD", source: "paper_account:3" },
    instruments: { EURUSD: FX },
    quote: { bid: 1.1, ask: 1.1001, at: new Date(NOW.getTime() - 2_000), source: "test" },
    positions: [],
    inFlight: [],
    broker: { status: "CONNECTED", lastSeenAt: NOW, detail: "internal paper simulator" },
    daily: { realizedPnl: 0, floatingPnl: 0 },
    ...over,
  };
}

function intentOf(over: Partial<TradeIntent> = {}): TradeIntent {
  return {
    userId: 1, venue: "PAPER", origin: "manual", action: "OPEN",
    symbol: "EURUSD", side: "BUY", lots: 0.01, stopLoss: 1.0951, takeProfit: 1.11,
    ...over,
  };
}

// ── Finding 2: MODIFY widen with equity at or below 0 ────────────────────────
// Open BUY 0.01 EURUSD at 1.1000 with its stop at 1.0951; the trader widens it
// to 1.0901 (99 pips, $9.90 at risk, under a $100 amount cap).
const WIDEN = intentOf({ action: "MODIFY", stopLoss: 1.0901, takeProfit: null, position: { entryPrice: 1.1, stopLoss: 1.0951 } });
const TIGHTEN = intentOf({ action: "MODIFY", stopLoss: 1.098, takeProfit: null, position: { entryPrice: 1.1, stopLoss: 1.0951 } });
const NON_POS_PAPER = { equity: -200, bookedEquity: 9_800, freeMargin: -200, leverage: 100, currency: "USD", source: "paper_account:3" };

test("MODIFY: widening a stop with the paper risk-count equity at or below 0 is refused even with an amount cap; the refusal names both figures", () => {
  const ctx = ctxOf({ account: NON_POS_PAPER }, { maxRiskPerTradeAmount: 100 });
  // The same order as an OPEN is refused for the same reason.
  const open = evaluatePreTradeRisk(intentOf({ stopLoss: 1.0901 }), ctx).rules.find((r) => r.rule === "per_trade_loss_limit")!;
  assert.equal(open.outcome, "BLOCK");
  const d = evaluatePreTradeRisk(WIDEN, ctx);
  assert.equal(d.decision, "BLOCK", "a $9.90 widen passed on the $100 amount cap alone");
  assert.deepEqual(d.blockedBy, ["per_trade_loss_limit"]);
  const r = d.rules.find((x) => x.rule === "per_trade_loss_limit")!;
  assert.match(r.reason!, /^The paper risk count puts account equity at -200, at or below zero \(the paper account shows 9800 booked/);
  assert.match(r.reason!, /so your 1% per-trade limit leaves no room to widen the stop\. Closing or tightening is allowed\.$/);
  assert.doesNotMatch(r.reason!, /cannot be checked|unknown/);
  // Tightening and closing stay open.
  assert.equal(evaluatePreTradeRisk(TIGHTEN, ctx).decision, "ALLOW");
  assert.equal(evaluatePreTradeRisk(intentOf({ action: "CLOSE" }), ctx).decision, "ALLOW");
});

test("MODIFY: with no amount cap the percent cap at equity <= 0 is used up, not 'cannot be checked'; a positive equity still passes within the cap", () => {
  const d = evaluatePreTradeRisk(WIDEN, ctxOf({ account: { ...NON_POS_PAPER, bookedEquity: undefined } }));
  const r = d.rules.find((x) => x.rule === "per_trade_loss_limit")!;
  assert.equal(r.outcome, "BLOCK");
  assert.equal(r.reason, "Account equity is -200, at or below zero, so your 1% per-trade limit leaves no room to widen the stop. Closing or tightening is allowed.");
  const ok = evaluatePreTradeRisk(WIDEN, ctxOf({}, { maxRiskPerTradeAmount: 100 }));
  assert.equal(ok.decision, "ALLOW", ok.primaryReason ?? "");
  assert.equal(ok.rules.find((x) => x.rule === "per_trade_loss_limit")!.measured?.["cap"], 100);
});
