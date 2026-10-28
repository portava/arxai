// Scanner card-text drift render proof (display-only) — the scalp card can
// NEVER co-render contradictory actionability wording, because every piece of
// act/wait wording and the Build CTA's enabled state derive from the ONE shared
// scanner verdict (resolveScannerActionability / SCANNER_ACTIONABILITY_UI, fed
// by scalpStatusToSetup from the single engine status). This suite renders the
// REAL component across every engine status and proves, at the DOM level:
//
//   1. "Ready now" wording and "Wait for confirmation" wording never co-render
//      on one card, for ANY engine status — structurally impossible, not just
//      unlikely, because both would have to come from the same single verdict.
//   2. The Build CTA is enabled ONLY when the shared verdict is actionable
//      (READY_NOW) — a card can never say "wait" while offering an enabled
//      act-now button, and never offers an enabled button on a non-ready card.
//   3. An AWAITING_DATA (non-live / insufficient) read renders NO act-ready
//      language and no direction badge — stale/insufficient never reads "Ready".
//
// Display-only assertions: no gate, feed, scoring, or execution logic is
// touched — onBuild still routes through the fully-gated trade ticket.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

import { ScalpSignalCard } from "./ScalpSignalCard";
import { scalpStatusToSetup } from "./scalpLabels";
import {
  resolveScannerActionability,
  SCANNER_ACTIONABILITY_UI,
} from "@/lib/scannerActionability";
import type { ScalpResult, ScalpResultStatus } from "@workspace/api-client-react";

afterEach(() => cleanup());

// Every engine status the card can receive (the full ScalpResultStatus union).
const ALL_STATUSES: ScalpResultStatus[] = [
  "READY",
  "FORMING",
  "WAIT_FOR_ENTRY",
  "LATE",
  "INVALID",
  "NO_CLEAN_SCALP",
  "SPREAD_TOO_WIDE",
  "NEWS_DANGER",
  "MARKET_CLOSED",
  "SYMBOL_NOT_TRADEABLE",
  "INSUFFICIENT_MARGIN",
  "AWAITING_DATA",
];

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

/** The exact shared-verdict wording pairs the honesty contract forbids mixing. */
const READY_WORDING = [/ready now/i, /you can act now/i];
const WAIT_WORDING = [/wait for confirmation/i, /needs to confirm before acting/i];

function textOf(container: HTMLElement): string {
  return container.textContent ?? "";
}

