// Phase 6 — Personal Trading Constitution certification.
//
// Covers the owner's Constitution checks 1-5: default restrictions fail closed,
// a server rule beats a client rule, another user's constitution cannot
// authorize the account, and the loss/trade/exposure ceilings enforce.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateConstitution, constitutionIsWellFormed, tightenConstitution,
  RUBY_AUTHORITY_LEVELS,
  type TradingConstitution, type ConstitutionProposal, type ConstitutionObservedState,
} from "@workspace/domain/safety-contracts/tradingConstitution";

// A Wednesday 12:00 UTC. 2026-08-26 is a Wednesday (getUTCDay() === 3).
const NOW = "2026-08-26T12:00:00.000Z";

const CONSTITUTION: TradingConstitution = {
  constitutionId: "con_test", userId: 7, version: 3,
  allowedBrokers: ["deriv"], allowedAccountRefs: ["VRTC1234"],
  allowedInstruments: ["R_100"], allowedMarketCategories: ["synthetic_indices"],
  allowedSessionsUtc: [{ daysOfWeekUtc: [1, 2, 3, 4, 5], openMinuteUtc: 0, closeMinuteUtc: 1440 }],
  maxRiskPerTradeUsd: 5, maxDailyLossUsd: 20, maxWeeklyLossUsd: 50,
  maxSimultaneousPositions: 2, maxExposurePerSymbolUsd: 10, maxTradesPerDay: 3,
  requireStopLoss: true, requireTakeProfit: false,
  minStakeUsd: 1, maxStakeUsd: 5, minMultiplier: 100, maxMultiplier: 400,
  lossStreakCooldown: { losses: 2, cooldownMinutes: 60 },
  forbiddenInstruments: ["R_10"], forbiddenConditions: ["HIGH_IMPACT_NEWS_WINDOW"],
  rubyAuthority: "PREPARE_TICKET",
};

const PROPOSAL: ConstitutionProposal = {
  userId: 7, broker: "deriv", accountRef: "VRTC1234",
  instrument: "R_100", marketCategory: "synthetic_indices", side: "BUY",
  stakeUsd: 1, multiplier: 100, riskUsd: 1,
  hasStopLoss: true, hasTakeProfit: true, conditions: [],
};

const OBSERVED: ConstitutionObservedState = {
  nowIso: NOW, realisedDailyLossUsd: 0, realisedWeeklyLossUsd: 0,
  openPositionCount: 0, openExposureForSymbolUsd: 0, tradesTakenToday: 0,
  consecutiveLosses: 0, lastLossAtIso: null,
};

const permit = (c = CONSTITUTION, p = PROPOSAL, o = OBSERVED) => evaluateConstitution(c, p, o);

test("baseline: a fully compliant proposal is PERMITted", () => {
  const v = permit();
  assert.equal(v.decision, "PERMIT", `refused: ${v.refusals.join(",")}`);
  assert.equal(v.constitutionVersion, 3, "the governing version must be reported");
});

// ── 1. default restrictions fail closed ────────────────────────────────────
test("a MISSING constitution refuses — absence is never permission", () => {
  for (const missing of [null, undefined]) {
    const v = evaluateConstitution(missing, PROPOSAL, OBSERVED);
    assert.equal(v.decision, "REFUSE");
    assert.equal(v.primaryRefusal, "CONSTITUTION_MISSING");
  }
});

test("an ABSENT ceiling refuses rather than meaning 'unlimited'", () => {
  // The inversion that matters: a config layer would read a missing max as
  // "no cap". Here every missing ceiling must deny.
  for (const key of ["maxRiskPerTradeUsd", "maxDailyLossUsd", "maxSimultaneousPositions",
                     "maxExposurePerSymbolUsd", "maxTradesPerDay", "maxStakeUsd"] as const) {
    const broken = { ...CONSTITUTION } as Record<string, unknown>;
    delete broken[key];
    const v = evaluateConstitution(broken as unknown as TradingConstitution, PROPOSAL, OBSERVED);
    assert.equal(v.decision, "REFUSE", `missing ${key} did not refuse`);
    assert.equal(v.primaryRefusal, "CONSTITUTION_MALFORMED", `missing ${key}`);
  }
});

test("a NULL weekly cap refuses — 'not configured' is not 'unlimited'", () => {
  const v = permit({ ...CONSTITUTION, maxWeeklyLossUsd: null });
  assert.equal(v.decision, "REFUSE");
  assert.ok(v.refusals.includes("CONSTITUTION_MALFORMED"));
});

