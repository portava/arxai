// Pre-trade Risk Governor — rule-by-rule proof of the pure evaluator.
//
// For each of the 12 mandatory rules: a baseline intent that passes every
// rule, then one fact changed so that rule (and only that rule) blocks. The
// decision, the blocking rule id and the measured values are asserted, so a
// rule that silently stops evaluating fails here. Combination cases prove
// that every breached rule is reported (not first-fail) and that risk-reducing
// actions stay open while new risk is blocked.
//
// Run: pnpm --filter @workspace/api-server run test:risk-governor-rules

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePreTradeRisk,
  resolveEffectiveLimits,
  RISK_RULE_IDS,
  PLATFORM_RISK_CEILINGS,
  isStopWidened,
  type RiskContext,
  type TradeIntent,
  type RiskRuleId,
} from "../preTrade.js";

const NOW = new Date("2026-10-23T12:00:00Z");
const FX = { contractSize: 100_000, quoteToAccountFx: 1, volumeStep: 0.01, minVolume: 0.01, maxVolume: 50, source: "FX_STANDARD_LOT" };

function baseCtx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOW,
    limits: resolveEffectiveLimits({}),
    account: { equity: 10_000, freeMargin: 9_000, leverage: 100, currency: "USD", source: "test" },
    instruments: { EURUSD: FX, GBPUSD: FX },
    quote: { bid: 1.1, ask: 1.1001, at: new Date(NOW.getTime() - 2_000), source: "test" },
    positions: [],
    inFlight: [],
    broker: { status: "CONNECTED", lastSeenAt: NOW, detail: "test" },
    daily: { realizedPnl: 0, floatingPnl: 0 },
    ...over,
  };
}

// 0.1 lot EURUSD, stop 50 pips away: loss at stop = 0.005 × 0.1 × 100,000 = $50 (0.5% of $10k).
function baseIntent(over: Partial<TradeIntent> = {}): TradeIntent {
  return {
    userId: 1, venue: "LIVE", origin: "manual", action: "OPEN",
    symbol: "EURUSD", side: "BUY", lots: 0.1,
    stopLoss: 1.0951, takeProfit: 1.11,
    ...over,
  };
}

function blockedOnly(intent: TradeIntent, ctx: RiskContext, rule: RiskRuleId) {
  const d = evaluatePreTradeRisk(intent, ctx);
  assert.equal(d.decision, "BLOCK", `${rule} should block`);
  assert.deepEqual(d.blockedBy, [rule], `only ${rule} should block, got ${d.blockedBy.join(",")}`);
  const r = d.rules.find((x) => x.rule === rule)!;
  assert.ok(r.reason && r.reason.length > 10, `${rule} carries a human reason`);
  assert.equal(d.primaryReason, r.reason);
  return r;
}

test("baseline intent passes all 12 rules and reports every rule", () => {
  const d = evaluatePreTradeRisk(baseIntent(), baseCtx());
  assert.equal(d.decision, "ALLOW", d.primaryReason ?? "");
  assert.deepEqual(d.rules.map((r) => r.rule), [...RISK_RULE_IDS]);
  assert.equal(d.rules.length, 12);
  assert.ok(d.rules.every((r) => r.outcome === "PASS"));
});

test("rule 1 max_position_size: lot above the strictest stored cap blocks", () => {
  const ctx = baseCtx({ limits: resolveEffectiveLimits({ legacySettings: { maxDailyLossPct: 50, maxLotSize: 0.05, riskPerTradePct: 5, maxOpenTrades: 5 } }) });
  // Raise per-trade risk room so only the lot cap is in play.
  const r = blockedOnly(baseIntent({ lots: 0.08, stopLoss: 1.0991 }), ctx, "max_position_size");
  assert.equal(r.measured?.["maxLotSize"], 0.05);
  assert.equal(r.measured?.["source"], "risk_settings.max_lot_size");
});

test("rule 2 max_portfolio_exposure: open risk at stop plus the new trade above the cap blocks", () => {
  // cap = 1% × 3 open trades = 3% = $300; open risk $260 + new $50 = $310.
  const ctx = baseCtx({ positions: [{ symbol: "GBPUSD", side: "BUY", lots: 0.2, entryPrice: 1.3, stopLoss: 1.287 }] });
  const r = blockedOnly(baseIntent(), ctx, "max_portfolio_exposure");
  assert.equal(r.measured?.["openRisk"], 260);
  assert.equal(r.measured?.["cap"], 300);
});

