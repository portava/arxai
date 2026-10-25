// Rule 13 trading_discipline — the trader's own rules inside the one Risk Governor.
//
// The settings that used to live in three separate engines (the paper engine's
// trades/day, streak and cooldown checks, the readiness automation pause and
// the simulator's venue floors) now run as one rule of the pure evaluator:
//   - hard checks block on their own,
//   - soft checks warn alone and block in pairs,
//   - unreadable activity refuses new risk only when a cap is set,
//   - risk-reducing actions are never refused by this rule,
//   - a written override passes a block from this rule alone, in PAPER only.
//
// Run: pnpm --filter @workspace/api-server run test:risk-governor-discipline

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePreTradeRisk,
  resolveEffectiveLimits,
  summarizeActivity,
  AUTOMATION_DAILY_BUDGET_SHARE,
  type RiskContext,
  type TradeIntent,
  type TradingActivity,
} from "../preTrade.js";
import { overrideApplies } from "../enforce.js";

const NOW = new Date("2026-10-23T12:00:00Z");
const FX = { contractSize: 100_000, quoteToAccountFx: 1, volumeStep: 0.01, minVolume: 0.01, maxVolume: 50, source: "FX_STANDARD_LOT" };
const QUIET: TradingActivity = {
  tradesToday: 0, weekRealizedPnl: 0, consecutiveLosses: 0, lastClosedAt: null, lastClosedWasLoss: false,
  closesInLastHour: 0, reentriesAfterLossInLastHour: 0, source: "test",
};

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOW,
    limits: resolveEffectiveLimits({}),
    account: { equity: 10_000, freeMargin: 9_000, leverage: 100, currency: "USD", source: "test" },
    instruments: { EURUSD: FX, GBPUSD: FX },
    quote: { bid: 1.1, ask: 1.1001, at: new Date(NOW.getTime() - 2_000), source: "test" },
    positions: [], inFlight: [],
    broker: { status: "CONNECTED", lastSeenAt: NOW, detail: "test" },
    daily: { realizedPnl: 0, floatingPnl: 0 },
    activity: QUIET,
    ...over,
  };
}
// 0.1 lot EURUSD, stop 49 pips, target 100 pips: reward:risk ≈ 2.
function intent(over: Partial<TradeIntent> = {}): TradeIntent {
  return {
    userId: 1, venue: "LIVE", origin: "manual", action: "OPEN", symbol: "EURUSD", side: "BUY", lots: 0.1,
    stopLoss: 1.0951, takeProfit: 1.1101, ...over,
  };
}
function discipline(i: TradeIntent, c: RiskContext) {
  const d = evaluatePreTradeRisk(i, c);
  return { d, r: d.rules.find((x) => x.rule === "trading_discipline")! };
}
const act = (over: Partial<TradingActivity>): TradingActivity => ({ ...QUIET, ...over });

test("a quiet day with a sound ticket passes every rule, the discipline rule included", () => {
  const { d, r } = discipline(intent(), ctx());
  assert.equal(d.decision, "ALLOW", d.primaryReason ?? "");
  assert.equal(r.outcome, "PASS");
  assert.equal(r.measured?.["hard"], 0);
});

test("defaults: 5 trades a day, 3 open, 3 losses in a row, 30 min cooldown, minimum reward:risk 1.5", () => {
  const D = resolveEffectiveLimits({}).discipline;
  assert.equal(D.maxTradesPerDay, 5);
  assert.equal(D.maxOpenTrades, 3);
  assert.equal(D.maxConsecutiveLosses, 3);
  assert.equal(D.cooldownAfterLossMinutes, 30);
  assert.equal(D.minRewardRiskRatio, 1.5);
  assert.equal(D.allowOverrideInPaperMode, true);
});

test("hard: the daily trade count blocks on its own", () => {
  const { d } = discipline(intent(), ctx({ activity: act({ tradesToday: 5 }) }));
  assert.deepEqual(d.blockedBy, ["trading_discipline"]);
  assert.match(d.primaryReason!, /5 trades for today/);
});

test("hard: the strictest trades-per-day cap wins across trader and admin rows", () => {
  const L = resolveEffectiveLimits({
    userSettings: { ...baseUser(), maxTradesPerDay: 4 },
    adminLimits: { maxLotSize: 1, maxDailyLossUsd: 1_000, maxTradesPerDay: 2 },
  });
  assert.equal(L.discipline.maxTradesPerDay, 2);
  // An admin row without an account type allows DEMO only, so this runs on DEMO.
  const demo = intent({ venue: "DEMO" });
  assert.deepEqual(discipline(demo, ctx({ limits: L, activity: act({ tradesToday: 2 }) })).d.blockedBy, ["trading_discipline"]);
  assert.equal(discipline(demo, ctx({ limits: L, activity: act({ tradesToday: 1 }) })).d.decision, "ALLOW");
});

