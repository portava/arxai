// Truth regression: Ruby's getPropFirmModeStatus said it mirrored
// POST /prop-challenges/:id/evaluate, but it checked the rules on the booked
// P&L only, and daily loss on today only. /evaluate (8b2a8eba) checks every
// rule on two complete running balances, each closed trade at its booked P&L
// and each at the paper risk model (price move × lots × 100), fails the
// challenge on a breach on either, and passes it only when both reach the
// target. So for three US30 closes at 0.1 lot, each 40 points down (booked
// -4 each, 0.12% drawdown; -400 each at the model, 12%), Ruby said COMPLIANT
// with 9.88% drawdown left while the next /evaluate wrote a terminal FAILED.
//
// Ruby now runs the same rules (evaluateChallengeRules, the pure function
// /evaluate runs) on the same challenge and orders. It reports each breach in
// /evaluate's words, naming the basis; gives the headroom and target progress
// on the basis closer to failing / further from the target; calls the target
// reached only when both bases reach it; and says what /evaluate would decide
// now.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/assistant/__qa__/rubyPropFirmTwoBasisTruth.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "../../../routes/__qa__/_fakeRouteDb.js";

const DAY = 86_400_000;
type Row = Record<string, unknown>;
const rows: Record<string, unknown[]> = { prop_challenges: [], paper_orders: [] };
const fake = createFakeDb(rows);
const realDb = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });
const realNotify = await import("../../notifications/service.js");
mock.module("../../notifications/service.js", { namedExports: { ...realNotify, notify: async () => undefined } });

const { getPropFirmModeStatus } = await import("../tools.js");
const router = (await import("../../../routes/propChallenges.js")).default;

const MODEL_CLAUSE = "each closed trade counted at the paper risk model, price move × lots × 100";

function challenge(over: Row = {}): Row {
  // Started 10 days less an hour ago, so the day count is 10 throughout.
  const startedAt = new Date(Date.now() - 10 * DAY + 3_600_000);
  return {
    id: 5, userId: 7, paperAccountId: 3, challengeName: "Practice", startingBalance: 10_000,
    profitTarget: 0.08, maxDailyLoss: 0.05, maxTotalDrawdown: 0.10, minTradingDays: 1, maxTradingDays: 30,
    consistencyRulePercent: 1, status: "ACTIVE", failureReason: null, startedAt, completedAt: null,
    updatedAt: startedAt, createdAt: startedAt,
    trailingDrawdownEnabled: 0, trailingDrawdownAmount: 0.05, trailingDrawdownType: "STATIC",
    maxRiskPerTrade: 1, maxOpenTrades: 100, maxPendingOrders: 100, maxPositionSize: 100,
    newsTradingAllowed: 1, weekendHoldingAllowed: 1, overnightHoldingAllowed: 1, strictGuardrailsEnabled: 0,
    ...over,
  };
}
let nextId = 1;
function close(daysAgo: number, o: Row): Row {
  const now = Date.now();
  return {
    id: nextId++, userId: 7, paperAccountId: 3, status: "CLOSED_TP", direction: "BUY",
    symbol: "US30", lotSize: 0.1, entryPrice: 40_000, exitPrice: 40_000, profitLoss: 0,
    openedAt: new Date(now - (daysAgo * DAY + 60_000)), closedAt: new Date(now - daysAgo * DAY), ...o,
  };
}
function setBook(ch: Row, orders: Row[]): void {
  rows.prop_challenges = [ch];
  rows.paper_orders = orders;
}

