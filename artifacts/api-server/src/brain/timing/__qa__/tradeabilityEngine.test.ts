// Unit tests for the Tradeability / Edge / Danger / Move-Stage engine. Run via:
//   node --import tsx --test src/brain/timing/__qa__/tradeabilityEngine.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:timing-tradeability`)

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTradeability, type TradeabilityEngineInput } from "../tradeabilityEngine.js";

type C = TradeabilityEngineInput["candles"][number];

function flat(n: number): C[] {
  return Array.from({ length: n }, () => ({ open: 100, high: 100.5, low: 99.5, close: 100 }));
}

function baseInput(over: Partial<TradeabilityEngineInput> = {}): TradeabilityEngineInput {
  return {
    heatScore: 50,
    heatState: "WAKE_UP",
    isFalseHeat: false,
    isQuietBeforeStorm: false,
    atrRatio: 1.5,
    candleBodyRatio: 0.6,
    spread: null,
    mid: null,
    isSynthetic: false,
    sessionTradeabilityBonus: 15,
    fakeoutRisk: 20,
    newsBlocksTrade: false,
    newsPhase: "NONE",
    dangerFromTrap: 0,
    dangerFromBroadFlow: 0,
    candles: flat(20),
    ...over,
  };
}

test("news blocks trade → entryPermission WAIT_NEWS", () => {
  const out = computeTradeability(baseInput({ newsBlocksTrade: true }));
  assert.equal(out.entryPermission, "WAIT_NEWS");
});

test("AT_EVENT news phase → entryPermission WAIT_NEWS", () => {
  const out = computeTradeability(baseInput({ newsPhase: "AT_EVENT" }));
  assert.equal(out.entryPermission, "WAIT_NEWS");
});

test("TRAP_HEAT → entryPermission STAND_DOWN", () => {
  const out = computeTradeability(baseInput({ heatState: "TRAP_HEAT" }));
  assert.equal(out.entryPermission, "STAND_DOWN");
});

test("false heat with weak structure → tradeability collapses to NO_TRADE", () => {
  const out = computeTradeability(baseInput({
    heatState: "FALSE_HEAT",
    isFalseHeat: true,
    candleBodyRatio: 0.2,
    atrRatio: null,
    sessionTradeabilityBonus: 0,
    fakeoutRisk: 0,
  }));
  assert.ok(out.tradeabilityScore < 25, `tradeabilityScore ${out.tradeabilityScore} should be < 25`);
  assert.equal(out.entryPermission, "NO_TRADE");
});

test("clean momentum + strong session bonus → entryPermission GO", () => {
  const out = computeTradeability(baseInput({
    heatState: "CLEAN_MOMENTUM",
    heatScore: 90,
    candleBodyRatio: 0.8,
    atrRatio: 2.0,
    sessionTradeabilityBonus: 25,
  }));
  assert.ok(out.tradeabilityScore >= 50, `tradeabilityScore ${out.tradeabilityScore} should be >= 50`);
  assert.equal(out.entryPermission, "GO");
});

test("GO requires candle evidence — the session clock alone degrades to WAIT_FOR_ENTRY", () => {
  // With no candles the neutral edge base (50 × 0.6 = 30) plus a strong
  // session bonus clears the GO bar on its own — the clock, not the market,
  // would be granting permission. The honesty guard must refuse GO.
  const out = computeTradeability(baseInput({
    heatState: "COOL",
    candleBodyRatio: null,
    atrRatio: null,
    candles: [],
    sessionTradeabilityBonus: 25,
  }));
  assert.ok(out.tradeabilityScore >= 50, `tradeabilityScore ${out.tradeabilityScore} should clear the GO bar (proves the guard, not the score, blocked GO)`);
  assert.equal(out.entryPermission, "WAIT_FOR_ENTRY");
});

test("move stage EARLY when too few candles", () => {
  const out = computeTradeability(baseInput({ candles: flat(5), atrRatio: null }));
  assert.equal(out.moveStage, "EARLY");
});

test("move stage EXHAUSTED when ATR is extreme", () => {
  const out = computeTradeability(baseInput({ candles: flat(20), atrRatio: 3.0 }));
  assert.equal(out.moveStage, "EXHAUSTED");
});

test("exhausted move forces WAIT_FOR_ENTRY even with workable tradeability", () => {
  const out = computeTradeability(baseInput({
    heatState: "CLEAN_MOMENTUM",
    heatScore: 90,
    candleBodyRatio: 0.8,
    atrRatio: 3.0, // > 2.5 → EXHAUSTED
    sessionTradeabilityBonus: 25,
    candles: flat(20),
  }));
  assert.equal(out.moveStage, "EXHAUSTED");
  assert.equal(out.entryPermission, "WAIT_FOR_ENTRY");
});
