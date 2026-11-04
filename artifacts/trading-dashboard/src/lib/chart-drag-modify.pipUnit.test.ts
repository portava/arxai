import { describe, it, expect } from "vitest";
import { pipDistance, pipSize, pointSize } from "./chart-drag-modify";

// Regression: the drag-modify readout assumed 5-digit (JPY: 3-digit) FX
// pricing for every symbol, so an XAUUSD SL 10.00 away read "100000.0p",
// BTCUSD a $500 move "5000000.0p" and V75 a 100-point move "1000000.0p".
// The pip is only a defined unit for FX currency pairs; for anything else the
// readout has no honest pip value and must say nothing rather than invent one.
describe("pipDistance — only FX pairs get a pip readout", () => {
  it("FX majors and JPY pairs keep their conventional pip", () => {
    expect(pipDistance("EURUSD", 1.1, 1.101)).toBeCloseTo(10, 6);
    expect(pipDistance("USDJPY", 150.0, 150.25)).toBeCloseTo(25, 6);
    expect(pipDistance("EURUSD.m", 1.1, 1.101)).toBeCloseTo(10, 6);
    expect(pipDistance("GBP/USD", 1.25, 1.2505)).toBeCloseTo(5, 6);
  });

  it("metals, crypto, indices and synthetics never get an invented pip count", () => {
    expect(pipDistance("XAUUSD", 2380, 2370)).not.toBe(100000);
    expect(pipDistance("XAUUSD", 2380, 2370)).toBeNull();
    expect(pipDistance("BTCUSD", 68500, 68000)).toBeNull();
    expect(pipDistance("US30", 42000, 41900)).toBeNull();
    expect(pipDistance("V75", 33600, 33500)).toBeNull();
    expect(pipDistance("Volatility 75 Index", 33600, 33500)).toBeNull();
  });

  it("pip / point sizes are unknown (null) outside FX pairs", () => {
    expect(pipSize("XAUUSD")).toBeNull();
    expect(pointSize("XAUUSD")).toBeNull();
    expect(pipSize("EURUSD")).toBeCloseTo(0.0001, 10);
    expect(pointSize("USDJPY")).toBeCloseTo(0.001, 10);
  });
});