test("NO configured session means NO permitted time, not any time", () => {
  const v = permit({ ...CONSTITUTION, allowedSessionsUtc: [] });
  assert.equal(v.decision, "REFUSE");
  assert.ok(v.refusals.includes("OUTSIDE_TRADING_SESSION"));
});

test("an unreadable observed state refuses — a blown account must not trade on", () => {
  // Treating an unreadable daily loss as 0 would let a blown account keep going.
  for (const key of ["realisedDailyLossUsd", "openPositionCount", "tradesTakenToday"] as const) {
    const o = { ...OBSERVED, [key]: Number.NaN };
    const v = permit(CONSTITUTION, PROPOSAL, o);
    assert.equal(v.decision, "REFUSE", `NaN ${key} did not refuse`);
    assert.equal(v.primaryRefusal, "CONSTITUTION_MALFORMED");
  }
  assert.equal(permit(CONSTITUTION, PROPOSAL, { ...OBSERVED, nowIso: "not-a-date" }).decision, "REFUSE");
});

// ── 4. another user's constitution cannot authorize the account ────────────
test("a constitution belonging to another user cannot authorize this proposal", () => {
  const v = permit(CONSTITUTION, { ...PROPOSAL, userId: 8 });
  assert.equal(v.decision, "REFUSE");
  assert.ok(v.refusals.includes("USER_MISMATCH"), "user mismatch was not caught");
});

test("broker and account scoping are enforced independently", () => {
  assert.ok(permit(CONSTITUTION, { ...PROPOSAL, broker: "mt5" }).refusals.includes("BROKER_NOT_ALLOWED"));
  assert.ok(permit(CONSTITUTION, { ...PROPOSAL, accountRef: "CR9999" }).refusals.includes("ACCOUNT_NOT_ALLOWED"));
});

// ── 5. loss / trade / exposure ceilings ────────────────────────────────────
test("daily and weekly loss caps refuse AT the cap, not only past it", () => {
  assert.ok(permit(CONSTITUTION, PROPOSAL, { ...OBSERVED, realisedDailyLossUsd: 20 })
    .refusals.includes("DAILY_LOSS_LIMIT_REACHED"), "cap reached exactly must refuse");
  assert.ok(permit(CONSTITUTION, PROPOSAL, { ...OBSERVED, realisedWeeklyLossUsd: 50 })
    .refusals.includes("WEEKLY_LOSS_LIMIT_REACHED"));
});

test("simultaneous positions and daily trade count refuse at the ceiling", () => {
  assert.ok(permit(CONSTITUTION, PROPOSAL, { ...OBSERVED, openPositionCount: 2 })
    .refusals.includes("MAX_SIMULTANEOUS_POSITIONS_REACHED"));
  assert.ok(permit(CONSTITUTION, PROPOSAL, { ...OBSERVED, tradesTakenToday: 3 })
    .refusals.includes("DAILY_TRADE_COUNT_REACHED"));
});

test("symbol exposure counts the NEW stake, not just what is already open", () => {
  // 8 open + 5 new = 13 > 10. Checking only the existing 8 would pass this and
  // every subsequent order while the total breached.
  const v = permit(CONSTITUTION, { ...PROPOSAL, stakeUsd: 5 }, { ...OBSERVED, openExposureForSymbolUsd: 8 });
  assert.ok(v.refusals.includes("SYMBOL_EXPOSURE_EXCEEDED"), "additive exposure was not enforced");
  // And the boundary is inclusive-safe: 5 open + 5 new = 10 is exactly at cap, allowed.
  assert.ok(!permit(CONSTITUTION, { ...PROPOSAL, stakeUsd: 5 }, { ...OBSERVED, openExposureForSymbolUsd: 5 })
    .refusals.includes("SYMBOL_EXPOSURE_EXCEEDED"));
});

test("stake and multiplier bounds refuse on BOTH sides", () => {
  assert.ok(permit(CONSTITUTION, { ...PROPOSAL, stakeUsd: 0.5 }).refusals.includes("STAKE_OUT_OF_BOUNDS"));
  assert.ok(permit(CONSTITUTION, { ...PROPOSAL, stakeUsd: 6 }).refusals.includes("STAKE_OUT_OF_BOUNDS"));
  assert.ok(permit(CONSTITUTION, { ...PROPOSAL, multiplier: 50 }).refusals.includes("MULTIPLIER_OUT_OF_BOUNDS"));
  assert.ok(permit(CONSTITUTION, { ...PROPOSAL, multiplier: 500 }).refusals.includes("MULTIPLIER_OUT_OF_BOUNDS"));
});