describe("ScalpSignalCard — ONE shared verdict, no contradictory co-render", () => {
  it("never co-renders act-now wording with wait-for-confirmation wording for ANY engine status", () => {
    for (const status of ALL_STATUSES) {
      const { container, unmount } = render(
        <ScalpSignalCard result={makeResult({ status })} onBuild={() => {}} />,
      );
      const text = textOf(container);
      const showsReady = READY_WORDING.some((rx) => rx.test(text));
      const showsWait = WAIT_WORDING.some((rx) => rx.test(text));
      expect(
        showsReady && showsWait,
        `status=${status} co-rendered act-now AND wait wording`,
      ).toBe(false);
      unmount();
    }
  });

  it("the card's data-actionability always equals the shared verdict derived from the engine status", () => {
    for (const status of ALL_STATUSES) {
      const dataReady = status !== "AWAITING_DATA";
      const expected = resolveScannerActionability(
        {
          quoteStatus: dataReady ? "LIVE" : "UNAVAILABLE",
          candleStatus: dataReady ? "CONFIRMED" : "UNAVAILABLE",
          chartIntelligenceStatus: dataReady ? "FULL" : "UNAVAILABLE",
        },
        dataReady ? scalpStatusToSetup(status) : "UNKNOWN",
      );
      const { container, unmount } = render(
        <ScalpSignalCard result={makeResult({ status })} onBuild={() => {}} />,
      );
      const card = container.querySelector('[data-testid="scalp-card-EURUSD"]');
      expect(card?.getAttribute("data-actionability"), `status=${status}`).toBe(expected);
      unmount();
    }
  });

  it("the Build CTA is enabled ONLY when the shared verdict says the card can act", () => {
    for (const status of ALL_STATUSES) {
      const dataReady = status !== "AWAITING_DATA";
      const verdict = resolveScannerActionability(
        {
          quoteStatus: dataReady ? "LIVE" : "UNAVAILABLE",
          candleStatus: dataReady ? "CONFIRMED" : "UNAVAILABLE",
          chartIntelligenceStatus: dataReady ? "FULL" : "UNAVAILABLE",
        },
        dataReady ? scalpStatusToSetup(status) : "UNKNOWN",
      );
      const canAct = SCANNER_ACTIONABILITY_UI[verdict].canAct;
      const { container, unmount } = render(
        // canBuildTrade true on purpose: even when the SERVER field would allow
        // building, the shared verdict must still be able to veto (stricter wins).
        <ScalpSignalCard result={makeResult({ status, canBuildTrade: true })} onBuild={() => {}} />,
      );
      const btn = container.querySelector<HTMLButtonElement>(
        '[data-testid="scalp-build-EURUSD"]',
      );
      expect(btn, `status=${status} button missing`).toBeTruthy();
      expect(btn!.disabled, `status=${status} Build enabled=${!btn!.disabled} but verdict=${verdict}`).toBe(
        !canAct,
      );
      unmount();
    }
  });

  it("an AWAITING_DATA read shows no act-ready language, no direction badge, and a disabled Build CTA", () => {
    const { container } = render(
      <ScalpSignalCard
        result={makeResult({ status: "AWAITING_DATA", canBuildTrade: true })}
        onBuild={() => {}}
      />,
    );
    const text = textOf(container);
    for (const rx of READY_WORDING) {
      expect(rx.test(text), `AWAITING_DATA leaked act-ready wording ${rx}`).toBe(false);
    }
    // "Ready to review" (the READY engine label) must not appear either.
    expect(/ready to review/i.test(text)).toBe(false);
    // Direction is capped by the shared readability contract on a non-live read.
    expect(text.includes("BUY")).toBe(false);
    const card = container.querySelector('[data-testid="scalp-card-EURUSD"]');
    expect(card?.getAttribute("data-actionability")).toBe("FEED_LIMITED");
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="scalp-build-EURUSD"]');
    expect(btn!.disabled).toBe(true);
  });

  it("act-ready wording appears ONLY on a READY engine status (never on wait/blocked/stale cards)", () => {
    for (const status of ALL_STATUSES) {
      const { container, unmount } = render(
        <ScalpSignalCard result={makeResult({ status })} onBuild={() => {}} />,
      );
      const text = textOf(container);
      const showsReadyBadge = /ready to review/i.test(text);
      if (status === "READY") {
        expect(showsReadyBadge, "READY card should show its ready badge").toBe(true);
      } else {
        expect(showsReadyBadge, `status=${status} leaked a ready badge`).toBe(false);
      }
      unmount();
    }
  });
});

