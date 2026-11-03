// Truth audit 2026-10-28 — the Focus scalp card runs one scalp read (no
// polling) and lifts its setup-aware verdict into the page store the header
// Action cell and the chart Plan Buy/Sell CTAs read. That verdict (a) must
// never outrank the CURRENT data-only verdict when that verdict says the feed
// can't support a live entry, and (b) must be retracted once the scalp read's
// own server-declared expiresAt has passed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ScalpResult } from "@workspace/api-client-react";
import { ScalpSignalCard } from "./ScalpSignalCard";
import {
  resolveSelectedSymbolActionability,
  resolveSelectedSymbolActionabilityDisplay,
} from "@/lib/scannerActionability";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const NOW = Date.parse("2026-10-28T10:00:00.000Z");

function makeResult(overrides: Partial<ScalpResult> = {}): ScalpResult {
  return {
    symbol: "EURUSD", displayName: "EUR/USD", assetClass: "forex", direction: "BUY", scalpType: "Momentum",
    mode: "ANY", status: "READY", qualityScore: 72, confidenceLabel: "Strong", entryType: "MARKET_BUY",
    entryZone: { from: 1.1, to: 1.1005 }, currentPrice: 1.1002, takeProfit: { quick: 1.101, main: 1.102, stretch: 1.103 },
    stopLoss: 1.099, invalidationPrice: 1.0985, suggestedLot: 0.1, minLot: 0.01, maxLot: 5, lotStep: 0.01, digits: 5,
    targetProfitAmount: 20, estimatedProfitMainTP: 20, estimatedRiskAmount: 10, rewardToRisk: 2, estimatedMargin: 100,
    spreadRisk: "LOW", slippageRisk: "LOW", newsRisk: "LOW", timingStatus: "VALID_NOW", validForSeconds: 60,
    expiresAt: new Date(NOW + 60_000).toISOString(), chaseWarning: null, plainEnglishReason: "Clean momentum continuation.",
    riskWarning: null, targetRealityCheck: "REALISTIC", userAction: "READY_TO_REVIEW", canBuildTrade: true, canWatch: false,
    noTradeReason: null, flame: null, generatedAt: new Date(NOW).toISOString(), timeframe: "M5",
    ...overrides,
  } as ScalpResult;
}

describe("lifted scalp verdict vs the current data-only verdict", () => {
  it.each(["ANALYSIS_ONLY", "FEED_LIMITED", "MARKET_CLOSED"] as const)(
    "a lifted READY_NOW never outranks a current %s data verdict",
    (dataOnly) => {
      expect(resolveSelectedSymbolActionabilityDisplay("READY_NOW", dataOnly)).toBe(dataOnly);
      expect(resolveSelectedSymbolActionability("READY_NOW", dataOnly)).toBe(dataOnly);
      expect(resolveSelectedSymbolActionability("WAIT_FOR_CONFIRMATION", dataOnly)).toBe(dataOnly);
    },
  );
  it("a lifted verdict still wins over clean data (setup-aware beats data-only WAIT)", () => {
    expect(resolveSelectedSymbolActionability("READY_NOW", "WAIT_FOR_CONFIRMATION")).toBe("READY_NOW");
    expect(resolveSelectedSymbolActionability("NO_CLEAN_SETUP", "WAIT_FOR_CONFIRMATION")).toBe("NO_CLEAN_SETUP");
  });
  it("the more severe of two data caps stands", () => {
    expect(resolveSelectedSymbolActionability("MARKET_CLOSED", "FEED_LIMITED")).toBe("MARKET_CLOSED");
    expect(resolveSelectedSymbolActionability("ANALYSIS_ONLY", "FEED_LIMITED")).toBe("FEED_LIMITED");
  });
});

