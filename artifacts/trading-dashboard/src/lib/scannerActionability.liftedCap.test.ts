import { describe, it, expect } from "vitest";
import {
  reconcileLiftedActionDirection,
  resolveSelectedSymbolActionability,
  resolveSelectedSymbolActionabilityDisplay,
} from "./scannerActionability";

// A lifted card verdict is an earlier read; the data-only verdict is the
// CURRENT chart truth. A current data cap must dominate a less severe lift.
describe("resolveSelectedSymbolActionability — current data cap floor", () => {
  it("FEED_LIMITED / ANALYSIS_ONLY / MARKET_CLOSED override a lifted READY_NOW", () => {
    expect(resolveSelectedSymbolActionability("READY_NOW", "FEED_LIMITED")).toBe("FEED_LIMITED");
    expect(resolveSelectedSymbolActionability("READY_NOW", "ANALYSIS_ONLY")).toBe("ANALYSIS_ONLY");
    expect(resolveSelectedSymbolActionability("WAIT_FOR_CONFIRMATION", "MARKET_CLOSED")).toBe("MARKET_CLOSED");
    expect(resolveSelectedSymbolActionabilityDisplay("READY_NOW", "FEED_LIMITED")).toBe("FEED_LIMITED");
  });
  it("a clean data-only WAIT never overrides a lifted setup verdict", () => {
    expect(resolveSelectedSymbolActionability("READY_NOW", "WAIT_FOR_CONFIRMATION")).toBe("READY_NOW");
    expect(resolveSelectedSymbolActionability("NO_CLEAN_SETUP", "WAIT_FOR_CONFIRMATION")).toBe("NO_CLEAN_SETUP");
  });
  it("a more severe lift is kept (downgrade-only)", () => {
    expect(resolveSelectedSymbolActionability("MARKET_CLOSED", "FEED_LIMITED")).toBe("MARKET_CLOSED");
    expect(resolveSelectedSymbolActionability("FEED_LIMITED", "ANALYSIS_ONLY")).toBe("FEED_LIMITED");
  });
});

describe("reconcileLiftedActionDirection", () => {
  it("drops a side that contradicts the lifted scalp's own side", () => {
    expect(reconcileLiftedActionDirection("BUY", "SELL")).toBeNull();
    expect(reconcileLiftedActionDirection("BUY", "BUY")).toBe("BUY");
    expect(reconcileLiftedActionDirection("SELL", null)).toBe("SELL");
  });
  it("never invents a side the bias didn't state", () => {
    expect(reconcileLiftedActionDirection(null, "BUY")).toBeNull();
  });
});
