// The ticket loss / gain / risk dollars. Before: live-manual used
// distance × lots × 10,000 (EURUSD 0.01 lot, 20 pips → $0.20; real ≈ $2.00)
// and the Command Room used $10 per pip per lot for every symbol (USDJPY 1
// lot, 50 pips → $500; real ≈ $333 at 150.00), arbitrary for metals,
// indices and crypto.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateMoneyAtDistance, formatMoneyEstimate } from "./fxRiskEstimate";

describe("estimateMoneyAtDistance", () => {
  it("EURUSD 0.01 lot, 20 pips ≈ $2.00", () => {
    const e = estimateMoneyAtDistance("EURUSD", 0.01, 1.085, 1.083);
    expect(e.usd).toBeCloseTo(2, 6);
  });
  it("USDJPY 1 lot, 50 pips at 150.00 ≈ $333.33, not $500", () => {
    const e = estimateMoneyAtDistance("FX:USDJPY", 1, 150, 149.5);
    expect(e.usd).toBeCloseTo(333.33, 2);
    expect(formatMoneyEstimate(e)).toBe("≈$333.33");
  });
  it("cross pairs, metals, indices, crypto and synthetics are not estimated", () => {
    for (const s of ["EURGBP", "XAUUSD", "US30", "BTCUSD", "Volatility 75 Index", "R_75"]) {
      const e = estimateMoneyAtDistance(s, 1, 100, 99);
      expect(e.usd, s).toBeNull();
      expect(formatMoneyEstimate(e)).toBe("Not estimated");
    }
  });
  it("missing inputs give no number", () => {
    expect(estimateMoneyAtDistance("EURUSD", 0, 1.1, 1.09).usd).toBeNull();
    expect(estimateMoneyAtDistance("EURUSD", 1, NaN, 1.09).usd).toBeNull();
    expect(estimateMoneyAtDistance("EURUSD", 1, 1.1, 0).usd).toBeNull();
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));

describe("ticket wiring", () => {
  const strip = (s: string) => s.replace(/\/\/.*$/gm, "");
  it("live-manual prices nothing off the simulator mid; the Command Room uses quickTradeRiskApprox", () => {
    const manual = strip(readFileSync(resolve(HERE, "../pages/live-manual.tsx"), "utf8"));
    const room = strip(readFileSync(resolve(HERE, "../pages/trade-command-room.tsx"), "utf8"));
    const quickRisk = strip(readFileSync(resolve(HERE, "../components/dashboard/trade/quickTradeRisk.ts"), "utf8"));
    // The only price live-manual loads is the ARX simulator's quote, so its
    // estimates are the estimator's explicit "Not estimated" (usd: null with a
    // reason), never a figure measured from the simulator mid.
    expect(manual).toMatch(/formatMoneyEstimate\(lossEst\)/);
    expect(manual).toMatch(/const lossEst: MoneyEstimate = \{ usd: null, reason:/);
    expect(manual).toMatch(/const gainEst: MoneyEstimate = \{ usd: null, reason:/);
    expect(manual).not.toMatch(/quote\??\.mid/);
    expect(manual).not.toMatch(/\*\s*10000/);
    // The Command Room's Quick Trade figure has the same contract-size and
    // USD-conversion rules, plus a market-quote gate (no figure from the
    // simulator quote).
    expect(room).toMatch(/quickTradeRiskApprox\(/);
    expect(room).not.toMatch(/pipValuePerLot\s*=\s*10\b/);
    expect(quickRisk).toMatch(/isMarketQuote\(quote\)/);
    expect(quickRisk).not.toMatch(/pipValuePerLot\s*=\s*10\b/);
  });
});
