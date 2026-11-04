// Live Shared page: a failed live-access read is "could not be checked", not a
// refusal.
//
// When /api/me/master-live/access returns 500 or the request never reaches the
// server, useMasterLiveAccess sets `error` and canTrade:false (fail-closed).
// The page never read `error`: the Place Trade tab's "Trade blocked — why?"
// said "Live shared trading is not available on your account right now." and
// the SL/TP tab said "SL/TP modification is admin-gated." Both are refusal
// claims for a read that failed. The ticket button stays disabled; only the
// words change.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

let access: Record<string, unknown> = {};

vi.mock("@/lib/api/liveShared", () => ({
  getMyLiveSharedCommands: async () => ({ commands: [] }),
  getMyLiveSharedTrades: async () => ({ attributions: [] }),
  modifyLiveSharedTrade: vi.fn(),
  closeLiveSharedTrade: vi.fn(),
  cancelLiveSharedPendingOrder: vi.fn(),
}));
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({
  useMasterLiveAccess: () => access,
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ envelope: {}, isLiveShared: true, cleanBlockedReason: null, cleanModeLabel: "LIVE" }),
}));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/components/live/LiveSharedTradeTicket", () => ({ LiveSharedTradeTicket: () => null }));
vi.mock("@/components/live/LiveSharedStatusPanel", () => ({ LiveSharedStatusPanel: () => null }));
vi.mock("@/components/live/TradeHealthPanel", () => ({ TradeHealthPanel: () => null }));

const { default: LiveSharedPage } = await import("./live-shared");

const FAILED = {
  loaded: true, canTrade: false, status: null, blockReason: null, message: null,
  requireStopLoss: true, scannerLiveEnabled: false,
  error: "Live access could not be checked (HTTP 500).",
};

afterEach(() => cleanup());

async function openTab(id: string) {
  fireEvent.mouseDown(screen.getByTestId(id), { button: 0, ctrlKey: false });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("live-shared when the live-access read fails", () => {
  it("Place Trade says access could not be checked, keeps the ticket closed, and makes no refusal claim", async () => {
    access = FAILED;
    render(<LiveSharedPage />);
    const btn = screen.getByTestId("ls-open-ticket") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const note = screen.getByTestId("ls-place-access-unknown");
    expect(note.textContent).toContain("Live access could not be checked (HTTP 500).");
    expect(note.textContent).toMatch(/Reload the page/);
    expect(document.body.textContent).not.toMatch(/not available on your account/);
    expect(document.body.textContent).not.toMatch(/Trade blocked/);
  });

  it("SL/TP Manager says access could not be checked, not 'admin-gated'", async () => {
    access = FAILED;
    render(<LiveSharedPage />);
    await openTab("tab-sltp");
    expect(screen.getByTestId("ls-sltp-access-unknown").textContent).toContain("Live access could not be checked (HTTP 500).");
    expect(document.body.textContent).not.toMatch(/admin-gated/);
  });

  it("a real refusal (read succeeded, canTrade false) keeps the refusal copy", async () => {
    access = { ...FAILED, error: null, message: "Your account is not approved for master live trading.", blockReason: "USER_MASTER_LIVE_NOT_APPROVED" };
    render(<LiveSharedPage />);
    expect(screen.queryByTestId("ls-place-access-unknown")).toBeNull();
    expect(document.body.textContent).toMatch(/Trade blocked/);
    expect(document.body.textContent).toMatch(/not approved for master live trading/);
    await openTab("tab-sltp");
    expect(screen.queryByTestId("ls-sltp-access-unknown")).toBeNull();
  });
});