test("hard: consecutive losses block, and switching the streak block off lifts it", () => {
  assert.deepEqual(discipline(intent(), ctx({ activity: act({ consecutiveLosses: 3 }) })).d.blockedBy, ["trading_discipline"]);
  const off = resolveEffectiveLimits({ userSettings: { ...baseUser(), blockAfterConsecutiveLosses: false } });
  assert.equal(off.discipline.maxConsecutiveLosses, null);
  assert.equal(discipline(intent(), ctx({ limits: off, activity: act({ consecutiveLosses: 3 }) })).d.decision, "ALLOW");
});

test("hard: the weekly loss cap blocks by amount and by percent of equity", () => {
  const amt = resolveEffectiveLimits({ userSettings: { ...baseUser(), maxWeeklyLossAmount: 300 } });
  assert.deepEqual(discipline(intent(), ctx({ limits: amt, activity: act({ weekRealizedPnl: -300 }) })).d.blockedBy, ["trading_discipline"]);
  const pct = resolveEffectiveLimits({ userSettings: { ...baseUser(), maxWeeklyLossPercent: 5 } });
  const { r } = discipline(intent(), ctx({ limits: pct, activity: act({ weekRealizedPnl: -500 }) }));
  assert.equal(r.outcome, "BLOCK");
  assert.equal(r.measured?.["weekLossPercent"], 5);
});

test("hard: open trades plus pending orders count against the open-trade cap", () => {
  const pos = { symbol: "GBPUSD", side: "BUY" as const, lots: 0.01, entryPrice: 1.3, stopLoss: 1.299 };
  const c = ctx({
    positions: [pos, pos],
    inFlight: [{ ref: "live_command:x", symbol: "GBPUSD", side: "BUY", lots: 0.01, at: NOW, kind: "pending" }],
  });
  const { r } = discipline(intent(), c);
  assert.equal(r.outcome, "BLOCK");
  assert.equal(r.measured?.["openTrades"], 3);
});

test("soft: one warning alone passes and is recorded; two together block", () => {
  const cooled = act({ lastClosedAt: new Date(NOW.getTime() - 10 * 60_000), lastClosedWasLoss: true });
  const one = discipline(intent(), ctx({ activity: cooled }));
  assert.equal(one.r.outcome, "PASS");
  assert.match(String(one.r.measured?.["warnings"]), /cooldown/);
  const two = discipline(intent({ takeProfit: 1.105 }), ctx({ activity: cooled })); // R:R ≈ 1.0 < 1.5
  assert.equal(two.r.outcome, "BLOCK");
  assert.equal(two.r.measured?.["soft"], 2);
});

test("soft: overtrading and revenge re-entries are detected from the activity facts", () => {
  const { r } = discipline(intent(), ctx({ activity: act({ closesInLastHour: 5, reentriesAfterLossInLastHour: 2 }) }));
  assert.equal(r.outcome, "BLOCK");
  assert.match(r.reason!, /overtrading/);
});

test("soft: process gates apply only when the origin supplies process facts", () => {
  const missing = { playbookId: null, preTradeCheckDecision: null, preTradeCheckPassed: null, reasonForEntry: "" };
  assert.equal(discipline(intent({ process: missing }), ctx()).r.outcome, "BLOCK", "playbook + checklist + reason missing");
  assert.equal(discipline(intent(), ctx()).r.outcome, "PASS", "no process facts: not evaluated");
  const done = { playbookId: 7, preTradeCheckDecision: "pass", preTradeCheckPassed: true, reasonForEntry: "Break of structure" };
  assert.equal(discipline(intent({ process: done }), ctx()).r.outcome, "PASS");
});

test("activity: unreadable activity refuses new risk while caps are set; undefined is not evaluated", () => {
  const { d } = discipline(intent(), ctx({ activity: null }));
  assert.deepEqual(d.blockedBy, ["trading_discipline"]);
  assert.match(d.primaryReason!, /could not be read/);
  const u = discipline(intent(), ctx({ activity: undefined }));
  assert.equal(u.r.outcome, "PASS");
  assert.equal(u.r.measured?.["activity"], "not supplied");
});

test("automation pauses at 70% of the daily loss budget; the trader keeps the rest", () => {
  // Default daily cap is 3% of $10k = $300; 70% = $210.
  const c = ctx({ daily: { realizedPnl: -215, floatingPnl: 0 } });
  for (const origin of ["automation", "strategy"] as const) {
    const { r } = discipline(intent({ origin }), c);
    assert.equal(r.outcome, "BLOCK", origin);
    assert.ok(Number(r.measured?.["dailyBudgetUsed"]) >= AUTOMATION_DAILY_BUDGET_SHARE);
  }
  assert.equal(discipline(intent({ origin: "manual" }), c).d.decision, "ALLOW");
  assert.equal(discipline(intent({ origin: "automation" }), ctx({ daily: { realizedPnl: -150, floatingPnl: 0 } })).r.outcome, "PASS");
});