test("protection requirements are enforced from the constitution", () => {
  assert.ok(permit(CONSTITUTION, { ...PROPOSAL, hasStopLoss: false }).refusals.includes("STOP_LOSS_REQUIRED"));
  assert.ok(permit({ ...CONSTITUTION, requireTakeProfit: true }, { ...PROPOSAL, hasTakeProfit: false })
    .refusals.includes("TAKE_PROFIT_REQUIRED"));
});

test("forbidden beats allowed when an instrument appears in both lists", () => {
  const c = { ...CONSTITUTION, allowedInstruments: ["R_100", "R_10"], forbiddenInstruments: ["R_10"] };
  const v = permit(c, { ...PROPOSAL, instrument: "R_10" });
  assert.ok(v.refusals.includes("INSTRUMENT_FORBIDDEN"), "forbidden must win over allowed");
});

test("a forbidden condition present at proposal time refuses", () => {
  assert.ok(permit(CONSTITUTION, { ...PROPOSAL, conditions: ["HIGH_IMPACT_NEWS_WINDOW"] })
    .refusals.includes("FORBIDDEN_CONDITION_PRESENT"));
});

test("loss-streak cooldown holds, and an unreadable last-loss time keeps it ON", () => {
  const streak = { ...OBSERVED, consecutiveLosses: 2 };
  // Still inside the 60-minute window.
  assert.ok(permit(CONSTITUTION, PROPOSAL, { ...streak, lastLossAtIso: "2026-08-26T11:30:00.000Z" })
    .refusals.includes("LOSS_STREAK_COOLDOWN_ACTIVE"));
  // Elapsed — released.
  assert.ok(!permit(CONSTITUTION, PROPOSAL, { ...streak, lastLossAtIso: "2026-08-26T10:00:00.000Z" })
    .refusals.includes("LOSS_STREAK_COOLDOWN_ACTIVE"));
  // Unreadable/absent timestamp must NOT release the cooldown.
  for (const bad of [null, "not-a-date"]) {
    assert.ok(permit(CONSTITUTION, PROPOSAL, { ...streak, lastLossAtIso: bad })
      .refusals.includes("LOSS_STREAK_COOLDOWN_ACTIVE"), `lastLossAtIso=${bad} released the cooldown`);
  }
});

test("trading windows are enforced, including a window that wraps midnight", () => {
  const weekend = { ...CONSTITUTION, allowedSessionsUtc: [{ daysOfWeekUtc: [0, 6], openMinuteUtc: 0, closeMinuteUtc: 1440 }] };
  assert.ok(permit(weekend).refusals.includes("OUTSIDE_TRADING_SESSION"), "Wednesday passed a weekend-only window");
  const overnight = { ...CONSTITUTION, allowedSessionsUtc: [{ daysOfWeekUtc: [3], openMinuteUtc: 1320, closeMinuteUtc: 120 }] };
  assert.ok(permit(overnight).refusals.includes("OUTSIDE_TRADING_SESSION"), "12:00 fell inside a 22:00-02:00 window");
  const covering = { ...CONSTITUTION, allowedSessionsUtc: [{ daysOfWeekUtc: [3], openMinuteUtc: 660, closeMinuteUtc: 780 }] };
  assert.equal(permit(covering).decision, "PERMIT", "12:00 was excluded from an 11:00-13:00 window");
});

// ── 2. a server rule beats a client rule (tighten-only composition) ────────
test("a downstream layer can TIGHTEN every ceiling", () => {
  const t = tightenConstitution(CONSTITUTION, { maxRiskPerTradeUsd: 1, maxStakeUsd: 2, maxTradesPerDay: 1 });
  assert.equal(t.maxRiskPerTradeUsd, 1);
  assert.equal(t.maxStakeUsd, 2);
  assert.equal(t.maxTradesPerDay, 1);
});

