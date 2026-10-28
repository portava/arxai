// Live Trade Ticket status pill: a failed /api/me/live/arming read (or one that
// does not report the server master switch) used to show "READY TO ARM" and
// "Live trading not armed" — a known state the ticket never read. It now says
// the status is unknown. Display only: submit stays disabled either way.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/live/MasterLiveAccessGuard", () => ({
  useMasterLiveAccess: () => ({ canTrade: true, loaded: true, status: "APPROVED" }),
  MasterLiveAccessTicketBlock: () => null,
}));
vi.mock("@/components/live/TradabilityBadge", () => ({ TradabilityBadge: () => null }));
vi.mock("@/components/news/EventImpactBadge", () => ({ EventImpactBadge: () => null }));
vi.mock("@/lib/useTradability", () => ({ useTradability: () => ({ data: null }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => undefined }) }));

const { LiveTradeTicket, deriveStatus, armingReadKnown } = await import("./LiveTradeTicket");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(arming: { status: number; body: unknown }) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/me/live/arming")) return new Response(JSON.stringify(arming.body), { status: arming.status });
    return new Response(JSON.stringify({}), { status: 200 });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><LiveTradeTicket open onOpenChange={() => undefined} defaultSymbol="EURUSD" /></QueryClientProvider>);
}

describe("LiveTradeTicket status truth", () => {
  it("a failed arming read shows STATUS UNKNOWN, not READY TO ARM", async () => {
    mount({ status: 500, body: { error: "ARMING_READ_FAILED" } });
    await waitFor(() => expect(screen.getByTestId("badge-live-status").textContent).toBe("STATUS UNKNOWN"));
    expect(screen.getByTestId("live-arming-unknown").textContent).toMatch(/could not be read/);
    expect(document.body.textContent).not.toContain("Live trading not armed");
  });

  it("a never-armed user with the switch reported still reads READY TO ARM", async () => {
    mount({ status: 200, body: { arming: null, liveBrokerExecutionEnabled: true } });
    await waitFor(() => expect(screen.getByTestId("badge-live-status").textContent).toBe("READY TO ARM"));
  });

  it("an unreported master switch is unknown, not off", () => {
    expect(armingReadKnown({ isError: false, data: { arming: null } }).serverSwitch).toBe(false);
    expect(deriveStatus({
      accessLoaded: true, canTrade: true, armingLoaded: true, armed: true, killSwitch: false,
      liveOneClickEnabled: true, serverLiveExecutionEnabled: false, armingKnown: true, serverSwitchKnown: false,
    }).label).toBe("STATUS UNKNOWN");
  });
});
