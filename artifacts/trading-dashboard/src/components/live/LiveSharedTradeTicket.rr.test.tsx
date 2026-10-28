// Live shared-account ticket: "Estimated R:R" was |TP| / |SL| — the ratio of
// two absolute prices (EURUSD SL 1.0800 / TP 1.0900 read "R:R 1.01"), not a
// reward-to-risk ratio, which needs the entry price this market ticket lacks.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/components/live/MasterLiveAccessGuard", () => ({
  useMasterLiveAccess: () => ({ canTrade: true, loaded: true, requireStopLoss: true }),
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

describe("LiveSharedTradeTicket R:R", () => {
  it("never shows a ratio of absolute SL / TP prices as R:R", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ armed: false }))));
    render(<LiveSharedTradeTicket open onOpenChange={() => undefined} defaultSymbol="EURUSD" defaultSide="BUY" />);
    fireEvent.change(screen.getByTestId("ls-sl"), { target: { value: "1.08" } });
    fireEvent.change(screen.getByTestId("ls-tp"), { target: { value: "1.09" } });
    const ticket = screen.getByTestId("live-shared-trade-ticket").textContent ?? "";
    expect(ticket).not.toContain("1.01");
    expect(ticket).not.toContain("Estimated R:R");
    expect(screen.getByTestId("ls-summary-rr").textContent).toMatch(/needs the live entry price/);
  });
});