test("rule 2 max_portfolio_exposure: an open position with no stop makes exposure unbounded", () => {
  const ctx = baseCtx({ positions: [{ symbol: "GBPUSD", side: "BUY", lots: 0.01, entryPrice: 1.3, stopLoss: null }] });
  const r = blockedOnly(baseIntent(), ctx, "max_portfolio_exposure");
  assert.match(r.reason!, /no stop/);
});

test("rule 3 buying_power: required margin above free margin blocks", () => {
  // notional 0.1 × 100k × 1.1001 = $11,001; at 1:100 margin ≈ $110.
  const ctx = baseCtx({ account: { equity: 10_000, freeMargin: 100, leverage: 100, currency: "USD", source: "test" } });
  const r = blockedOnly(baseIntent(), ctx, "buying_power");
  assert.equal(r.measured?.["requiredMargin"], 110.01);
});

test("rule 3 buying_power: unknown free margin blocks (fail-safe)", () => {
  const ctx = baseCtx({ account: { equity: 10_000, freeMargin: null, leverage: 100, currency: "USD", source: "test" } });
  blockedOnly(baseIntent(), ctx, "buying_power");
});

test("rule 4 leverage: gross notional above 30x equity blocks", () => {
  // Open 2.5 lots GBPUSD @1.3 = $325k; plus $11k new = $336k on $10k = 33.6x.
  const ctx = baseCtx({
    limits: { ...resolveEffectiveLimits({}), maxPortfolioRiskPercent: 10, maxSymbolLeverage: 40, maxLotSize: 5 },
    account: { equity: 10_000, freeMargin: 9_000, leverage: 500, currency: "USD", source: "test" },
    positions: [{ symbol: "GBPUSD", side: "BUY", lots: 2.5, entryPrice: 1.3, stopLoss: 1.2998 }],
  });
  const r = blockedOnly(baseIntent(), ctx, "leverage");
  assert.equal(r.measured?.["leverage"], 33.6);
});

test("rule 5 concentration: a third position on one symbol blocks", () => {
  const ctx = baseCtx({
    limits: { ...resolveEffectiveLimits({}), maxPortfolioRiskPercent: 10 },
    positions: [
      { symbol: "EURUSD", side: "BUY", lots: 0.01, entryPrice: 1.1, stopLoss: 1.095 },
      { symbol: "EURUSD", side: "BUY", lots: 0.01, entryPrice: 1.1, stopLoss: 1.095 },
    ],
  });
  const r = blockedOnly(baseIntent(), ctx, "concentration");
  assert.equal(r.measured?.["positionsOnSymbol"], 3);
});

test("rule 5 concentration: one symbol above 15x equity blocks", () => {
  const ctx = baseCtx({
    limits: { ...resolveEffectiveLimits({}), maxPortfolioRiskPercent: 10, maxLotSize: 5 },
    account: { equity: 10_000, freeMargin: 9_000, leverage: 500, currency: "USD", source: "test" },
    positions: [{ symbol: "EURUSD", side: "BUY", lots: 1.5, entryPrice: 1.1, stopLoss: 1.0999 }],
  });
  const r = blockedOnly(baseIntent(), ctx, "concentration");
  assert.ok(Number(r.measured?.["symbolLeverage"]) > 15);
});

test("rule 6 stop_loss_required: missing stop blocks (and per-trade loss reports unbounded)", () => {
  const d = evaluatePreTradeRisk(baseIntent({ stopLoss: null }), baseCtx());
  assert.equal(d.decision, "BLOCK");
  assert.ok(d.blockedBy.includes("stop_loss_required"));
  // Without a stop the loss is unbounded, so per-trade and portfolio risk block too.
  assert.ok(d.blockedBy.includes("per_trade_loss_limit"));
  assert.ok(d.blockedBy.includes("max_portfolio_exposure"));
});

test("rule 6 stop_loss_required: a MODIFY that removes the stop blocks", () => {
  const d = evaluatePreTradeRisk(baseIntent({ action: "MODIFY", stopLoss: null }), baseCtx());
  assert.deepEqual(d.blockedBy, ["stop_loss_required"]);
});

test("rule 7 daily_loss_limit: realized plus floating loss at the cap blocks new risk", () => {
  const ctx = baseCtx({ daily: { realizedPnl: -250, floatingPnl: -60 } }); // 3.1% ≥ 3%
  const r = blockedOnly(baseIntent(), ctx, "daily_loss_limit");
  assert.equal(r.measured?.["combinedPnl"], -310);
});