async function evaluateNow(): Promise<Record<string, any>> {
  let body: Record<string, any> = {};
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/prop-challenges/5/evaluate`, { method: "POST" });
    body = await r.json() as Record<string, any>;
    assert.equal(r.status, 200, JSON.stringify(body));
  });
  return body;
}

test("the finding's US30 book: /evaluate FAILS it on the model basis, so Ruby says VIOLATION with /evaluate's words, not COMPLIANT", async () => {
  // Three US30 BUYs at 0.1 lot, each closed 40 points down: booked -4, model -400.
  setBook(challenge(), [3, 2, 1].map((d) => close(d, { entryPrice: 40_000, exitPrice: 39_960, profitLoss: -4, status: "CLOSED_SL" })));
  const ruby = await getPropFirmModeStatus(7) as Record<string, any>;
  const page = await evaluateNow();

  assert.equal(page.summary.status, "FAILED");
  assert.equal(page.summary.failureReason, `Max total drawdown exceeded (${MODEL_CLAUSE})`);

  assert.equal(ruby.ruleStatus, "VIOLATION", "was COMPLIANT while /evaluate fails the challenge");
  assert.equal(ruby.canTakeNewTrade, false);
  const dd = (ruby.violations as string[]).find((m) => m.startsWith("Closed-trade drawdown "));
  assert.ok(dd, JSON.stringify(ruby.violations));
  assert.match(dd, /^Closed-trade drawdown 12\.00% exceeds limit 10\.00% on \d{4}-\d{2}-\d{2} \(each closed trade counted at the paper risk model/);
  assert.ok((page.violations as Array<{ message: string }>).some((v) => v.message === dd), "Ruby gives /evaluate's own words and basis clause");

  // The booked figures shown stay booked; the headroom is the basis closer to failing.
  assert.ok(Math.abs(ruby.progress.maxDrawdownPct - 0.0012) < 1e-9);
  assert.equal(ruby.progress.totalDrawdownRemainingPct, 0, "was 9.88% on the booked figure alone");
  const [booked, model] = ruby.ruleBasis.bases as Array<Record<string, any>>;
  assert.equal(booked.basis, "BOOKED");
  assert.equal(model.basis, "PAPER_RISK_MODEL");
  assert.ok(Math.abs(booked.maxDrawdownPct - 0.0012) < 1e-9);
  assert.ok(Math.abs(model.maxDrawdownPct - 0.12) < 1e-9);
  assert.equal(ruby.ruleBasis.note, page.summary.ruleBasisNote);

  assert.equal(ruby.evaluationPreview.resolvedStatus, "FAILED");
  assert.equal(ruby.evaluationPreview.failureReason, page.summary.failureReason);
});

test("an FX book whose booked profit reaches the target but the model's does not: target not reached, with /evaluate's reason", async () => {
  // EURUSD +10 pips at 0.5 lot: booked +50 (0.50%), model 0.001 × 0.5 × 100 = +0.05.
  setBook(challenge({ profitTarget: 0.004 }), [
    close(1, { symbol: "EURUSD", lotSize: 0.5, entryPrice: 1.1, exitPrice: 1.101, profitLoss: 50 }),
  ]);
  const ruby = await getPropFirmModeStatus(7) as Record<string, any>;
  const page = await evaluateNow();

  assert.equal(page.summary.status, "ACTIVE");
  assert.match(String(page.summary.passBlockedReason), /below the 0\.40% target/);

  assert.equal(ruby.ruleStatus, "COMPLIANT", "no rule is breached, and /evaluate does not fail it");
  assert.equal(ruby.progress.totalPnl, 50, "the booked figure shown");
  assert.equal(ruby.progress.profitTargetReached, false, "was true: a pass needs both bases to reach the target");
  const [booked, model] = ruby.ruleBasis.bases as Array<Record<string, any>>;
  assert.equal(booked.profitTargetReached, true);
  assert.equal(model.profitTargetReached, false);
  assert.ok(ruby.progress.profitTargetProgressPct < 0.01, `progress is on the basis further from the target: ${ruby.progress.profitTargetProgressPct}`);
  assert.equal(ruby.evaluationPreview.resolvedStatus, "ACTIVE");
  assert.equal(ruby.evaluationPreview.passBlockedReason, page.summary.passBlockedReason);
});

test("a daily-loss breach on an earlier day fails the challenge, so Ruby reports it (it checked today only)", async () => {
  // No exit prices: both bases count each trade the same, so no basis clause.
  setBook(challenge(), [
    close(2, { exitPrice: null, profitLoss: -600, status: "CLOSED_SL" }),
    close(1, { exitPrice: null, profitLoss: 700 }),
  ]);
  const ruby = await getPropFirmModeStatus(7) as Record<string, any>;
  const page = await evaluateNow();

  assert.equal(page.summary.status, "FAILED");
  assert.equal(page.summary.failureReason, "Daily loss limit exceeded");
  assert.equal(ruby.ruleStatus, "VIOLATION", "was COMPLIANT: only today's loss was checked");
  const daily = (ruby.violations as string[]).find((m) => m.startsWith("Closed-trade daily loss "));
  assert.ok(daily, JSON.stringify(ruby.violations));
  assert.match(daily, /^Closed-trade daily loss 6\.00% on \d{4}-\d{2}-\d{2} exceeds limit 5\.00%$/);
  assert.ok((page.violations as Array<{ message: string }>).some((v) => v.message === daily));
  assert.equal(ruby.progress.dailyLossUsedPct, 0, "no trade closed today");
});

test("a challenge past its day limit with no closed trades is a violation /evaluate fails, not INSUFFICIENT_DATA", async () => {
  setBook(challenge({ startedAt: new Date(Date.now() - 40 * DAY + 3_600_000), maxTradingDays: 30 }), []);
  const ruby = await getPropFirmModeStatus(7) as Record<string, any>;
  const page = await evaluateNow();

  assert.equal(page.summary.status, "FAILED");
  assert.equal(page.summary.failureReason, "Max trading days exceeded");
  assert.equal(ruby.ruleStatus, "VIOLATION", "was INSUFFICIENT_DATA, which the prompt answers with 'no closed paper trades yet' and stops");
  assert.ok((ruby.violations as string[]).some((m) => /^Day 40 > maxTradingDays 30/.test(m)), JSON.stringify(ruby.violations));
  assert.equal(ruby.hasSufficientData, false);
  assert.doesNotMatch(String(ruby.note), /INSUFFICIENT_DATA/);
});

// Round-3 safety review (s3-views): /evaluate raises the HARD drawdown message
// on every walk day after a breach (it checks the running maximum), each
// dated that day. Ruby kept only the last walk day's copy, so it dated a
// breach to the last trading day, even when the drawdown that day was 0%.
// It now dates each basis's maximum drawdown to the day it was reached, and
// gives the day the limit was first exceeded when that is earlier, in
// /evaluate's own words.
const dayKey = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);

test("the finding's book: a 12% model drawdown on one day, a new peak since, a small close last: Ruby dates the breach to the day it happened", async () => {
  setBook(challenge(), [
    // US30 0.1 lot, 120 points down: booked -12, model -1,200 (12%).
    close(8, { entryPrice: 40_000, exitPrice: 39_880, profitLoss: -12, status: "CLOSED_SL" }),
    // US30 0.1 lot, 150 points up: booked +15, model +1,500, a new model peak (10,300).
    close(5, { entryPrice: 40_000, exitPrice: 40_150, profitLoss: 15 }),
    // A small EURUSD close: booked +1, model 0.001.
    close(1, { symbol: "EURUSD", lotSize: 0.01, entryPrice: 1.1, exitPrice: 1.101, profitLoss: 1 }),
  ]);
  const ruby = await getPropFirmModeStatus(7) as Record<string, any>;
  const page = await evaluateNow();
  assert.equal(page.summary.status, "FAILED");
  const dd = (ruby.violations as string[]).filter((m) => m.startsWith("Closed-trade drawdown "));
  assert.equal(dd.length, 1, JSON.stringify(ruby.violations));
  assert.equal(dd[0], `Closed-trade drawdown 12.00% exceeds limit 10.00% on ${dayKey(8)} (${MODEL_CLAUSE})`,
    `was dated ${dayKey(1)}, the last trading day, when the model drawdown was 0%`);
  assert.ok(!(ruby.canTakeNewTradeReasons as string[]).some((m) => m.includes(`exceeds limit 10.00% on ${dayKey(1)}`)));
  assert.ok((page.violations as Array<{ message: string }>).some((v) => v.message === dd[0]), "still /evaluate's own words");
  assert.equal(ruby.ruleStatus, "VIOLATION");
  assert.equal(ruby.canTakeNewTrade, false);
});

test("a drawdown that deepened after the first breach: Ruby gives the day the limit was first exceeded and the day the maximum was reached", async () => {
  setBook(challenge({ maxDailyLoss: 0.5 }), [
    // US30 0.1 lot, 105 points down: model -1,050 (10.5%).
    close(8, { entryPrice: 40_000, exitPrice: 39_895, profitLoss: -10.5, status: "CLOSED_SL" }),
    // 35 points more: model balance 8,600 (14%).
    close(5, { entryPrice: 40_000, exitPrice: 39_965, profitLoss: -3.5, status: "CLOSED_SL" }),
    close(1, { symbol: "EURUSD", lotSize: 0.01, entryPrice: 1.1, exitPrice: 1.101, profitLoss: 1 }),
  ]);
  const ruby = await getPropFirmModeStatus(7) as Record<string, any>;
  const page = await evaluateNow();
  const dd = (ruby.violations as string[]).filter((m) => m.startsWith("Closed-trade drawdown "));
  assert.deepEqual(dd, [
    `Closed-trade drawdown 10.50% exceeds limit 10.00% on ${dayKey(8)} (${MODEL_CLAUSE})`,
    `Closed-trade drawdown 14.00% exceeds limit 10.00% on ${dayKey(5)} (${MODEL_CLAUSE})`,
  ]);
  const pageMessages = new Set((page.violations as Array<{ message: string }>).map((v) => v.message));
  for (const m of dd) assert.ok(pageMessages.has(m), m);
});

// Fourth safety review (s4-views): when both bases are at the same drawdown,
// /evaluate reports it once, with the "both" clause; once they diverge it
// reports each basis with its own clause. Ruby matched earlier messages only
// on an identical clause, so a breach first reported for both bases was never
// found: it dated the model's maximum to the last trading day (a day the
// model drawdown was falling) and never said when the booked breach began.
const BOOKED_CLAUSE = "each closed trade counted at its booked P&L";
const BOTH_CLAUSE = "both with each closed trade counted at its booked P&L and with each counted at the paper risk model, price move × lots × 100";

test("a drawdown breach first reported for both bases, then diverging: Ruby dates each basis's breach and maximum to when they happened", async () => {
  setBook(challenge({ maxDailyLoss: 0.5 }), [
    // XAUUSD 1 lot, 12 points down: -1,200 booked and at the model (contract size 100), 12% on both.
    close(8, { symbol: "XAUUSD", lotSize: 1, entryPrice: 2_400, exitPrice: 2_388, profitLoss: -1_200, status: "CLOSED_SL" }),
    // Last trading day: XAUUSD +1 point (+100 on both), and EURUSD 1 lot 40
    // pips down (booked -400, model -0.4). Booked balance 8,500 (15%); the
    // model balance rises to 8,899.60, so its maximum stays the 12% of day 8.
    close(1, { symbol: "XAUUSD", lotSize: 1, entryPrice: 2_400, exitPrice: 2_401, profitLoss: 100 }),
    close(1, { symbol: "EURUSD", lotSize: 1, entryPrice: 1.1, exitPrice: 1.096, profitLoss: -400, status: "CLOSED_SL" }),
  ]);
  const ruby = await getPropFirmModeStatus(7) as Record<string, any>;
  const page = await evaluateNow();
  assert.equal(page.summary.status, "FAILED");
  const pageMessages = new Set((page.violations as Array<{ message: string }>).map((v) => v.message));
  const bothDay8 = `Closed-trade drawdown 12.00% exceeds limit 10.00% on ${dayKey(8)} (${BOTH_CLAUSE})`;
  const bookedDay1 = `Closed-trade drawdown 15.00% exceeds limit 10.00% on ${dayKey(1)} (${BOOKED_CLAUSE})`;
  const modelDay1 = `Closed-trade drawdown 12.00% exceeds limit 10.00% on ${dayKey(1)} (${MODEL_CLAUSE})`;
  // /evaluate's own messages for this book.
  for (const m of [bothDay8, bookedDay1, modelDay1]) assert.ok(pageMessages.has(m), m);

  const dd = (ruby.violations as string[]).filter((m) => m.startsWith("Closed-trade drawdown "));
  assert.deepEqual(dd, [bothDay8, bookedDay1],
    "the limit was first exceeded on day 8 on both bases; the booked 15% was reached on day 1; the model's 12% on day 8");
  assert.ok(!dd.includes(modelDay1), `dated the model's 12% maximum to ${dayKey(1)}, a day its drawdown fell to 11.00%`);
  assert.ok(!(ruby.canTakeNewTradeReasons as string[]).includes(modelDay1));
  for (const m of dd) assert.ok(pageMessages.has(m), "still /evaluate's own words");
  assert.equal(ruby.ruleStatus, "VIOLATION");
  assert.equal(ruby.canTakeNewTrade, false);
});