describe("ScalpSignalCard — the scalp read's own lifetime", () => {
  it("retracts its lifted verdict and disables Build once expiresAt passes", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    const publish = vi.fn();
    render(<ScalpSignalCard result={makeResult()} onBuild={() => {}} onActionability={publish} />);
    expect(publish).toHaveBeenLastCalledWith("EURUSD", "5m", "READY_NOW", "BUY");
    expect((screen.getByTestId("scalp-build-EURUSD") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("scalp-expired-EURUSD")).toBeNull();

    act(() => { vi.advanceTimersByTime(60_001); });

    expect(publish).toHaveBeenLastCalledWith("EURUSD", "5m", null, null);
    expect((screen.getByTestId("scalp-build-EURUSD") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("scalp-expired-EURUSD").textContent).toMatch(/expired/i);
    expect(screen.getByTestId("scalp-card-EURUSD").textContent).not.toMatch(/Ready now|Valid now/i);
  });

  it("a read with no parseable expiresAt is not lifted as current", () => {
    const publish = vi.fn();
    render(<ScalpSignalCard result={makeResult({ expiresAt: "not-a-date" })} onBuild={() => {}} onActionability={publish} />);
    expect(publish).toHaveBeenLastCalledWith("EURUSD", "5m", null, null);
    expect((screen.getByTestId("scalp-build-EURUSD") as HTMLButtonElement).disabled).toBe(true);
  });
});

// Review fix (2026-10-28): after expiresAt the card replaced only the timing
// chip, flame freshness, published verdict and Build button. The header status
// badge still read "Ready to review" (success tone), the flame row still read
// "Strong scalp" with its live execution chips, and the reasoning block still
// stated "BUY scalp setup" as the current decision.
describe("ScalpSignalCard — an expired read states nothing as current", () => {
  const liveFlame = {
    blind: false,
    scalpStatus: "STRONG",
    flameStage: "ACTIVE",
    scalpScore: 81,
    freshness: "FRESH",
    flameAgeCandles: 2,
    entryTiming: "CLEAN",
    chaseRisk: "LOW",
    runway: "CLEAR",
    executionQuality: "GOOD",
    htfContext: "ALIGNED",
    setupType: "BREAKOUT",
    whyNow: "Momentum just broke the range high.",
  };

  it("status badge, flame row, execution chips and decision say the read expired", () => {
    const expired = makeResult({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      generatedAt: new Date(Date.now() - 120_000).toISOString(),
      flame: liveFlame as unknown as ScalpResult["flame"],
    });
    render(<ScalpSignalCard result={expired} onBuild={() => {}} />);
    expect(screen.getByTestId("scalp-expired-EURUSD")).toBeTruthy();

    const card = screen.getByTestId("scalp-card-EURUSD");
    const status = card.querySelector("[data-status-token]");
    expect(status?.textContent).not.toMatch(/Ready to review/i);
    expect(status?.textContent).toMatch(/expired/i);
    expect(status?.className ?? "").not.toMatch(/emerald/);

    const flameRow = screen.queryByTestId("scalp-flame-EURUSD");
    expect(flameRow?.textContent ?? "").not.toMatch(/Strong scalp/i);
    expect(card.textContent).not.toMatch(/Timing\s*Clean entry/i);
    expect(card.textContent).not.toMatch(/Chase\s*Low/i);
    expect(card.textContent).not.toMatch(/Runway/i);

    const decision = screen.getByTestId("scalp-reasoning-EURUSD-decision").textContent ?? "";
    expect(decision).not.toMatch(/BUY scalp setup/);
    expect(decision).toMatch(/expired/i);
  });

  it("a current read still shows its status, flame and decision", () => {
    const current = makeResult({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      flame: liveFlame as unknown as ScalpResult["flame"],
    });
    render(<ScalpSignalCard result={current} onBuild={() => {}} />);
    const card = screen.getByTestId("scalp-card-EURUSD");
    expect(card.querySelector("[data-status-token]")?.textContent).toMatch(/Ready to review/i);
    expect(screen.getByTestId("scalp-flame-EURUSD").textContent).toMatch(/Strong scalp/i);
    expect(card.textContent).toMatch(/Timing\s*Clean entry/i);
    expect(card.textContent).toMatch(/Runway\s*Clear runway/i);
    expect(screen.getByTestId("scalp-reasoning-EURUSD-decision").textContent).toMatch(/BUY scalp setup/);
  });
});

describe("buildReasoningFromScalp — expired input", () => {
  it("states no current decision and labels the why as at-read", async () => {
    const { buildReasoningFromScalp } = await import("@/lib/rubyReasoningBlock");
    const data = buildReasoningFromScalp({ result: makeResult(), expired: true });
    expect(data.decision).not.toMatch(/BUY scalp setup/);
    expect(data.decision).toMatch(/expired/i);
    expect(data.why).toMatch(/^When it was read:/);
    expect(data.evidence.feedData).toMatch(/expired/i);
    const current = buildReasoningFromScalp({ result: makeResult() });
    expect(current.decision).toBe("BUY scalp setup");
  });
});