// ── AWAITING_DATA split by engine reason (owner screenshot 2026-10-27) ────────
// V75 1m, Deriv public data, no MT5 bridge: the engine passed every feed gate
// and stopped only because the broker's symbol details were missing (NO_SPECS),
// yet the header ACTION cell read "Feed limited — The live feed isn't fully
// confirmed" under the 1m key while DATA said "Live, confirmed candles.".
describe("ScalpSignalCard — AWAITING_DATA reasons and the lifted verdict", () => {
  function noSpecs(over: Partial<ScalpResult> = {}): ScalpResult {
    return makeResult({
      symbol: "V75",
      displayName: "Volatility 75 Index",
      status: "AWAITING_DATA",
      rejectReason: "NO_SPECS",
      timeframe: "M5",
      direction: null,
      canBuildTrade: false,
      canWatch: true,
      entryZone: null,
      stopLoss: null,
      suggestedLot: null,
      takeProfit: { quick: null, main: null, stretch: null },
      noTradeReason: "Eleanor needs live symbol specs before building a scalp for this market.",
      plainEnglishReason:
        "Eleanor needs the broker's live symbol details (lot size, point value) for this market before building a scalp.",
      ...over,
    } as Partial<ScalpResult>);
  }

  it("NO_SPECS is not a feed problem: no 'Feed limited', honest badge, Build disabled", () => {
    const { container } = render(<ScalpSignalCard result={noSpecs()} onBuild={() => {}} />);
    const card = container.querySelector('[data-testid="scalp-card-V75"]');
    expect(card?.getAttribute("data-actionability")).not.toBe("FEED_LIMITED");
    expect(card?.getAttribute("data-actionability")).toBe("WAIT_FOR_CONFIRMATION");
    const text = textOf(container);
    expect(text).not.toMatch(/feed limited/i);
    expect(text).not.toMatch(/waiting for live data/i);
    expect(text).toContain("Broker symbol details needed");
    expect(text).not.toMatch(/awaiting live feed/i);
    expect(text).not.toMatch(/until live candles confirm/i);
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="scalp-build-V75"]');
    expect(btn!.disabled).toBe(true);
  });

  for (const reason of ["NO_SCANNER_READ", "NOT_LIVE", "INSUFFICIENT_DATA"] as const) {
    it(`${reason} stays a feed/data reason → FEED_LIMITED`, () => {
      const { container } = render(
        <ScalpSignalCard result={noSpecs({ rejectReason: reason })} onBuild={() => {}} />,
      );
      expect(
        container.querySelector('[data-testid="scalp-card-V75"]')?.getAttribute("data-actionability"),
      ).toBe("FEED_LIMITED");
    });
  }

  it("publishes under the engine timeframe ('5m'), never the 1m key", () => {
    const spy = vi.fn();
    render(
      <ScalpSignalCard
        result={makeResult({ symbol: "V75", timeframe: "M5" } as Partial<ScalpResult>)}
        onActionability={spy}
      />,
    );
    expect(spy).toHaveBeenCalledWith("V75", "5m", "READY_NOW");
    for (const call of spy.mock.calls) expect(call[1]).not.toBe("1m");
  });

  it("NO_SPECS publishes a retraction (null), so the header keeps its own data-only verdict", () => {
    const spy = vi.fn();
    render(<ScalpSignalCard result={noSpecs()} onActionability={spy} />);
    expect(spy).toHaveBeenLastCalledWith("V75", "5m", null);
  });

  it("a named feed reason is lifted as FEED_LIMITED under the engine timeframe", () => {
    const spy = vi.fn();
    render(<ScalpSignalCard result={noSpecs({ rejectReason: "NOT_LIVE" })} onActionability={spy} />);
    expect(spy).toHaveBeenLastCalledWith("V75", "5m", "FEED_LIMITED");
  });

  it("an AWAITING_DATA with no named reason (older server) is FEED_LIMITED on the card but never lifted", () => {
    const spy = vi.fn();
    const { container } = render(
      <ScalpSignalCard result={noSpecs({ rejectReason: undefined })} onActionability={spy} />,
    );
    expect(
      container.querySelector('[data-testid="scalp-card-V75"]')?.getAttribute("data-actionability"),
    ).toBe("FEED_LIMITED");
    expect(spy).toHaveBeenLastCalledWith("V75", "5m", null);
  });

  it("a READY verdict replaced by NO_SPECS on refresh is retracted, not left standing", () => {
    const spy = vi.fn();
    const { rerender } = render(
      <ScalpSignalCard
        result={makeResult({ symbol: "V75", timeframe: "M5" } as Partial<ScalpResult>)}
        onActionability={spy}
      />,
    );
    expect(spy).toHaveBeenLastCalledWith("V75", "5m", "READY_NOW");
    rerender(<ScalpSignalCard result={noSpecs()} onActionability={spy} />);
    expect(spy).toHaveBeenLastCalledWith("V75", "5m", null);
  });
});

// A failed news check is not LOW news risk: the risk chip must say it was not
// checked instead of rendering "News LOW" beside a no-scalp reason.
describe("ScalpSignalCard — unchecked news risk", () => {
  it("renders 'Unchecked' and never 'LOW' for news when the check failed", () => {
    const { container } = render(
      <ScalpSignalCard
        result={makeResult({
          status: "NO_CLEAN_SCALP",
          direction: null,
          canBuildTrade: false,
          canWatch: true,
          newsRisk: "LOW",
          newsRiskUnchecked: true,
          noTradeReason: "Scheduled news risk could not be checked, so no scalp is offered right now.",
          plainEnglishReason: "Scheduled news risk for this market could not be checked right now.",
        })}
      />,
    );
    expect(container.querySelector('[data-testid="scalp-news-unchecked"]')?.textContent).toBe("Unchecked");
    expect(textOf(container)).not.toMatch(/News\s*LOW/);
  });
});
