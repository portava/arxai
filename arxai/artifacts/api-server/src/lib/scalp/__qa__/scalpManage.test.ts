// Unit tests for the manage-side scalp pure module. Run via:
//   node --import tsx --test src/lib/scalp/__qa__/scalpManage.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:scalp-manage`)
//
// These are pure-function tests — no DB, no network. They lock in the
// add-on permission ladder, the revenge guard, the exit-urgency monitor,
// the basket aggregates, and the lockout helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupLegsIntoBaskets,
  summarizeBasket,
  evaluateAddOn,
  evaluateExitUrgency,
  assembleBasket,
  isLockoutActive,
  lockoutDirectionKey,
  FAILED_FLAME_LOCKOUT_MS,
  type OpenPositionInput,
} from "../scalpManage.js";
import type { ScalpFlameRead, ScalpBasketLeg } from "../scalpTypes.js";

// A healthy, strong, fresh flame in the BUY direction with clean timing.
function strongFlame(over: Partial<ScalpFlameRead> = {}): ScalpFlameRead {
  return {
    scalpStatus: "STRONG",
    readDirection: "BUY",
    scalpScore: 82,
    flameStage: "ACTIVE",
    flameAgeCandles: 2,
    freshness: "FRESH",
    entryTiming: "CLEAN",
    chaseRisk: "LOW",
    runway: "CLEAR",
    executionQuality: "GOOD",
    htfContext: "ALIGNED",
    setupType: "CONTINUATION",
    riskPersonality: "BALANCED",
    whyNow: "Fresh burst with room to run",
    entryTrigger: "Break and hold",
    targetIdea: "Next level up",
    invalidationIdea: "Loss of the low",
    decayNote: null,
    blind: false,
    ...over,
  };
}

function leg(over: Partial<ScalpBasketLeg> = {}): ScalpBasketLeg {
  return {
    ticket: "1",
    volume: 1,
    entryPrice: 100,
    currentPrice: 101,
    floatingPl: 10,
    stopLoss: 95,
    takeProfit: 110,
    openedAt: "2026-06-03T00:00:00.000Z",
    isLatest: false,
    ...over,
  };
}

function pos(over: Partial<OpenPositionInput> = {}): OpenPositionInput {
  return {
    ticket: "1",
    symbol: "EURUSD",
    displayName: "Euro / US Dollar",
    side: "BUY",
    volume: 1,
    entryPrice: 1.1,
    currentPrice: 1.11,
    floatingPl: 10,
    stopLoss: 1.09,
    takeProfit: 1.12,
    openedAt: "2026-06-03T00:00:00.000Z",
    accountMode: "DEMO",
    ...over,
  };
}

// ── groupLegsIntoBaskets ───────────────────────────────────────────────────

test("groups same symbol+direction into one basket, splits opposite sides", () => {
  const groups = groupLegsIntoBaskets([
    pos({ ticket: "1", side: "BUY", openedAt: "2026-06-03T00:00:00.000Z" }),
    pos({ ticket: "2", side: "BUY", openedAt: "2026-06-03T00:01:00.000Z" }),
    pos({ ticket: "3", side: "SELL" }),
  ]);
  assert.equal(groups.length, 2);
  const buy = groups.find((g) => g.direction === "BUY")!;
  assert.equal(buy.legs.length, 2);
  // Latest leg flagged by openedAt order.
  assert.equal(buy.legs[buy.legs.length - 1]!.ticket, "2");
  assert.equal(buy.legs[buy.legs.length - 1]!.isLatest, true);
});