test("rule 7 daily_loss_limit: admin USD cap applies even when the trader switched their own off", () => {
  const limits = resolveEffectiveLimits({
    userSettings: { maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null, maxDailyLossPercent: 3, maxDailyLossAmount: null, maxOpenTrades: 3, maxPositionSize: null, blockAfterDailyLossHit: false, requireStopLoss: true },
    adminLimits: { maxLotSize: 5, maxDailyLossUsd: 100, allowedAccountType: "both" },
  });
  assert.equal(limits.maxDailyLossPercent, null);
  assert.equal(limits.maxDailyLossAmount, 100);
  blockedOnly(baseIntent(), baseCtx({ limits, daily: { realizedPnl: -100, floatingPnl: 0 } }), "daily_loss_limit");
});

test("rule 7 daily_loss_limit: unknown realized P/L blocks (fail-safe)", () => {
  blockedOnly(baseIntent(), baseCtx({ daily: { realizedPnl: null, floatingPnl: null } }), "daily_loss_limit");
});

test("rule 8 per_trade_loss_limit: loss at stop above 1% of equity blocks", () => {
  // 0.3 lot × 50 pips = $150 > $100.
  const r = blockedOnly(baseIntent({ lots: 0.3 }), baseCtx({ limits: { ...resolveEffectiveLimits({}), maxPortfolioRiskPercent: 10 } }), "per_trade_loss_limit");
  assert.equal(r.measured?.["lossAtStop"], 150);
});

test("rule 8 per_trade_loss_limit: unknown contract size blocks rather than guessing", () => {
  const ctx = baseCtx({ instruments: { EURUSD: { ...FX, contractSize: null, source: "NO_BROKER_SPEC_AND_NOT_FOREX" }, GBPUSD: FX } });
  const d = evaluatePreTradeRisk(baseIntent(), ctx);
  assert.equal(d.decision, "BLOCK");
  assert.ok(d.blockedBy.includes("per_trade_loss_limit"));
  assert.match(d.rules.find((r) => r.rule === "per_trade_loss_limit")!.reason!, /contract size/);
});

test("rule 9 duplicate_or_conflicting: an identical order in flight blocks", () => {
  const ctx = baseCtx({ inFlight: [{ ref: "live_command:abc", symbol: "EURUSD", side: "BUY", lots: 0.1, at: NOW, kind: "pending" }] });
  const r = blockedOnly(baseIntent(), ctx, "duplicate_or_conflicting");
  assert.equal(r.measured?.["duplicateOf"], "live_command:abc");
});

test("rule 9 duplicate_or_conflicting: the intent's own row is not a duplicate of itself", () => {
  const ctx = baseCtx({ inFlight: [{ ref: "live_command:abc", symbol: "EURUSD", side: "BUY", lots: 0.1, at: NOW, kind: "pending" }] });
  assert.equal(evaluatePreTradeRisk(baseIntent({ intentRef: "live_command:abc" }), ctx).decision, "ALLOW");
});

test("rule 9 duplicate_or_conflicting: a BUY against an open SELL on the same symbol blocks", () => {
  const ctx = baseCtx({ positions: [{ symbol: "EURUSD", side: "SELL", lots: 0.01, entryPrice: 1.1, stopLoss: 1.105 }] });
  const r = blockedOnly(baseIntent(), ctx, "duplicate_or_conflicting");
  assert.match(r.reason!, /conflicts/);
});

test("rule 9 duplicate_or_conflicting: a fill outside the window is not a duplicate", () => {
  const old = new Date(NOW.getTime() - PLATFORM_RISK_CEILINGS.duplicateWindowMs - 1_000);
  const ctx = baseCtx({ inFlight: [{ ref: "paper_order:1", symbol: "EURUSD", side: "BUY", lots: 0.1, at: old, kind: "filled" }] });
  assert.equal(evaluatePreTradeRisk(baseIntent(), ctx).decision, "ALLOW");
});

test("rule 10 stale_market_data: a quote older than 60s blocks", () => {
  const ctx = baseCtx({ quote: { bid: 1.1, ask: 1.1001, at: new Date(NOW.getTime() - 61_000), source: "test" } });
  const r = blockedOnly(baseIntent(), ctx, "stale_market_data");
  assert.equal(r.measured?.["ageMs"], 61_000);
});

