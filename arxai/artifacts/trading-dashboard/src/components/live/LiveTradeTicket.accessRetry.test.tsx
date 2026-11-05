// "Reopen the ticket to retry" must actually retry the ticket's access read.
//
// LiveTradeTicket and LiveSharedTradeTicket call useMasterLiveAccess at the
// top of the component. Their parents keep them mounted and only toggle
// `open`, and the hook re-read access only on mount, window focus or
// visibilitychange. After a failed read the ticket told the user "Live access
// could not be checked. Reopen the ticket to retry." — but reopening re-read
// nothing: the pill stayed ACCESS NOT CHECKED while the inline access block
// (inside the dialog, so remounted on reopen) showed the fresh verdict. The
// hook now re-reads when the ticket is reopened. Fail-closed is unchanged: a
// read that fails again still disables Confirm.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/live/TradabilityBadge", () => ({ TradabilityBadge: () => null }));
vi.mock("@/components/news/EventImpactBadge", () => ({ EventImpactBadge: () => null }));
vi.mock("@/lib/useTradability", () => ({ useTradability: () => ({ data: null }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => undefined }) }));
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
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Eleanor" }) }));

const { LiveTradeTicket } = await import("./LiveTradeTicket");
const { LiveSharedTradeTicket } = await import("./LiveSharedTradeTicket");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const APPROVED = { canTrade: true, status: "APPROVED", blockReason: null, message: null, limits: { requireStopLoss: true } };

/** The access endpoint fails until `recover()` is called, then answers APPROVED. */
function stubFetch() {
  let accessOk = false;
  let accessReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/me/master-live/access")) {
      accessReads += 1;
      return accessOk
        ? new Response(JSON.stringify(APPROVED), { status: 200 })
        : new Response(JSON.stringify({ error: "db unavailable" }), { status: 500 });
    }
    if (url.includes("/api/me/live/arming")) {
      return new Response(JSON.stringify({ arming: null, liveBrokerExecutionEnabled: true }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }));
  return { recover: () => { accessOk = true; }, reads: () => accessReads };
}

describe("reopening a live ticket re-reads live access", () => {
  it("LiveTradeTicket: after a failed read, reopening re-reads access and the pill and Confirm reason follow it", async () => {
    const f = stubFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (open: boolean) => (
      <QueryClientProvider client={qc}><LiveTradeTicket open={open} onOpenChange={() => undefined} defaultSymbol="EURUSD" /></QueryClientProvider>
    );
    const { rerender } = render(ui(true));
    await waitFor(() => expect(screen.getByTestId("badge-live-status").textContent).toBe("ACCESS NOT CHECKED"));
    expect(screen.getByTestId("live-confirm-disabled-reason").textContent).toMatch(/could not be checked\. Reopen the ticket to retry/);

    f.recover();
    const readsBefore = f.reads();
    rerender(ui(false));
    rerender(ui(true));
    await waitFor(() => expect(screen.getByTestId("badge-live-status").textContent).not.toBe("ACCESS NOT CHECKED"));
    expect(f.reads()).toBeGreaterThan(readsBefore);
    expect(screen.queryByTestId("live-confirm-disabled-reason")?.textContent ?? "").not.toMatch(/Live access could not be checked/);
  });

  it("LiveSharedTradeTicket: after a failed read, reopening re-reads access", async () => {
    const f = stubFetch();
    const ui = (open: boolean) => (
      <LiveSharedTradeTicket open={open} onOpenChange={() => undefined} defaultSymbol="EURUSD" defaultSide="BUY" />
    );
    const { rerender } = render(ui(true));
    await waitFor(() => expect(screen.getByTestId("ls-access-unknown").textContent).toMatch(/Reopen the ticket to retry/));

    f.recover();
    rerender(ui(false));
    rerender(ui(true));
    await waitFor(() => expect(screen.queryByTestId("ls-access-unknown")).toBeNull());
  });

  it("a ticket that stays open does not re-read access on every render", async () => {
    const f = stubFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = () => (
      <QueryClientProvider client={qc}><LiveTradeTicket open onOpenChange={() => undefined} defaultSymbol="EURUSD" /></QueryClientProvider>
    );
    const { rerender } = render(ui());
    await waitFor(() => expect(screen.getByTestId("badge-live-status").textContent).toBe("ACCESS NOT CHECKED"));
    const reads = f.reads();
    rerender(ui());
    rerender(ui());
    await new Promise((r) => setTimeout(r, 20));
    expect(f.reads()).toBe(reads);
  });
});
