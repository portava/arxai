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
import { cleanup, render, screen } from "@testing-library/react";
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
});