test("a downstream layer CANNOT weaken any ceiling, allow-list, or requirement", () => {
  const attack = tightenConstitution(CONSTITUTION, {
    maxRiskPerTradeUsd: 1_000_000, maxDailyLossUsd: 1_000_000, maxWeeklyLossUsd: 1_000_000,
    maxSimultaneousPositions: 99, maxExposurePerSymbolUsd: 1_000_000, maxTradesPerDay: 99,
    maxStakeUsd: 1_000_000, maxMultiplier: 100_000, minStakeUsd: 0, minMultiplier: 0,
    allowedBrokers: ["deriv", "mt5", "anything"],
    allowedInstruments: ["R_100", "R_10", "CRASH_1000"],
    allowedAccountRefs: ["VRTC1234", "CR_REAL_MONEY"],
    allowedMarketCategories: ["synthetic_indices", "forex"],
    requireStopLoss: false, requireTakeProfit: false,
    forbiddenInstruments: [], forbiddenConditions: [],
    lossStreakCooldown: { losses: 99, cooldownMinutes: 0 },
  });
  assert.equal(attack.maxRiskPerTradeUsd, 5, "a ceiling was raised");
  assert.equal(attack.maxDailyLossUsd, 20);
  assert.equal(attack.maxWeeklyLossUsd, 50);
  assert.equal(attack.maxSimultaneousPositions, 2);
  assert.equal(attack.maxExposurePerSymbolUsd, 10);
  assert.equal(attack.maxTradesPerDay, 3);
  assert.equal(attack.maxStakeUsd, 5);
  assert.equal(attack.maxMultiplier, 400);
  assert.equal(attack.minStakeUsd, 1, "a floor was lowered");
  assert.equal(attack.minMultiplier, 100);
  assert.deepEqual(attack.allowedBrokers, ["deriv"], "an allow-list was widened");
  assert.deepEqual(attack.allowedAccountRefs, ["VRTC1234"], "a REAL account was added downstream");
  assert.deepEqual(attack.allowedInstruments, ["R_100"]);
  assert.deepEqual(attack.allowedMarketCategories, ["synthetic_indices"]);
  assert.equal(attack.requireStopLoss, true, "a protection requirement was switched off");
  assert.deepEqual(attack.forbiddenInstruments, ["R_10"], "a deny-list was emptied");
  assert.deepEqual(attack.forbiddenConditions, ["HIGH_IMPACT_NEWS_WINDOW"]);
  assert.equal(attack.lossStreakCooldown?.losses, 2, "cooldown trigger was loosened");
  assert.equal(attack.lossStreakCooldown?.cooldownMinutes, 60, "cooldown duration was shortened");
  // Identity and version always come from the base.
  assert.equal(attack.version, 3);
  assert.equal(attack.userId, 7);
});

test("a downstream layer cannot widen the permitted trading session", () => {
  const t = tightenConstitution(CONSTITUTION, {
    allowedSessionsUtc: [{ daysOfWeekUtc: [0, 1, 2, 3, 4, 5, 6], openMinuteUtc: 0, closeMinuteUtc: 1440 }],
  });
  assert.equal(t.allowedSessionsUtc.length, 1);
  assert.deepEqual(t.allowedSessionsUtc[0]!.daysOfWeekUtc, [1, 2, 3, 4, 5], "weekend trading was added downstream");
});

// ── Ruby authority ────────────────────────────────────────────────────────
test("Ruby has no AUTHORIZE rung, and downstream may only reduce authority", () => {
  assert.deepEqual([...RUBY_AUTHORITY_LEVELS], ["EXPLAIN", "RECOMMEND", "PREPARE_TICKET"]);
  assert.ok(!(RUBY_AUTHORITY_LEVELS as readonly string[]).includes("AUTHORIZE"),
    "an AUTHORIZE authority level exists — Ruby could authorize execution");
  assert.equal(tightenConstitution(CONSTITUTION, { rubyAuthority: "EXPLAIN" }).rubyAuthority, "EXPLAIN");
  const raised = tightenConstitution({ ...CONSTITUTION, rubyAuthority: "EXPLAIN" }, { rubyAuthority: "PREPARE_TICKET" });
  assert.equal(raised.rubyAuthority, "EXPLAIN", "downstream raised Ruby's authority");
});

test("a constitution with an unknown authority level is malformed", () => {
  assert.equal(constitutionIsWellFormed({ ...CONSTITUTION, rubyAuthority: "AUTHORIZE" as never }), false);
});

// ── 3. a material change bumps the version that governs ───────────────────
test("the verdict reports the governing version so a ticket can pin it", () => {
  assert.equal(permit({ ...CONSTITUTION, version: 9 }).constitutionVersion, 9);
});
