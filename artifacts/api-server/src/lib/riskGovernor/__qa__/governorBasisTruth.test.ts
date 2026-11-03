// Risk Governor (PAPER) — round-3 review, group r2-governor: every refusal
// names the basis it read, and no rule reads a figure that no basis has.
//
//   - widening a stop (MODIFY) while the equity the caps are valued on is 0 or
//     below is refused even when an amount cap is set: a percent of that
//     equity allows no risk, the same as for a new trade (the OPEN path);
//   - the automation's daily-budget refusal and the buying-power refusal say
//     they read the paper risk count, with the booked figures beside it, when
//     the two differ (they read the same figures as the daily-loss refusal);
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
  maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null as number | null, maxDailyLossPercent: 3, maxDailyLossAmount: null as number | null,
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

// ── Finding 4: automation budget and buying power name the paper risk count ──
// Today's only close: a US30 0.1-lot 50-point loss at 1 unit per lot, booked
// −5 and counted −500 at the paper risk model.
const INDEX_DAY = {
  account: { equity: 9_500, bookedEquity: 9_995, freeMargin: 9_500, leverage: 100, currency: "USD", source: "paper_account:3" },
  daily: { realizedPnl: -500, bookedRealizedPnl: -5, floatingPnl: 0 },
};

test("automation: the 70% daily-budget refusal says it reads the paper risk count, with the booked figures beside it", () => {
  const ctx = ctxOf(INDEX_DAY, { maxDailyLossAmount: 600, maxDailyLossPercent: 50 });
  const d = evaluatePreTradeRisk(intentOf({ origin: "automation" }), ctx);
  assert.equal(d.rules.find((r) => r.rule === "daily_loss_limit")!.outcome, "PASS", "rule 7 itself passes (−500 > −600)");
  const r = d.rules.find((x) => x.rule === "trading_discipline")!;
  assert.equal(r.outcome, "BLOCK");
  assert.match(r.reason!, /^Blocked by your trading rules: 83% of today's loss budget is used \(paper risk count: today's closed trades count -500 against -5 booked, equity counts 9500 against 9995 booked; it takes the lower of the booked total and the price move × lots × 100 total of the closed paper trades, and values each open position/);
  assert.match(r.reason!, /\); automation pauses at 70%\.$/);
  // The same figures with no booked difference carry no note.
  const plain = evaluatePreTradeRisk(intentOf({ origin: "automation" }),
    ctxOf({ daily: { realizedPnl: -500, floatingPnl: 0 } }, { maxDailyLossAmount: 600, maxDailyLossPercent: 50 }));
  const pr = plain.rules.find((x) => x.rule === "trading_discipline")!;
  assert.equal(pr.reason, "Blocked by your trading rules: 83% of today's loss budget is used; automation pauses at 70%.");
});

test("automation: with only the amount cap set, the share names the closed-trade count and not the equity", () => {
  const limits = resolveEffectiveLimits({ userSettings: { ...USER, maxDailyLossAmount: 600, blockAfterDailyLossHit: true } });
  const ctx = ctxOf({ ...INDEX_DAY, limits: { ...limits, maxDailyLossPercent: null } });
  const r = evaluatePreTradeRisk(intentOf({ origin: "automation" }), ctx).rules.find((x) => x.rule === "trading_discipline")!;
  assert.equal(r.outcome, "BLOCK");
  assert.match(r.reason!, /83% of today's loss budget is used \(paper risk count: today's closed trades count -500 against -5 booked; it takes the lower of the booked total and the price move × lots × 100 total of the closed paper trades\); automation pauses at 70%/);
  assert.doesNotMatch(r.reason!, /equity counts/);
});

test("buying power: 'only X is free' says it is the paper risk count and shows the free margin the paper account shows", () => {
  // Risk-count equity 350 with 300 margin in use: 50 free on the count; the
  // paper account shows 9,800 booked, so 9,500 free.
  const ctx = ctxOf({ account: { equity: 350, bookedEquity: 9_800, freeMargin: 50, leverage: 100, currency: "USD", source: "paper_account:3" } });
  const r = evaluatePreTradeRisk(intentOf({ lots: 0.1 }), ctx).rules.find((x) => x.rule === "buying_power")!;
  assert.equal(r.outcome, "BLOCK");
  assert.match(r.reason!, /^This trade needs about 110\.01 margin but only 50 is free on the paper risk count \(equity counts 350 against 9800 booked, so the paper account shows 9500 free; the risk count takes the lower of the booked total/);
  assert.equal(r.measured?.["bookedEquity"], 9_800);
  // A broker account (no booked figure) reads as before.
  const live = evaluatePreTradeRisk(intentOf({ lots: 0.1, venue: "LIVE" }),
    ctxOf({ account: { equity: 350, freeMargin: 50, leverage: 100, currency: "USD", source: "broker_hub:mt5:1" } }));
  assert.equal(live.rules.find((x) => x.rule === "buying_power")!.reason, "This trade needs about 110.01 margin but only 50 is free.");
});