test("rule 10 stale_market_data: no quote at all blocks every price-dependent rule", () => {
  const d = evaluatePreTradeRisk(baseIntent(), baseCtx({ quote: null }));
  assert.equal(d.decision, "BLOCK");
  assert.ok(d.blockedBy.includes("stale_market_data"));
});

test("rule 10 stale_market_data: a quote without a timestamp blocks", () => {
  blockedOnly(baseIntent(), baseCtx({ quote: { bid: 1.1, ask: 1.1001, at: null, source: "test" } }), "stale_market_data");
});

test("rule 11 invalid_price_quantity: lot not on the volume step blocks", () => {
  const r = blockedOnly(baseIntent({ lots: 0.105 }), baseCtx(), "invalid_price_quantity");
  assert.match(r.reason!, /lot step/);
});

test("rule 11 invalid_price_quantity: a BUY stop above the price blocks", () => {
  const d = evaluatePreTradeRisk(baseIntent({ stopLoss: 1.2 }), baseCtx());
  assert.ok(d.blockedBy.includes("invalid_price_quantity"));
  assert.match(d.rules.find((r) => r.rule === "invalid_price_quantity")!.reason!, /must be below/);
});

test("rule 11 invalid_price_quantity: zero, negative and NaN quantities block", () => {
  for (const lots of [0, -1, Number.NaN]) {
    const d = evaluatePreTradeRisk(baseIntent({ lots }), baseCtx());
    assert.ok(d.blockedBy.includes("invalid_price_quantity"), `lots=${lots}`);
  }
});

test("rule 11 invalid_price_quantity: a limit price 25% away from market blocks (fat finger)", () => {
  const d = evaluatePreTradeRisk(baseIntent({ entryPrice: 1.38, stopLoss: 1.375, takeProfit: 1.4 }), baseCtx());
  assert.ok(d.blockedBy.includes("invalid_price_quantity"));
});

test("rule 12 broker_unavailable: a disconnected bridge blocks", () => {
  blockedOnly(baseIntent(), baseCtx({ broker: { status: "DISCONNECTED", lastSeenAt: null, detail: "no MT5 connection" } }), "broker_unavailable");
});

test("rule 12 broker_unavailable: a degraded bridge blocks new risk but still lets a close through", () => {
  const ctx = baseCtx({ broker: { status: "DEGRADED", lastSeenAt: NOW, detail: "last heartbeat 60s ago" } });
  blockedOnly(baseIntent(), ctx, "broker_unavailable");
  assert.equal(evaluatePreTradeRisk(baseIntent({ action: "CLOSE" }), ctx).decision, "ALLOW");
});

test("combination: daily loss + stale quote + duplicate are all reported, in rule order", () => {
  const ctx = baseCtx({
    daily: { realizedPnl: -400, floatingPnl: 0 },
    quote: { bid: 1.1, ask: 1.1001, at: new Date(NOW.getTime() - 120_000), source: "test" },
    inFlight: [{ ref: "trade_action:9", symbol: "EURUSD", side: "BUY", lots: 0.1, at: NOW, kind: "pending" }],
  });
  const d = evaluatePreTradeRisk(baseIntent(), ctx);
  assert.deepEqual(d.blockedBy, ["daily_loss_limit", "duplicate_or_conflicting", "stale_market_data"]);
});

test("combination: oversized lot also breaches per-trade loss, exposure and margin", () => {
  const d = evaluatePreTradeRisk(baseIntent({ lots: 6 }), baseCtx({ account: { equity: 10_000, freeMargin: 2_000, leverage: 100, currency: "USD", source: "test" } }));
  for (const r of ["max_position_size", "per_trade_loss_limit", "max_portfolio_exposure", "buying_power"] as const) {
    assert.ok(d.blockedBy.includes(r), `${r} in ${d.blockedBy.join(",")}`);
  }
});

test("combination: in close-only conditions a CLOSE is allowed while the OPEN is blocked", () => {
  const ctx = baseCtx({
    daily: { realizedPnl: -1_000, floatingPnl: -200 },
    quote: null,
    positions: [{ symbol: "EURUSD", side: "BUY", lots: 0.1, entryPrice: 1.1, stopLoss: null }],
  });
  assert.equal(evaluatePreTradeRisk(baseIntent(), ctx).decision, "BLOCK");
  const close = evaluatePreTradeRisk(baseIntent({ action: "CLOSE", stopLoss: null }), ctx);
  assert.equal(close.decision, "ALLOW");
  assert.ok(close.rules.filter((r) => r.outcome === "NOT_APPLICABLE").length === 10);
});

