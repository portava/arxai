// Live ticket add-on read: reading age.
//
// The add-on check reads the same open positions as the Position Manager. When
// the MT5 bridge stopped syncing hours ago, the Position Manager says the
// positions are not live, but this panel showed the add-on badge, the flame
// stage and "x/y adds used · N left" with no time and no stale note, as if
// they described the account now. The server now sends positionsAsOf and
// positionsStale for the add-on check (same rule as the baskets response).
//
// The generated mutation hook is replaced by a stub that returns fixed data.

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { MeScalpAddOnCheckResp } from "@workspace/api-client-react";

let checkData: MeScalpAddOnCheckResp | undefined;
const mutate = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useCreateMeScalpAddOnCheck: () => ({ mutate, data: checkData }),
  };
});

vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

import { LiveScalpAddOnPanel } from "./LiveScalpAddOnPanel";

function resp(over: Partial<MeScalpAddOnCheckResp>): MeScalpAddOnCheckResp {
  return {
    symbol: "EURUSD",
    direction: "BUY",
    hasOpenBasket: true,
    positionsMeasured: true,
    positionsNote: null,
    basket: null,
    addOn: {
      recommendation: "ADD_OK", maxAddOns: 3, usedAddOns: 1, remainingAddOns: 2, allowed: true,
      revengeGuardTriggered: false, requiresFreshConfirmation: false, profitCushion: null,
      reason: "Profit cushion covers one more leg.",
    },
    flame: { flameStage: "ACTIVE" },
    generatedAt: new Date().toISOString(),
    ...over,
  } as unknown as MeScalpAddOnCheckResp;
}

afterEach(() => {
  cleanup();
  checkData = undefined;
  mutate.mockClear();
});

describe("LiveScalpAddOnPanel reading age", () => {
  it("says the add-on read describes an old, not-live reading when the server flags it stale", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    checkData = resp({ positionsStale: true, positionsAsOf: threeHoursAgo });
    render(<LiveScalpAddOnPanel symbol="EURUSD" side="BUY" />);
    const panel = screen.getByTestId("ls-scalp-addon");
    expect(panel.getAttribute("data-stale")).toBe("true");
    const note = screen.getByTestId("ls-scalp-addon-stale");
    expect(note.textContent).toMatch(/not live/i);
    expect(note.textContent).toMatch(/may have changed or closed/i);
    expect(note.textContent).toContain(new Date(threeHoursAgo).toLocaleString());
    expect(note.textContent).toMatch(/3h 0m ago/);
    expect(screen.getByTestId("ls-scalp-addon-not-live").textContent).toMatch(/not live/i);
  });

  it("says no reading time is recorded when the stale reading has none", () => {
    checkData = resp({ positionsStale: true, positionsAsOf: null });
    render(<LiveScalpAddOnPanel symbol="EURUSD" side="BUY" />);
    expect(screen.getByTestId("ls-scalp-addon-stale").textContent).toMatch(/no reading time is recorded/i);
  });

  it("shows the reading time, and no stale note, for a current reading", () => {
    const justNow = new Date(Date.now() - 5_000).toISOString();
    checkData = resp({ positionsStale: false, positionsAsOf: justNow });
    render(<LiveScalpAddOnPanel symbol="EURUSD" side="BUY" />);
    expect(screen.queryByTestId("ls-scalp-addon-stale")).toBeNull();
    expect(screen.queryByTestId("ls-scalp-addon-not-live")).toBeNull();
    expect(screen.getByTestId("ls-scalp-addon-as-of").textContent).toContain(new Date(justNow).toLocaleString());
  });

  // Pass 3 review: the check runs once per symbol/side and never refetches,
  // so a reading that was current when the ticket opened kept reading as
  // current ("(5s ago)", no "Not live") after the bridge stopped syncing.
  // The panel now ages the reading against a ticking clock and downgrades it
  // past the server's 90s freshness window.
  it("a reading that was current when the ticket opened is shown as not live once it ages past 90s", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-03T10:00:10.000Z"));
      const asOf = "2026-11-03T10:00:05.000Z";
      checkData = resp({ positionsStale: false, positionsAsOf: asOf });
      render(<LiveScalpAddOnPanel symbol="EURUSD" side="BUY" />);
      expect(screen.getByTestId("ls-scalp-addon").getAttribute("data-stale")).toBe("false");
      expect(screen.getByTestId("ls-scalp-addon-as-of").textContent).toMatch(/\(5s ago\)/);

      // Ten minutes later, nothing re-rendered the ticket and no refetch ran.
      act(() => { vi.advanceTimersByTime(10 * 60_000); });
      expect(screen.getByTestId("ls-scalp-addon").getAttribute("data-stale")).toBe("true");
      expect(screen.getByTestId("ls-scalp-addon-not-live").textContent).toMatch(/not live/i);
      expect(screen.queryByTestId("ls-scalp-addon-as-of")).toBeNull();
      const note = screen.getByTestId("ls-scalp-addon-stale").textContent ?? "";
      expect(note).toContain(new Date(asOf).toLocaleString());
      expect(note).toMatch(/10 min ago/);
      expect(note).not.toMatch(/5s ago/);
      expect(mutate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the age of a current reading keeps moving while the ticket is open", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-03T10:00:10.000Z"));
      checkData = resp({ positionsStale: false, positionsAsOf: "2026-11-03T10:00:05.000Z" });
      render(<LiveScalpAddOnPanel symbol="EURUSD" side="BUY" />);
      act(() => { vi.advanceTimersByTime(40_000); });
      expect(screen.getByTestId("ls-scalp-addon").getAttribute("data-stale")).toBe("false");
      expect(screen.getByTestId("ls-scalp-addon-as-of").textContent).toMatch(/\(45s ago\)/);
    } finally {
      vi.useRealTimers();
    }
  });
});
