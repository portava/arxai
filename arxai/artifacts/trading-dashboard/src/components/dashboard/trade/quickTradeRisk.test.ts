// Quick Trade "Risk approx.": the readout used $10/pip and a 0.0001 (or 0.01
// for JPY) pip for every symbol. A 1-lot gold trade with a $10 stop read
// "$1000000.00" (real: 100 oz → $1,000), USDJPY 100 pips read $1,000 (real
// ≈ $640 at 156). Contract size is only assumed for fiat/fiat FX pairs, the
// same default-deny rule as the server's contractSize.ts.
import { describe, expect, it } from "vitest";
import { quickTradeRiskApprox } from "./quickTradeRisk";

const q = (mid: number) => ({ bid: mid, ask: mid, spread: 0, mid, executionEnvironment: "MT5" });
const usd = (s: string) => Number(s.replace(/^\$/, ""));

describe("quickTradeRiskApprox", () => {
  it("gold: no invented dollar figure (contract size is broker-specific)", () => {
    const r = quickTradeRiskApprox({ symbol: "XAUUSD", lot: "1", stopLoss: "2370", quote: q(2380) });
    expect(r).not.toBe("$1000000.00");
    expect(r).toBe("Contract size unknown");
  });

  it("crypto, indices and synthetics are withheld too", () => {
    for (const symbol of ["BTCUSDT", "US30", "Volatility 75 Index"]) {
      expect(quickTradeRiskApprox({ symbol, lot: "1", stopLoss: "100", quote: q(600) })).toBe("Contract size unknown");
    }
  });

  it("EURUSD: 1 lot, 30 pip stop ≈ $300", () => {
    const r = quickTradeRiskApprox({ symbol: "EURUSD", lot: "1", stopLoss: "1.0820", quote: q(1.085) });
    expect(usd(r)).toBeCloseTo(300, 0);
  });

  it("USDJPY: 1 lot, 100 pip stop at 156 ≈ $640, not $1,000", () => {
    const r = quickTradeRiskApprox({ symbol: "USDJPY", lot: "1", stopLoss: "155.00", quote: q(156) });
    expect(usd(r)).toBeGreaterThan(630);
    expect(usd(r)).toBeLessThan(650);
  });

  it("a cross pair needs a rate it does not have, so says so", () => {
    expect(quickTradeRiskApprox({ symbol: "EURGBP", lot: "1", stopLoss: "0.8400", quote: q(0.845) }))
      .toBe("Needs GBP→USD rate");
  });
});