test("combination: a CLOSE with an invalid quantity or a disconnected bridge is still refused", () => {
  assert.deepEqual(evaluatePreTradeRisk(baseIntent({ action: "CLOSE", lots: 0 }), baseCtx()).blockedBy, ["invalid_price_quantity"]);
  assert.deepEqual(evaluatePreTradeRisk(baseIntent({ action: "CLOSE" }),
    baseCtx({ broker: { status: "DISCONNECTED", lastSeenAt: null, detail: "x" } })).blockedBy, ["broker_unavailable"]);
});

test("limits: the strictest stored value wins and the platform ceiling bounds them all", () => {
  const l = resolveEffectiveLimits({
    userSettings: { maxRiskPerTradePercent: 2, maxRiskPerTradeAmount: 80, maxDailyLossPercent: 4, maxDailyLossAmount: 500, maxOpenTrades: 4, maxPositionSize: 3, blockAfterDailyLossHit: true, requireStopLoss: false },
    legacySettings: { maxDailyLossPct: 2, maxLotSize: 10, riskPerTradePct: 0.5, maxOpenTrades: 2 },
    adminLimits: { maxLotSize: 0.5, maxDailyLossUsd: 300 },
  });
  assert.equal(l.maxLotSize, 0.5);
  assert.equal(l.sources["maxLotSize"], "user_risk_limits.max_lot_size");
  assert.equal(l.maxRiskPerTradePercent, 0.5);
  assert.equal(l.maxRiskPerTradeAmount, 80);
  assert.equal(l.maxDailyLossPercent, 2);
  assert.equal(l.maxDailyLossAmount, 300);
  assert.equal(l.requireStopLoss, false);
  assert.equal(l.maxPortfolioRiskPercent, 1); // 0.5% × min(4, 2) open trades
  const none = resolveEffectiveLimits({ legacySettings: { maxDailyLossPct: 2, maxLotSize: 99, riskPerTradePct: 1, maxOpenTrades: 3 } });
  assert.equal(none.maxLotSize, PLATFORM_RISK_CEILINGS.maxLotSize);
});

test("an AI or automation origin gets no relaxation: identical facts, identical decision", () => {
  const ctx = baseCtx({ daily: { realizedPnl: -400, floatingPnl: 0 } });
  const manual = evaluatePreTradeRisk(baseIntent({ origin: "manual" }), ctx);
  for (const origin of ["ruby", "automation", "strategy", "api"] as const) {
    const d = evaluatePreTradeRisk(baseIntent({ origin }), ctx);
    assert.deepEqual(d.blockedBy, manual.blockedBy, origin);
  }
});

// ── Position Guardian: stop modifications ─────────────────────────────────
// Open BUY 0.1 EURUSD at 1.1000, stop 1.0951 ($49 at risk; per-trade cap $100).
const OPEN_POS = { entryPrice: 1.1, stopLoss: 1.0951 };
function modify(over: Partial<TradeIntent> = {}): TradeIntent {
  return baseIntent({ action: "MODIFY", takeProfit: null, position: OPEN_POS, ...over });
}

test("guardian: automation may tighten a stop", () => {
  for (const origin of ["automation", "ruby", "strategy"] as const) {
    const d = evaluatePreTradeRisk(modify({ origin, stopLoss: 1.098 }), baseCtx());
    assert.equal(d.decision, "ALLOW", `${origin}: ${d.primaryReason ?? ""}`);
  }
});

test("guardian: automation or Ruby cannot widen a stop, even within the per-trade limit", () => {
  for (const origin of ["automation", "ruby", "strategy", "api"] as const) {
    const r = blockedOnly(modify({ origin, stopLoss: 1.095 }), baseCtx(), "stop_loss_required");
    assert.match(r.reason!, /only tighten/);
    assert.equal(r.measured?.["currentStopLoss"], 1.0951);
    assert.equal(r.measured?.["newStopLoss"], 1.095);
  }
});

test("guardian: automation cannot remove a stop, and cannot modify a position it cannot identify", () => {
  const removed = evaluatePreTradeRisk(modify({ origin: "automation", stopLoss: null }), baseCtx());
  assert.deepEqual(removed.blockedBy, ["stop_loss_required"]);
  const unknown = evaluatePreTradeRisk(modify({ origin: "ruby", stopLoss: 1.098, position: null }), baseCtx());
  assert.deepEqual(unknown.blockedBy, ["stop_loss_required"]);
  assert.match(unknown.primaryReason!, /could not be found/);
});

