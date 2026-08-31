// Read-expiry honesty render proof (STALE_UNLABELED fix) — the scalp engine
// stamps every actionable read with expiresAt/validForSeconds (90–240s by
// mode), but the card used to render "Ready to review" / "Valid now" with an
// enabled Build button FOREVER: a user returning minutes later was invited to
// prefill a ticket from a read the engine itself had declared dead. This suite
// renders the REAL component and proves at the DOM level:
//
//   1. A read past its own expiresAt flips to an explicit amber "Read expired"
//      state: no "Ready to review"/"Valid now" wording, timing chip reads
//      "Expired", the expired banner renders, Build is disabled even when the
//      frozen server field canBuildTrade is still true, and the shared verdict
//      degrades to FEED_LIMITED (which auto-retracts the lifted header verdict).
//   2. Reject/awaiting reads (validForSeconds=0 — the engine never claimed a
//      validity window) are NOT branded expired; they keep their own honest
//      terminal state.
//   3. A still-valid read shows a live countdown and stays actionable.
//   4. The flip happens client-side when the window passes while mounted.
//
// Display-only assertions: no gate, feed, scoring, or execution logic is
// touched — onBuild still routes through the fully-gated trade ticket.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

import { ScalpSignalCard } from "./ScalpSignalCard";
import type { ScalpResult } from "@workspace/api-client-react";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

describe("ScalpSignalCard — read expiry honesty", () => {
  it("an already-expired read renders the explicit expired state and never offers Build", () => {
    // The finding's exact scenario: the user returns minutes after the engine's
    // 90s validity window closed. canBuildTrade is deliberately still true (the
    // frozen server field) — expiry must veto it.
    const { container } = render(
      <ScalpSignalCard
        result={makeResult({
          generatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          expiresAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          canBuildTrade: true,
        })}
        onBuild={() => {}}
      />,
    );
    const text = container.textContent ?? "";
    expect(/read expired/i.test(text)).toBe(true);
    expect(/valid now/i.test(text)).toBe(false);
    expect(/ready to review/i.test(text)).toBe(false);
    expect(
      container.querySelector('[data-testid="scalp-expired-EURUSD"]'),
    ).toBeTruthy();
    const card = container.querySelector('[data-testid="scalp-card-EURUSD"]');
    expect(card?.getAttribute("data-read-expired")).toBe("true");
    // The shared verdict degrades — this is what retracts the lifted header verdict.
    expect(card?.getAttribute("data-actionability")).toBe("FEED_LIMITED");
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="scalp-build-EURUSD"]',
    );
    expect(btn!.disabled).toBe(true);
  });

  it("reads without a validity window (validForSeconds=0 rejects) are NOT branded expired", () => {
    // rejectResult stamps validForSeconds:0 / expiresAt:now — those cards are
    // already honest terminal states and must keep their own label.
    const { container } = render(
      <ScalpSignalCard
        result={makeResult({
          status: "MARKET_CLOSED",
          canBuildTrade: false,
          validForSeconds: 0,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        })}
        onBuild={() => {}}
      />,
    );
    const text = container.textContent ?? "";
    expect(/market closed/i.test(text)).toBe(true);
    expect(/read expired/i.test(text)).toBe(false);
    expect(
      container.querySelector('[data-testid="scalp-expired-EURUSD"]'),
    ).toBeNull();
  });

  it("a still-valid read shows a live countdown and stays actionable", () => {
    const { container } = render(
      <ScalpSignalCard result={makeResult()} onBuild={() => {}} />,
    );
    const text = container.textContent ?? "";
    expect(/valid now/i.test(text)).toBe(true);
    expect(/left/i.test(text)).toBe(true); // countdown ("1m 30s left" etc.)
    expect(
      container.querySelector('[data-testid="scalp-expired-EURUSD"]'),
    ).toBeNull();
    const card = container.querySelector('[data-testid="scalp-card-EURUSD"]');
    expect(card?.getAttribute("data-actionability")).toBe("READY_NOW");
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="scalp-build-EURUSD"]',
    );
    expect(btn!.disabled).toBe(false);
  });

  it("the card flips to expired while mounted, when the engine's window passes", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <ScalpSignalCard
          result={makeResult({
            validForSeconds: 2,
            expiresAt: new Date(Date.now() + 2_000).toISOString(),
          })}
          onBuild={() => {}}
        />,
      );
      expect(
        container.querySelector('[data-testid="scalp-expired-EURUSD"]'),
      ).toBeNull();
      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      expect(
        container.querySelector('[data-testid="scalp-expired-EURUSD"]'),
      ).toBeTruthy();
      const btn = container.querySelector<HTMLButtonElement>(
        '[data-testid="scalp-build-EURUSD"]',
      );
      expect(btn!.disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
