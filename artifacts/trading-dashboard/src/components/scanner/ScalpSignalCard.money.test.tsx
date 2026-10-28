// Scalp money tiles name the currency the server reported for the account,
// never an assumed "$". Before the fix the card hard-coded "$" on
// "Target profit" / "Risk if stopped", so a non-USD account (or a figure the
// engine computed in the symbol's profit currency) read as dollars.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

import { ScalpSignalCard } from "./ScalpSignalCard";
import { fmtScalpMoney } from "./scalpLabels";
import type { ScalpResult } from "@workspace/api-client-react";

afterEach(() => cleanup());

function makeResult(overrides: Partial<ScalpResult> = {}): ScalpResult {
  return {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    assetClass: "forex",
    direction: "BUY",
    scalpType: "Momentum",
    mode: "ANY",
    status: "READY",
    qualityScore: 72,
    confidenceLabel: "Strong",
    entryType: "MARKET_BUY",
    entryZone: { from: 1.1, to: 1.1005 },
    currentPrice: 1.1002,
    takeProfit: { quick: 1.101, main: 1.102, stretch: 1.103 },
    stopLoss: 1.099,
    invalidationPrice: 1.0985,
    suggestedLot: 0.1,
    minLot: 0.01,
    maxLot: 5,
    lotStep: 0.01,
    digits: 5,
    targetProfitAmount: 20,
    estimatedProfitMainTP: 20,
    estimatedRiskAmount: 10,
    rewardToRisk: 2,
    estimatedMargin: 100,
    spreadRisk: "LOW",
    slippageRisk: "LOW",
    newsRisk: "LOW",
    timingStatus: "VALID_NOW",
    validForSeconds: 90,
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    chaseWarning: null,
    plainEnglishReason: "Clean momentum continuation.",
    riskWarning: null,
    targetRealityCheck: "REALISTIC",
    userAction: "READY_TO_REVIEW",
    canBuildTrade: true,
    canWatch: false,
    noTradeReason: null,
    flame: null,
    generatedAt: new Date().toISOString(),
    ...overrides,
  } as ScalpResult;
}

function moneyTiles(container: HTMLElement): string {
  const tiles = Array.from(container.querySelectorAll("div")).filter((d) =>
    /^(Target profit \(main TP\)|Risk if stopped)/.test(d.textContent ?? ""),
  );
  return tiles.map((t) => t.textContent ?? "").join(" | ");
}

describe("fmtScalpMoney", () => {
  it("uses $ only for USD", () => {
    expect(fmtScalpMoney(12.5, "USD")).toBe("$12.50");
    expect(fmtScalpMoney(12.5, "usd")).toBe("$12.50");
  });
  it("names any other reported currency", () => {
    expect(fmtScalpMoney(12.5, "EUR")).toBe("12.50 EUR");
  });
  it("names no currency when none was reported", () => {
    expect(fmtScalpMoney(12.5, null)).toBe("12.50 (account currency)");
    expect(fmtScalpMoney(12.5, undefined)).toBe("12.50 (account currency)");
    expect(fmtScalpMoney(null, "USD")).toBe("—");
  });
});

describe("ScalpSignalCard money tiles", () => {
  it("shows the reported account currency, not $", () => {
    const { container } = render(
      <ScalpSignalCard result={makeResult({ moneyCurrency: "EUR" })} onBuild={() => {}} />,
    );
    const text = moneyTiles(container);
    expect(text).toContain("20.00 EUR");
    expect(text).toContain("10.00 EUR");
    expect(text).not.toContain("$");
  });

  it("does not claim dollars when the account currency is unknown", () => {
    const { container } = render(
      <ScalpSignalCard result={makeResult({ moneyCurrency: null })} onBuild={() => {}} />,
    );
    const text = moneyTiles(container);
    expect(text).toContain("10.00 (account currency)");
    expect(text).not.toContain("$");
  });

  it("keeps $ for a USD account", () => {
    const { container } = render(
      <ScalpSignalCard result={makeResult({ moneyCurrency: "USD" })} onBuild={() => {}} />,
    );
    expect(moneyTiles(container)).toContain("$10.00");
  });
});