test("guardian: a trader may widen a stop by hand only within the per-trade loss limit", () => {
  const within = evaluatePreTradeRisk(modify({ stopLoss: 1.095 }), baseCtx());
  assert.equal(within.decision, "ALLOW", within.primaryReason ?? "");
  // 1.0850 puts 0.015 × 0.1 × 100,000 = $150 at risk against a $100 cap.
  const r = blockedOnly(modify({ stopLoss: 1.085 }), baseCtx(), "per_trade_loss_limit");
  assert.equal(r.measured?.["lossAtStop"], 150);
  assert.equal(r.measured?.["cap"], 100);
});

test("guardian: a widened stop whose size cannot be measured is refused", () => {
  const ctx = baseCtx({ account: null });
  const d = evaluatePreTradeRisk(modify({ stopLoss: 1.095 }), ctx);
  assert.ok(d.blockedBy.includes("per_trade_loss_limit"));
});

// ── Stop switches ───────────────────────────────────────────────────────────
const HALTED = { engaged: true, sources: ["trader_kill_switch"], reason: "Your kill switch is engaged." };

test("halt: an engaged stop switch blocks an otherwise clean open and is reported first", () => {
  const d = evaluatePreTradeRisk(baseIntent(), baseCtx({ halt: HALTED }));
  assert.equal(d.decision, "BLOCK");
  assert.deepEqual(d.blockedBy, ["trading_halt"]);
  assert.match(d.primaryReason!, /^Trading is halted: Your kill switch/);
  assert.equal(d.rules.length, 12, "the 12 rules are still evaluated and recorded");
  const both = evaluatePreTradeRisk(baseIntent({ stopLoss: null }), baseCtx({ halt: HALTED }));
  assert.equal(both.blockedBy[0], "trading_halt");
  assert.ok(both.blockedBy.includes("stop_loss_required"), "rule breaches are still listed after the halt");
});

test("halt: closes and tightened stops stay open under a halt; widened stops and AI origins do not", () => {
  for (const action of ["CLOSE", "PARTIAL_CLOSE"] as const) {
    assert.equal(evaluatePreTradeRisk(baseIntent({ action }), baseCtx({ halt: HALTED })).decision, "ALLOW", action);
  }
  const tighten = baseIntent({ action: "MODIFY", stopLoss: 1.098, takeProfit: null, position: { entryPrice: 1.1, stopLoss: 1.0951 } });
  assert.equal(evaluatePreTradeRisk(tighten, baseCtx({ halt: HALTED })).decision, "ALLOW", "tightening a stop cuts risk");
  const widen = baseIntent({ action: "MODIFY", stopLoss: 1.095, takeProfit: null, position: { entryPrice: 1.1, stopLoss: 1.0951 } });
  assert.deepEqual(evaluatePreTradeRisk(widen, baseCtx({ halt: HALTED })).blockedBy, ["trading_halt"]);
  assert.deepEqual(evaluatePreTradeRisk(baseIntent({ origin: "ruby" }), baseCtx({ halt: HALTED })).blockedBy, ["trading_halt"]);
  assert.equal(evaluatePreTradeRisk(baseIntent(), baseCtx({ halt: { engaged: false, sources: [], reason: null } })).decision, "ALLOW");
});

test("isStopWidened: further from price or removed is wider; closer or equal is not", () => {
  assert.equal(isStopWidened("BUY", 1.095, 1.09), true);
  assert.equal(isStopWidened("BUY", 1.095, 1.098), false);
  assert.equal(isStopWidened("BUY", 1.095, 1.095), false);
  assert.equal(isStopWidened("SELL", 1.105, 1.11), true);
  assert.equal(isStopWidened("SELL", 1.105, 1.1), false);
  assert.equal(isStopWidened("BUY", 1.095, null), true);
});

// ── Broker account snapshot freshness ───────────────────────────────────────
const SNAP = (status: "FRESH" | "STALE" | "MISSING") => ({
  status, observedAt: status === "MISSING" ? null : new Date(NOW.getTime() - 5 * 60_000), source: "broker_hub:mt5:7",
});

