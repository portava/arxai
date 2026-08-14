import { describe, it, expect } from "vitest";
import {
  inferDecimals,
  pipSize,
  pipDistance,
  computeRiskReward,
  validateModifyLevels,
} from "./chart-drag-modify";

describe("chart-drag-modify pure helpers", () => {
  it("infers decimals + pip size by symbol family", () => {
    expect(inferDecimals("EURUSD")).toBe(5);
    expect(inferDecimals("USDJPY")).toBe(3);
    expect(pipSize("EURUSD")).toBeCloseTo(0.0001, 10);
    expect(pipSize("USDJPY")).toBeCloseTo(0.01, 10);
  });

  it("pipDistance is symbol-aware and produces distinct outputs for distinct inputs", () => {
    const a = pipDistance("EURUSD", 1.1, 1.101); // 10 pips
    const b = pipDistance("EURUSD", 1.1, 1.105); // 50 pips
    expect(a).toBeCloseTo(10, 6);
    expect(b).toBeCloseTo(50, 6);
    expect(a).not.toEqual(b);
    expect(pipDistance("EURUSD", null, 1.1)).toBeNull();
    expect(pipDistance("EURUSD", -1, 1.1)).toBeNull();
  });

  it("computeRiskReward returns reward/risk only for correctly-sided legs", () => {
    // BUY: entry 1.10, SL 1.09 (risk 0.01), TP 1.12 (reward 0.02) -> R/R 2
    expect(computeRiskReward({ side: "BUY", entry: 1.1, stopLoss: 1.09, takeProfit: 1.12 })).toBeCloseTo(2, 6);
    // SELL mirror -> R/R 2
    expect(computeRiskReward({ side: "SELL", entry: 1.1, stopLoss: 1.11, takeProfit: 1.08 })).toBeCloseTo(2, 6);
    // wrong-sided SL (BUY SL above entry) -> null, never a fake positive ratio
    expect(computeRiskReward({ side: "BUY", entry: 1.1, stopLoss: 1.11, takeProfit: 1.12 })).toBeNull();
    // missing leg -> null
    expect(computeRiskReward({ side: "BUY", entry: 1.1, stopLoss: null, takeProfit: 1.12 })).toBeNull();
  });

  it("validateModifyLevels enforces side rules", () => {
    expect(validateModifyLevels({ side: "BUY", entry: 1.1, newStopLoss: 1.09, newTakeProfit: 1.12 }).ok).toBe(true);
    const badSl = validateModifyLevels({ side: "BUY", entry: 1.1, newStopLoss: 1.11, newTakeProfit: 1.12 });
    expect(badSl.ok).toBe(false);
    expect(badSl.reason).toMatch(/below entry/i);
    const badTp = validateModifyLevels({ side: "SELL", entry: 1.1, newStopLoss: 1.11, newTakeProfit: 1.12 });
    expect(badTp.ok).toBe(false);
    expect(badTp.reason).toMatch(/below entry/i);
  });

  it("validateModifyLevels enforces broker minimum stop distance when provided", () => {
    const tooClose = validateModifyLevels({
      side: "BUY", entry: 1.1, newStopLoss: 1.0999, newTakeProfit: 1.12, minStopDistance: 0.001,
    });
    expect(tooClose.ok).toBe(false);
    expect(tooClose.reason).toMatch(/minimum stop distance/i);
    const okDist = validateModifyLevels({
      side: "BUY", entry: 1.1, newStopLoss: 1.09, newTakeProfit: 1.12, minStopDistance: 0.001,
    });
    expect(okDist.ok).toBe(true);
  });

  it("validateModifyLevels requires at least one movable leg and a usable entry", () => {
    expect(validateModifyLevels({ side: "BUY", entry: 1.1, newStopLoss: null, newTakeProfit: null }).ok).toBe(false);
    expect(validateModifyLevels({ side: "BUY", entry: 0, newStopLoss: 1.09, newTakeProfit: 1.12 }).ok).toBe(false);
  });
});