test("drops legs with no direction, no entry, or non-positive volume", () => {
  const groups = groupLegsIntoBaskets([
    pos({ side: null }),
    pos({ entryPrice: null }),
    pos({ volume: 0 }),
    pos({ side: "LONG" }), // LONG normalizes to BUY
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.direction, "BUY");
  assert.equal(groups[0]!.legs.length, 1);
});

// ── summarizeBasket ────────────────────────────────────────────────────────

test("volume-weighted average entry and combined P/L", () => {
  const s = summarizeBasket([
    leg({ volume: 1, entryPrice: 100, floatingPl: 5 }),
    leg({ volume: 3, entryPrice: 104, floatingPl: 15 }),
  ]);
  assert.equal(s.entryCount, 2);
  assert.equal(s.totalVolume, 4);
  assert.equal(s.averageEntry, (100 * 1 + 104 * 3) / 4);
  assert.equal(s.combinedFloatingPl, 20);
  assert.equal(s.hasUnprotectedLeg, false);
});

test("flags an unprotected leg and keeps P/L null when fully unknown", () => {
  const s = summarizeBasket([
    leg({ stopLoss: null, floatingPl: null }),
    leg({ stopLoss: 95, floatingPl: null }),
  ]);
  assert.equal(s.hasUnprotectedLeg, true);
  assert.equal(s.combinedFloatingPl, null);
});

// ── evaluateAddOn ──────────────────────────────────────────────────────────

test("strong flame in profit allows adds (ADD_OK)", () => {
  const summary = summarizeBasket([leg({ floatingPl: 20 })]);
  const v = evaluateAddOn(strongFlame(), summary, "BALANCED");
  assert.equal(v.recommendation, "ADD_OK");
  assert.ok(v.maxAddOns >= 1);
  assert.equal(v.allowed, true);
  assert.equal(v.revengeGuardTriggered, false);
});

test("revenge guard blocks adding to a loser without a fresh restart", () => {
  const summary = summarizeBasket([leg({ floatingPl: -30 })]);
  // Flame still alive (LATE timing keeps tier > 0) but underwater and NOT a
  // fresh confirmation → revenge guard fires and refuses the add.
  const v = evaluateAddOn(strongFlame({ entryTiming: "LATE" }), summary, "BALANCED");
  assert.equal(v.recommendation, "DO_NOT_ADD");
  assert.equal(v.revengeGuardTriggered, true);
  assert.equal(v.allowed, false);
});

test("revenge guard permits ONE cautious add on a fresh restart while underwater", () => {
  const summary = summarizeBasket([leg({ floatingPl: -10 })]);
  const v = evaluateAddOn(strongFlame({ entryTiming: "EARLY" }), summary, "BALANCED");
  assert.equal(v.revengeGuardTriggered, true);
  assert.equal(v.requiresFreshConfirmation, true);
  assert.equal(v.recommendation, "ADD_WITH_CAUTION");
  assert.equal(v.maxAddOns, 1);
});

test("dead flame → DO_NOT_ADD; blind flame → HOLD", () => {
  const summary = summarizeBasket([leg({ floatingPl: 5 })]);
  assert.equal(evaluateAddOn(strongFlame({ flameStage: "EXHAUSTED" }), summary).recommendation, "DO_NOT_ADD");
  const blind = evaluateAddOn(strongFlame({ blind: true }), summary);
  assert.equal(blind.recommendation, "HOLD");
  assert.equal(blind.maxAddOns, 0);
  assert.equal(blind.requiresFreshConfirmation, true);
});

test("used adds count from entries; remaining never goes negative", () => {
  const summary = summarizeBasket([leg(), leg(), leg(), leg()]); // 4 entries -> 3 used
  const v = evaluateAddOn(strongFlame(), summary, "CONSERVATIVE");
  assert.equal(v.usedAddOns, 3);
  assert.ok(v.remainingAddOns >= 0);
});

// ── evaluateExitUrgency ────────────────────────────────────────────────────

test("failed flame while losing → EMERGENCY / CLOSE_ALL, alert-only", () => {
  const summary = summarizeBasket([leg({ floatingPl: -50 })]);
  const v = evaluateExitUrgency(strongFlame({ flameStage: "FAILED" }), summary);
  assert.equal(v.urgency, "EMERGENCY");
  assert.equal(v.action, "CLOSE_ALL");
  assert.equal(v.alertOnly, true);
});

test("weakening + in profit + multi-leg → CLOSE_PARTIAL", () => {
  const summary = summarizeBasket([leg({ floatingPl: 20 }), leg({ floatingPl: 15 })]);
  const v = evaluateExitUrgency(strongFlame({ flameStage: "WEAKENING" }), summary);
  assert.equal(v.urgency, "CLOSE_PARTIAL");
});

test("healthy fresh flame → NONE; never closes anything", () => {
  const summary = summarizeBasket([leg({ floatingPl: 10 })]);
  const v = evaluateExitUrgency(strongFlame(), summary);
  assert.equal(v.urgency, "NONE");
  assert.equal(v.action, "HOLD");
  assert.equal(v.alertOnly, true);
});

test("blind flame → WATCH (manage manually), never auto-acts", () => {
  const summary = summarizeBasket([leg()]);
  const v = evaluateExitUrgency(strongFlame({ blind: true }), summary);
  assert.equal(v.urgency, "WATCH");
  assert.equal(v.alertOnly, true);
});

// ── assembleBasket ─────────────────────────────────────────────────────────

test("assembleBasket carries direction, aggregates, flame, exit and add-on", () => {
  const [group] = groupLegsIntoBaskets([
    pos({ ticket: "1", floatingPl: 10 }),
    pos({ ticket: "2", floatingPl: 5, openedAt: "2026-06-03T00:02:00.000Z" }),
  ]);
  const b = assembleBasket(group!, strongFlame(), { now: 1_780_000_000_000 });
  assert.equal(b.symbol, "EURUSD");
  assert.equal(b.direction, "BUY");
  assert.equal(b.entryCount, 2);
  assert.equal(b.combinedFloatingPl, 15);
  assert.ok(b.exit);
  assert.ok(b.addOn);
  assert.equal(b.flame.scalpStatus, "STRONG");
});

// ── lockout helpers ────────────────────────────────────────────────────────

test("lockout key is symbol|direction; active only while in the future", () => {
  assert.equal(lockoutDirectionKey("EURUSD", "BUY"), "EURUSD|BUY");
  const now = 1_780_000_000_000;
  assert.equal(isLockoutActive(new Date(now + FAILED_FLAME_LOCKOUT_MS), now), true);
  assert.equal(isLockoutActive(new Date(now - 1), now), false);
  assert.equal(isLockoutActive(null, now), false);
});
