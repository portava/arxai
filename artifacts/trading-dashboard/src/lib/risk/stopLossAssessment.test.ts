// Truth fix: the client stop-loss assessor guessed a pip size from the symbol
// name (gold 0.1, crypto 1, anything starting with "V" 0.1, default 0.0001) and
// built an 8-pip floor, a 3-pip slippage buffer, the "one pip beyond structure"
// nudge and the 1-pip R:R floor from that guess. The guesses disagree with the
// broker spec for the same instruments (V75 point 0.0001, XAUUSD point 0.01),
// so the Scanner trade modal gave SL advice ("Adjusted to broker minimum +
// spread buffer") that no broker figure backed. Pip size now comes only from
// the broker spec; without it the assessor says the distance was not checked.
import { describe, expect, it } from "vitest";
import {
  assessStopLoss,
  computeValidatedRR,
  stopLossInputsFromBrokerSpec,
} from "./stopLossAssessment";

describe("assessStopLoss — pip size comes from the broker spec, never from the symbol name", () => {
  it("Volatility 75 Index with no spec: pip size unknown, no invented 0.8 floor, says it was not checked", () => {
    const r = assessStopLoss({
      symbol: "Volatility 75 Index", side: "BUY", entry: 300000, proposedSl: 299999.5, atr: null, spread: null,
    });
    expect(r.pipSize).toBeNull();
    expect(r.distanceChecked).toBe(false);
    // The proposed stop is kept as-is: nothing known says it is too close, and
    // nothing invented moves it.
    expect(r.sl).toBe(299999.5);
    expect(r.adjusted).toBe(false);
    expect(r.reason).not.toMatch(/broker minimum/i);
    expect(r.reason).toMatch(/could not be checked/i);
    expect(r.reason).toMatch(/Volatility 75 Index/);
  });

  it("XAUUSD with no spec does not assume a 0.1 pip", () => {
    const r = assessStopLoss({ symbol: "XAUUSD", side: "BUY", entry: 2400, proposedSl: 2399.5 });
    expect(r.pipSize).not.toBe(0.1);
    expect(r.pipSize).toBeNull();
  });

  it("BTCUSD with no spec does not assume a 1-dollar pip (8-dollar floor)", () => {
    const r = assessStopLoss({ symbol: "BTCUSD", side: "SELL", entry: 60000, proposedSl: 60005 });
    expect(r.pipSize).toBeNull();
    expect(r.adjusted).toBe(false);
    expect(r.sl).toBe(60005);
  });

  it("no spec and no proposed stop: never invents a stop at entry", () => {
    const r = assessStopLoss({ symbol: "Volatility 75 Index", side: "BUY", entry: 300000, proposedSl: null });
    expect(r.ok).toBe(false);
    expect(r.sl).toBeNull();
    expect(r.blockReason).toBe("NO_SAFE_STOP_LOSS_AVAILABLE");
  });

  it("no spec and a stop on the wrong side is still refused", () => {
    const r = assessStopLoss({ symbol: "Volatility 75 Index", side: "BUY", entry: 300000, proposedSl: 300001 });
    expect(r.ok).toBe(false);
  });

  it("V75 with the broker spec (digits 4, point 0.0001) uses pip 0.0001 and accepts a 0.5 stop", () => {
    const spec = stopLossInputsFromBrokerSpec({ digits: 4, point: 0.0001, category: "Synthetics", freshness: "FRESH" });
    expect(spec.pipSize).toBe(0.0001);
    const r = assessStopLoss({
      symbol: "Volatility 75 Index", side: "BUY", entry: 300000, proposedSl: 299999.5, pipSize: spec.pipSize,
    });
    expect(r.pipSize).toBe(0.0001);
    expect(r.distanceChecked).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.adjusted).toBe(false);
    expect(r.sl).toBe(299999.5);
  });

  it("XAUUSD with the broker spec (digits 2, point 0.01) nudges beyond structure by 0.01, not 0.1", () => {
    const spec = stopLossInputsFromBrokerSpec({ digits: 2, point: 0.01, category: "Metals", freshness: "FRESH" });
    expect(spec.pipSize).toBe(0.01);
    const r = assessStopLoss({
      symbol: "XAUUSD", side: "BUY", entry: 2400, proposedSl: null, recentSwingLow: 2395, pipSize: spec.pipSize,
    });
    expect(r.ok).toBe(true);
    expect(r.sl).toBeCloseTo(2394.99, 10);
  });

  it("5-digit forex keeps the 8-pip floor (pip = 10 points)", () => {
    const spec = stopLossInputsFromBrokerSpec({ digits: 5, point: 0.00001, category: "Forex Majors", freshness: "FRESH" });
    expect(spec.pipSize).toBeCloseTo(0.0001, 12);
    const r = assessStopLoss({ symbol: "EURUSD", side: "BUY", entry: 1.085, proposedSl: 1.0845, pipSize: spec.pipSize });
    expect(r.adjusted).toBe(true);
    expect(r.sl).toBeCloseTo(1.0842, 10);
  });

  it("uses the broker stop level from the spec and names it in the reason", () => {
    const spec = stopLossInputsFromBrokerSpec({
      digits: 5, point: 0.00001, category: "Forex Majors", stopsLevel: 500, freshness: "FRESH",
    });
    expect(spec.minStopDistance).toBeCloseTo(0.005, 12);
    const r = assessStopLoss({
      symbol: "EURUSD", side: "BUY", entry: 1.085, proposedSl: 1.082,
      pipSize: spec.pipSize, minStopDistance: spec.minStopDistance,
    });
    expect(r.adjusted).toBe(true);
    expect(r.sl).toBeCloseTo(1.08, 10);
    expect(r.reason).toMatch(/broker's stop level/);
  });

  it("does not claim a broker minimum or spread it was never given", () => {
    const r = assessStopLoss({ symbol: "EURUSD", side: "BUY", entry: 1.085, proposedSl: 1.08, pipSize: 0.0001 });
    expect(r.ok).toBe(true);
    expect(r.reason).not.toMatch(/broker minimum|broker's stop level|spread/i);
  });

  it("a stale spec's spread is not used as the current spread", () => {
    const spec = stopLossInputsFromBrokerSpec({ digits: 5, point: 0.00001, spreadPoints: 12, freshness: "STALE" });
    expect(spec.spread).toBeNull();
    const fresh = stopLossInputsFromBrokerSpec({ digits: 5, point: 0.00001, spreadPoints: 12, freshness: "FRESH" });
    expect(fresh.spread).toBeCloseTo(0.00012, 12);
  });

  it("a spec without a usable point gives no pip size", () => {
    expect(stopLossInputsFromBrokerSpec(null).pipSize).toBeNull();
    expect(stopLossInputsFromBrokerSpec({ digits: 5, point: null }).pipSize).toBeNull();
    expect(stopLossInputsFromBrokerSpec({ digits: 5, point: 0 }).pipSize).toBeNull();
  });
});

describe("computeValidatedRR", () => {
  it("returns null when the pip size is unknown (a near-zero stop cannot be ruled out)", () => {
    expect(computeValidatedRR(300000, 299999.5, 300010, null)).toBeNull();
  });
  it("computes reward/risk when the stop is at least one pip", () => {
    expect(computeValidatedRR(300000, 299999.5, 300010, 0.0001)).toBeCloseTo(20, 10);
  });
});