test("rule 12 account snapshot: STALE and MISSING refuse new risk on that account; FRESH evaluates normally", () => {
  assert.equal(evaluatePreTradeRisk(baseIntent(), baseCtx({ accountSnapshot: SNAP("FRESH") })).decision, "ALLOW");
  for (const status of ["STALE", "MISSING"] as const) {
    const r = blockedOnly(baseIntent(), baseCtx({ accountSnapshot: SNAP(status) }), "broker_unavailable");
    assert.match(r.reason!, new RegExp(`^Account data is ${status.toLowerCase()}`));
    assert.match(r.reason!, /closing is still allowed/);
    assert.equal(r.measured?.["accountSnapshot"], status);
    assert.equal(r.measured?.["accountSource"], "broker_hub:mt5:7");
  }
});

test("rule 12 account snapshot: closing, partial closing and tightening stay possible; widening does not", () => {
  const stale = baseCtx({ accountSnapshot: SNAP("STALE") });
  for (const action of ["CLOSE", "PARTIAL_CLOSE"] as const) {
    assert.equal(evaluatePreTradeRisk(baseIntent({ action }), stale).decision, "ALLOW", action);
  }
  const tighten = baseIntent({ action: "MODIFY", stopLoss: 1.098, takeProfit: null, position: { entryPrice: 1.1, stopLoss: 1.0951 } });
  assert.equal(evaluatePreTradeRisk(tighten, stale).decision, "ALLOW");
  const widen = baseIntent({ action: "MODIFY", stopLoss: 1.095, takeProfit: null, position: { entryPrice: 1.1, stopLoss: 1.0951 } });
  assert.ok(evaluatePreTradeRisk(widen, stale).blockedBy.includes("broker_unavailable"));
  assert.equal(evaluatePreTradeRisk(baseIntent(), baseCtx({ accountSnapshot: null })).decision, "ALLOW",
    "no broker account behind the order (paper, shared ledger) is not a stale snapshot");
});

// ── Per-user exposure limits (Tier 1 step 8) ─────────────────────────────

const USER_ROW = {
  maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null, maxDailyLossPercent: 3, maxDailyLossAmount: null,
  maxOpenTrades: 3, maxPositionSize: null, blockAfterDailyLossHit: true, requireStopLoss: true,
};
const ADMIN_ROW = { maxLotSize: 5, maxDailyLossUsd: 0, allowedSymbols: [], allowedAccountType: "both", allowedDirection: "both" };

test("per-user limits: leverage, concentration, positions per symbol and portfolio take the strictest of trader, admin and platform", () => {
  const L = resolveEffectiveLimits({
    userSettings: { ...USER_ROW, maxLeverage: 10, maxSymbolLeverage: 20, maxPositionsPerSymbol: 1, maxPortfolioRiskPercent: 2 },
    adminLimits: { ...ADMIN_ROW, maxLeverage: 12, maxSymbolLeverage: 4, maxPositionsPerSymbol: 3, maxPortfolioRiskPercent: 50 },
  });
  assert.equal(L.maxLeverage, 10);
  assert.equal(L.sources["maxLeverage"], "user_risk_settings.max_leverage");
  assert.equal(L.maxSymbolLeverage, 4, "admin is stricter than the trader");
  assert.equal(L.sources["maxSymbolLeverage"], "user_risk_limits.max_symbol_leverage");
  assert.equal(L.maxPositionsPerSymbol, 1);
  assert.equal(L.maxPortfolioRiskPercent, 2);
  const loose = resolveEffectiveLimits({ userSettings: { ...USER_ROW, maxLeverage: 500, maxSymbolLeverage: 500, maxPositionsPerSymbol: 99 } });
  assert.equal(loose.maxLeverage, PLATFORM_RISK_CEILINGS.maxLeverage, "a stored value can never loosen the ceiling");
  assert.equal(loose.maxSymbolLeverage, PLATFORM_RISK_CEILINGS.maxSymbolLeverage);
  assert.equal(loose.maxPositionsPerSymbol, PLATFORM_RISK_CEILINGS.maxPositionsPerSymbol);
  const none = resolveEffectiveLimits({});
  assert.equal(none.maxDrawdownPercent, null, "no drawdown cap unless one is set");
  assert.equal(none.liveAllowed, true);
});

test("per-user limits: a trader's leverage cap blocks a trade the platform ceiling would allow", () => {
  // 0.1 lot EURUSD ≈ $11k notional on $10k equity = 1.1x; cap 1x.
  const ctx = baseCtx({ limits: resolveEffectiveLimits({ userSettings: { ...USER_ROW, maxLeverage: 1 } }) });
  const r = blockedOnly(baseIntent(), ctx, "leverage");
  assert.equal(r.measured?.["maxLeverage"], 1);
});

