// Live shared ticket: when the /api/me/master-live/access read failed, the
// verdict was canTrade:false like a real refusal and the ticket said "Live
// access pending — your live bridge isn't ready to trade yet". Nothing about
// the bridge or approval was known. It now says access could not be checked.
// No order inputs are shown either way (fail-closed).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const access = { canTrade: false, loaded: true, requireStopLoss: true, status: null as string | null, error: null as string | null };
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({
  useMasterLiveAccess: () => access,
  MasterLiveAccessTicketBlock: () => null,
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ isAdminPreviewingUserMode: false, isLoading: false, envelope: {}, shouldShowAdminDiagnostics: false }),
}));
vi.mock("@/lib/api/liveShared", () => ({
  executeLiveSharedTrade: vi.fn(),
  suggestLiveSharedSltp: vi.fn(async () => ({ ok: false, userMessage: "No suggestion." })),
}));
vi.mock("./ExecutionPreviewPanel", () => ({ ExecutionPreviewPanel: () => null }));
vi.mock("@/components/live/LiveScalpAddOnPanel", () => ({ LiveScalpAddOnPanel: () => null }));
vi.mock("@/components/mt5/OneClickArmedBadge", () => ({ OneClickArmedBadge: () => null }));
vi.mock("@/lib/useMt5Symbols", () => ({ resolveBrokerSymbol: vi.fn() }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

const { LiveSharedTradeTicket } = await import("./LiveSharedTradeTicket");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ armed: false }))));
  render(<LiveSharedTradeTicket open onOpenChange={() => undefined} defaultSymbol="EURUSD" defaultSide="BUY" />);
  return screen.getByTestId("live-shared-trade-ticket").textContent ?? "";
}

describe("LiveSharedTradeTicket access read truth", () => {
  it("a failed access read says access could not be checked, not 'Live access pending'", () => {
    access.error = "Live access could not be checked (HTTP 500).";
    const text = mount();
    expect(text).toMatch(/Live access could not be checked/);
    expect(text).toContain("HTTP 500");
    expect(text).not.toMatch(/Live access pending|bridge isn't ready/);
    expect(screen.queryByTestId("ls-sl")).toBeNull();
  });

  it("a real refusal still reads 'Live access pending'", () => {
    access.error = null;
    const text = mount();
    expect(text).toMatch(/Live access pending/);
    expect(screen.queryByTestId("ls-sl")).toBeNull();
  });
});
