// Trade Action Center truth: a rejected action is attributed to whoever
// actually refused it. A failed ARX pre-trade guard (kill switch, stale
// price, risk limit) never reaches a broker, so it is not labelled "Broker:".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@/components/action-center/TradeActionReviewModal", () => ({
  TradeActionReviewModal: () => null,
}));

const { default: ActionCenterPage } = await import("./action-center");

let actions: unknown[];

beforeEach(() => {
  actions = [];
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, actions }),
  }) as unknown as Response));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

function action(over: Record<string, unknown>) {
  return {
    id: 1,
    status: "rejected",
    actionType: "OPEN_TRADE",
    requestedMode: "DEMO",
    symbol: "EURUSD",
    reason: null,
    rejectionReason: null,
    createdAt: "2026-10-28T10:00:00.000Z",
    ...over,
  };
}

async function renderAllTab() {
  render(<ActionCenterPage />);
  await flush();
  // Rejected rows are listed on the "All" tab.
  const tab = screen.getByTestId("tab-all");
  await act(async () => {
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

describe("Trade Action Center rejection attribution", () => {
  it("a failed ARX guard is not labelled as a broker rejection", async () => {
    actions = [action({
      rejectionReason: "Kill switch engaged",
      guardResult: { passed: false, failedCheckId: "kill_switch", rejectionReason: "Kill switch engaged", checks: [] },
    })];
    await renderAllTab();
    const text = screen.getByTestId("text-rejected-1").textContent ?? "";
    expect(text.startsWith("Broker:")).toBe(false);
    expect(text).toMatch(/ARX safety check/);
    expect(text).toMatch(/not sent to a broker/i);
    expect(text).toContain("Kill switch engaged");
  });

  it("a refusal reported back by the broker is labelled Broker", async () => {
    actions = [action({
      rejectionReason: "Invalid stops",
      brokerMessage: "Invalid stops",
      errorCode: "10016",
      executionVenue: "DEMO",
      guardResult: { passed: true, failedCheckId: null, rejectionReason: null, checks: [] },
    })];
    await renderAllTab();
    const text = screen.getByTestId("text-rejected-1").textContent ?? "";
    expect(text).toBe("Broker: Invalid stops");
  });

  it("a venue-queue refusal is not attributed to a broker", async () => {
    actions = [action({
      rejectionReason: "The DEMO queue refused this action: RISK_GOVERNOR_BLOCK.",
      executionVenue: "DEMO",
      guardResult: { passed: true, failedCheckId: null, rejectionReason: null, checks: [] },
    })];
    await renderAllTab();
    const text = screen.getByTestId("text-rejected-1").textContent ?? "";
    expect(text.startsWith("Broker:")).toBe(false);
    expect(text).toContain("The DEMO queue refused this action");
  });
});

describe("Trade Action Center subtitle", () => {
  it("scopes the confirmation claim to actions drafted here and names the automation that does not wait", async () => {
    render(<ActionCenterPage />);
    await flush();
    const subtitle = screen.getByTestId("text-action-center-scope").textContent ?? "";
    expect(subtitle).not.toMatch(/ARX never executes automatically/);
    expect(subtitle).toMatch(/drafted for you here/i);
    expect(subtitle).toMatch(/until you confirm them/i);
    expect(subtitle).toMatch(/autopilot sessions place simulator and paper trades on their own/i);
    expect(subtitle).toMatch(/Protective Auto-Close/);
  });
});