test("venue rules: a required target, a reward:risk floor and a model-confidence minimum are hard", () => {
  const venueRules = { source: "simulator_oms", requireTakeProfit: true, minRewardRiskRatio: 1.2, minAiConfidence: 70 };
  assert.equal(discipline(intent({ takeProfit: null }), ctx({ venueRules })).r.outcome, "BLOCK");
  assert.equal(discipline(intent({ takeProfit: 1.103 }), ctx({ venueRules })).r.outcome, "BLOCK", "R:R ≈ 0.6");
  assert.equal(discipline(intent({ origin: "ruby", aiConfidence: 60 }), ctx({ venueRules })).r.outcome, "BLOCK");
  assert.equal(discipline(intent({ origin: "ruby", aiConfidence: 80 }), ctx({ venueRules })).r.outcome, "PASS");
  assert.equal(discipline(intent({ origin: "manual" }), ctx({ venueRules })).r.outcome, "PASS", "confidence floor is for model origins");
});

test("risk-reducing actions are never refused by the trader's rules", () => {
  const c = ctx({ activity: act({ tradesToday: 99, consecutiveLosses: 9 }) });
  for (const action of ["CLOSE", "PARTIAL_CLOSE"] as const) {
    const { d, r } = discipline(intent({ action }), c);
    assert.equal(r.outcome, "NOT_APPLICABLE", action);
    assert.equal(d.decision, "ALLOW", action);
  }
});

test("override: paper only, a written reason, and only when the trader's rules alone block", () => {
  const blocked = (i: TradeIntent, c: RiskContext) => ({ i, c, d: evaluatePreTradeRisk(i, c) });
  const paper = blocked(intent({ venue: "PAPER" }), ctx({ activity: act({ tradesToday: 5 }) }));
  assert.deepEqual(paper.d.blockedBy, ["trading_discipline"]);
  assert.equal(overrideApplies(paper.i, paper.d, paper.c.limits, { reason: "Planned scalp, logged" }), true);
  assert.equal(overrideApplies(paper.i, paper.d, paper.c.limits, { reason: "ok" }), false, "reason too short");
  assert.equal(overrideApplies(paper.i, paper.d, paper.c.limits, null), false);

  const live = blocked(intent({ venue: "LIVE" }), ctx({ activity: act({ tradesToday: 5 }) }));
  assert.equal(overrideApplies(live.i, live.d, live.c.limits, { reason: "Planned scalp, logged" }), false, "never on LIVE");

  const exposure = blocked(intent({ venue: "PAPER", stopLoss: null }), ctx({ activity: act({ tradesToday: 5 }) }));
  assert.ok(exposure.d.blockedBy.includes("stop_loss_required"));
  assert.equal(overrideApplies(exposure.i, exposure.d, exposure.c.limits, { reason: "Planned scalp, logged" }), false,
    "an exposure rule can never be overridden");

  const optedOut = resolveEffectiveLimits({ userSettings: { ...baseUser(), allowOverrideInPaperMode: false } });
  const off = blocked(intent({ venue: "PAPER" }), ctx({ limits: optedOut, activity: act({ tradesToday: 5 }) }));
  assert.equal(overrideApplies(off.i, off.d, off.c.limits, { reason: "Planned scalp, logged" }), false);
});

test("summarizeActivity: UTC day count, week P/L, loss streak and the last-hour patterns", () => {
  const m = (min: number) => new Date(NOW.getTime() - min * 60_000);
  const a = summarizeActivity([
    { closedAt: m(5), pnl: -10 },
    { closedAt: m(20), pnl: -20 },
    { closedAt: m(40), pnl: 30 },
    { closedAt: new Date("2026-10-22T23:00:00Z"), pnl: -40 }, // yesterday (UTC)
    { closedAt: new Date("2026-10-10T10:00:00Z"), pnl: -500 }, // outside the week
  ], 2, NOW, "test");
  assert.equal(a.tradesToday, 5, "2 still open + 3 closed today");
  assert.equal(a.weekRealizedPnl, -40);
  assert.equal(a.consecutiveLosses, 2);
  assert.equal(a.lastClosedWasLoss, true);
  assert.equal(a.closesInLastHour, 3);
  assert.equal(a.reentriesAfterLossInLastHour, 2, "the closes 5 and 40 min ago each followed a loss");
});

function baseUser() {
  return {
    maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null, maxDailyLossPercent: 3, maxDailyLossAmount: null,
    maxOpenTrades: 3, maxPositionSize: null, blockAfterDailyLossHit: true, requireStopLoss: true,
  };
}