// Deterministic PRNG so a failure reproduces.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test("property: on random books Ruby never reports a status /evaluate contradicts", async () => {
  const r = rng(20261103);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const symbols = [
    { symbol: "US30", entry: 40_000, step: 25, contract: 1 },
    { symbol: "EURUSD", entry: 1.1, step: 0.0015, contract: 100_000 },
    { symbol: "XAUUSD", entry: 2_400, step: 4, contract: 100 },
  ] as const;
  await withRouter(router, { id: 7 }, async (base) => {
    for (let i = 0; i < 150; i++) {
      const ch = challenge({
        profitTarget: pick([0.002, 0.01, 0.05, 0.1]),
        maxDailyLoss: pick([0.01, 0.03, 0.05]),
        maxTotalDrawdown: pick([0.02, 0.06, 0.1]),
        minTradingDays: pick([1, 2, 3]),
        maxTradingDays: pick([5, 30]),
        consistencyRulePercent: pick([0.3, 0.6, 1]),
        maxRiskPerTrade: pick([0.005, 0.02, 1]),
        trailingDrawdownEnabled: pick([0, 1]),
        trailingDrawdownType: pick(["STATIC", "TRAILING"]),
        trailingDrawdownAmount: pick([0.02, 0.05]),
        strictGuardrailsEnabled: pick([0, 1]),
      });
      const orders: Row[] = [];
      const n = Math.floor(r() * 7);
      for (let k = 0; k < n; k++) {
        const s = pick(symbols);
        const lotSize = pick([0.01, 0.1, 0.5, 1]);
        const direction = pick(["BUY", "SELL"]);
        const move = (r() * 2 - 1) * s.step * 4;
        const exitPrice = s.entry + move;
        const booked = (direction === "SELL" ? -1 : 1) * move * lotSize * s.contract;
        const kind = r();
        orders.push(close(Math.floor(r() * 9), {
          symbol: s.symbol, direction, lotSize, entryPrice: s.entry,
          // Some closes have no exit price recorded, and some could not be sized (stored 0).
          exitPrice: kind < 0.15 ? null : exitPrice,
          profitLoss: kind >= 0.15 && kind < 0.25 ? 0 : Math.round(booked * 100) / 100,
          status: booked < 0 ? "CLOSED_SL" : "CLOSED_TP",
        }));
      }
      setBook(ch, orders);
      const ruby = await getPropFirmModeStatus(7) as Record<string, any>;
      const res = await fetch(`${base}/prop-challenges/5/evaluate`, { method: "POST" });
      const page = await res.json() as Record<string, any>;
      const ctx = () => JSON.stringify({ i, ch, orders, ruby: { ruleStatus: ruby.ruleStatus, violations: ruby.violations, warnings: ruby.warnings }, page: page.summary }).slice(0, 4000);

      assert.equal(ruby.evaluationPreview?.resolvedStatus, page.summary.status, ctx());
      if (page.summary.status === "FAILED") {
        assert.ok(ruby.ruleStatus === "VIOLATION" || ruby.ruleStatus === "BLOCKED", `Ruby said ${ruby.ruleStatus} where /evaluate FAILS: ${ctx()}`);
        assert.equal(ruby.canTakeNewTrade, false, ctx());
      }
      if (ruby.progress?.profitTargetReached) {
        const target = ch.profitTarget as number;
        assert.ok(page.summary.totalPct >= target && page.summary.ruleBasis.totalPct >= target, ctx());
      }
      // Every two-basis rule message Ruby gives is /evaluate's own, word for word.
      const pageMessages = new Set((page.violations as Array<{ message: string }>).map((v) => v.message));
      for (const m of [...ruby.violations, ...ruby.warnings] as string[]) {
        if (/^Closed-trade |^Single best day|^Trade #\d+ realised loss/.test(m)) assert.ok(pageMessages.has(m), `${m} :: ${ctx()}`);
      }
    }
  });
});
