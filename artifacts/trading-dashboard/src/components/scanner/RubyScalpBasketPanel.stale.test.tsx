// Position Manager sync-staleness render proof (STALE_UNLABELED fix) — the
// panel used to render `combinedFloatingPl` as bare "Open P/L" with no
// freshness signal, so when the bridge was down (server rows hours old, some
// positions possibly already closed at the broker) the numbers read as
// current. The server now stamps every basket with a `sync` block judged
// against NOW; this suite proves at the DOM level:
//
//   1. A stale-sync basket renders the amber staleness banner and the
//      "as of HH:MM — not live" note on Open P/L (visually distinct from the
//      genuine "no open positions" empty state).
//   2. A fresh-sync basket renders neither.
//   3. A basket with no sync block (older server) degrades gracefully —
//      nothing new renders, and nothing claims freshness.
//
// Display-only assertions. The panel remains 100% read-only / ALERT_ONLY.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { ScalpBasket } from "@workspace/api-client-react";

const h = vi.hoisted(() => ({
  baskets: [] as unknown[],
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMeScalpBaskets: () => ({
    data: { baskets: h.baskets, accountMode: "LIVE_SHARED", generatedAt: new Date().toISOString() },
    isError: false,
    isPending: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  // Pulled in transitively by @/lib/assistant-name (provider not rendered here).
  useGetMeAssistantSettings: () => ({ data: undefined, isLoading: false }),
  getGetMeAssistantSettingsQueryKey: () => ["assistant-settings"],
}));

import { RubyScalpBasketPanel } from "./RubyScalpBasketPanel";

afterEach(() => cleanup());

function makeBasket(over: Record<string, unknown> = {}): ScalpBasket {
  return {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    direction: "BUY",
    accountMode: "LIVE",
    entryCount: 1,
    totalVolume: 0.5,
    averageEntry: 1.1,
    currentPrice: 1.105,
    combinedFloatingPl: 12.5,
    breakEvenPrice: 1.1,
    hasUnprotectedLeg: false,
    legs: [],
    flame: {
      scalpStatus: "STRONG",
      readDirection: "BUY",
      scalpScore: 82,
      flameStage: "ACTIVE",
      flameAgeCandles: 2,
      freshness: "FRESH",
      entryTiming: "CLEAN",
      chaseRisk: "LOW",
      runway: "CLEAR",
      executionQuality: "GOOD",
      htfContext: "ALIGNED",
      setupType: "CONTINUATION",
      riskPersonality: "BALANCED",
      whyNow: "Fresh burst",
      entryTrigger: "Break and hold",
      targetIdea: "Next level",
      invalidationIdea: "Loss of the low",
      decayNote: null,
      blind: false,
    },
    exit: {
      urgency: "NONE",
      action: "HOLD",
      headline: "Looking healthy",
      detail: "Let it work.",
      alertOnly: true,
    },
    addOn: {
      recommendation: "HOLD",
      maxAddOns: 1,
      usedAddOns: 0,
      remainingAddOns: 1,
      allowed: true,
      revengeGuardTriggered: false,
      requiresFreshConfirmation: false,
      profitCushion: 12.5,
      reason: "Hold what you have.",
    },
    generatedAt: new Date().toISOString(),
    ...over,
  } as unknown as ScalpBasket;
}

describe("RubyScalpBasketPanel — broker-sync staleness is labeled, never silent", () => {
  it("renders the stale banner and the as-of P/L note on a stale-sync basket", () => {
    const syncedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    h.baskets = [
      makeBasket({ sync: { syncedAt, ageSeconds: 3 * 60 * 60, stale: true } }),
    ];
    const { container } = render(<RubyScalpBasketPanel />);
    const row = container.querySelector('[data-testid="scalp-basket-row"]');
    expect(row?.getAttribute("data-sync-stale")).toBe("true");
    const banner = container.querySelector('[data-testid="scalp-basket-stale"]');
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toMatch(/stale/i);
    expect(banner!.textContent).toMatch(/not live/i);
    expect(banner!.textContent).toMatch(/3h/); // the honest age
    const asOf = container.querySelector('[data-testid="scalp-basket-pl-asof"]');
    expect(asOf).toBeTruthy();
    expect(asOf!.textContent).toMatch(/as of/i);
  });

  it("says the sync time is unknown (still stale) when the feed never reported one", () => {
    h.baskets = [makeBasket({ sync: { syncedAt: null, ageSeconds: null, stale: true } })];
    const { container } = render(<RubyScalpBasketPanel />);
    const banner = container.querySelector('[data-testid="scalp-basket-stale"]');
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toMatch(/hasn't reported a sync time/i);
  });

  it("renders no staleness UI on a fresh-sync basket", () => {
    h.baskets = [
      makeBasket({
        sync: { syncedAt: new Date().toISOString(), ageSeconds: 5, stale: false },
      }),
    ];
    const { container } = render(<RubyScalpBasketPanel />);
    expect(container.querySelector('[data-testid="scalp-basket-stale"]')).toBeNull();
    expect(container.querySelector('[data-testid="scalp-basket-pl-asof"]')).toBeNull();
    const row = container.querySelector('[data-testid="scalp-basket-row"]');
    expect(row?.getAttribute("data-sync-stale")).toBeNull();
  });

  it("degrades gracefully when the sync block is missing entirely (older server)", () => {
    h.baskets = [makeBasket()];
    const { container } = render(<RubyScalpBasketPanel />);
    expect(container.querySelector('[data-testid="scalp-basket-row"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="scalp-basket-stale"]')).toBeNull();
    expect(container.querySelector('[data-testid="scalp-basket-pl-asof"]')).toBeNull();
  });
});