test("per-user limits: positions per symbol of 1 blocks a second EURUSD", () => {
  const ctx = baseCtx({
    limits: resolveEffectiveLimits({ userSettings: { ...USER_ROW, maxPositionsPerSymbol: 1 } }),
    positions: [{ symbol: "EURUSD", side: "BUY", lots: 0.01, entryPrice: 1.1, stopLoss: 1.099 }],
  });
  const r = blockedOnly(baseIntent(), ctx, "concentration");
  assert.equal(r.measured?.["maxPositionsPerSymbol"], 1);
});

test("instrument limits: a per-symbol lot cap and a switched-off symbol block on max_position_size", () => {
  const capped = baseCtx({ limits: resolveEffectiveLimits({ userSettings: { ...USER_ROW, symbolLimits: { eurusd: { maxLots: 0.05 } } } }) });
  const r = blockedOnly(baseIntent({ lots: 0.08, stopLoss: 1.0991 }), capped, "max_position_size");
  assert.equal(r.measured?.["maxLotSize"], 0.05);
  assert.equal(r.measured?.["source"], "user_risk_settings.symbol_limits.EURUSD");
  const off = baseCtx({ limits: resolveEffectiveLimits({ userSettings: { ...USER_ROW, symbolLimits: { EURUSD: { blocked: true } } } }) });
  assert.match(blockedOnly(baseIntent(), off, "max_position_size").reason!, /switched off/);
  const other = evaluatePreTradeRisk(baseIntent({ symbol: "GBPUSD", stopLoss: 1.0951 }), off);
  assert.ok(!other.blockedBy.includes("max_position_size"), "other symbols are unaffected");
});

test("account limits: admin allow-list, direction and demo-only apply to every venue path", () => {
  const list = baseCtx({ limits: resolveEffectiveLimits({ adminLimits: { ...ADMIN_ROW, allowedSymbols: ["GBPUSD"] } }) });
  assert.match(blockedOnly(baseIntent(), list, "max_position_size").reason!, /not on the instruments/);
  const sellOnly = baseCtx({ limits: resolveEffectiveLimits({ adminLimits: { ...ADMIN_ROW, allowedDirection: "sell" } }) });
  assert.match(blockedOnly(baseIntent(), sellOnly, "max_position_size").reason!, /SELL trades only/);
  const demo = baseCtx({ limits: resolveEffectiveLimits({ adminLimits: { ...ADMIN_ROW, allowedAccountType: "demo" } }) });
  assert.match(blockedOnly(baseIntent({ venue: "LIVE" }), demo, "max_position_size").reason!, /limited to demo/);
  assert.equal(evaluatePreTradeRisk(baseIntent({ venue: "DEMO" }), demo).decision, "ALLOW");
});

test("drawdown: at or past the cap from the recorded peak blocks new risk; closing stays open", () => {
  const limits = resolveEffectiveLimits({ userSettings: { ...USER_ROW, maxDrawdownPercent: 10 } });
  const peak = { peakEquity: 11_200, since: new Date("2026-10-01T00:00:00Z"), source: "test" };
  // $10k equity vs $11.2k peak = 10.7% down.
  const r = blockedOnly(baseIntent(), baseCtx({ limits, equityPeak: peak }), "daily_loss_limit");
  assert.equal(r.measured?.["drawdownPercent"], 10.71);
  assert.match(r.reason!, /below its peak equity/);
  assert.equal(evaluatePreTradeRisk(baseIntent({ action: "CLOSE", stopLoss: null }), baseCtx({ limits, equityPeak: peak })).decision, "ALLOW");
  assert.equal(evaluatePreTradeRisk(baseIntent(), baseCtx({ limits, equityPeak: { ...peak, peakEquity: 10_500 } })).decision, "ALLOW");
  assert.equal(evaluatePreTradeRisk(baseIntent(), baseCtx({ limits, equityPeak: null })).decision, "ALLOW", "no peak yet: today is the peak");
  const unknown = baseCtx({ limits, account: { equity: null, freeMargin: 9_000, leverage: 100, currency: "USD", source: "test" } });
  assert.ok(evaluatePreTradeRisk(baseIntent(), unknown).rules.find((x) => x.rule === "daily_loss_limit")!.reason!.includes("drawdown"));
});
