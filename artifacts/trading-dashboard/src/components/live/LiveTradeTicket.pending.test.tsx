// LiveTradeTicket offered Buy/Sell Limit, Stop and Stop Limit with no price,
// stop-limit or expiry inputs, so every pending order was sent without a price
// and refused MISSING_PENDING_PRICE. The standard ticket now has the inputs and
// the order window's rules (orderTicketRules.validateTicket), and sends them in
// the command payload.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/live/TradabilityBadge", () => ({ TradabilityBadge: () => null }));
vi.mock("@/components/news/EventImpactBadge", () => ({ EventImpactBadge: () => null }));
vi.mock("@/lib/useTradability", () => ({ useTradability: () => ({ data: null }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => undefined }) }));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ isAdminPreviewingUserMode: false, isLoading: false, envelope: {}, shouldShowAdminDiagnostics: false }),
}));
vi.mock("@/lib/useMt5Symbols", () => ({ resolveBrokerSymbol: vi.fn() }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Assistant" }) }));

const { LiveTradeTicket } = await import("./LiveTradeTicket");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubFetch() {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : {} });
    if (url.includes("/api/me/master-live/access")) {
      return new Response(JSON.stringify({ canTrade: true, status: "APPROVED", blockReason: null, message: null, limits: { requireStopLoss: true } }));
    }
    if (url.includes("/api/me/live/arming")) {
      return new Response(JSON.stringify({ arming: { isArmed: true, killSwitchEngaged: false, maxLotConfirmed: 1, accountNumberConfirmed: "1", brokerServerConfirmed: "B" }, liveBrokerExecutionEnabled: true }));
    }
    if (url.endsWith("/api/me/live/commands")) return new Response(JSON.stringify({ ok: true, command: { commandId: "L1" } }));
    return new Response(JSON.stringify({ ok: true }));
  }));
  return posts;
}

describe("LiveTradeTicket pending orders", () => {
  it("a Buy Limit needs a price before Confirm, then the price rides in the payload", async () => {
    const posts = stubFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><LiveTradeTicket open onOpenChange={() => undefined} defaultSymbol="EURUSD" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("badge-live-status").textContent).not.toBe("LOADING"));
    fireEvent.click(screen.getByTestId("btn-order-type-BUY_LIMIT"));
    expect(screen.getByTestId("live-pending-fields")).toBeTruthy();
    fireEvent.change(screen.getByTestId("input-live-sl"), { target: { value: "1.08" } });
    await waitFor(() => expect(screen.getByTestId("live-confirm-disabled-reason").textContent).toMatch(/Buy Limit needs a price/));
    expect((screen.getByTestId("btn-submit-live-order") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("input-live-price"), { target: { value: "1.09" } });
    await waitFor(() => expect((screen.getByTestId("btn-submit-live-order") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("btn-submit-live-order"));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/api/me/live/commands"))).toBe(true));
    const draft = posts.find((p) => p.url.endsWith("/api/me/live/commands"))!.body;
    expect(draft).toMatchObject({ commandType: "PLACE_LIVE_PENDING_ORDER", orderType: "BUY_LIMIT", payload: { price: 1.09, stopLimitPrice: null, expiration: null, expirationEpoch: null } });
  });

  it("a Stop Limit needs its limit leg on the right side of the stop", async () => {
    stubFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><LiveTradeTicket open onOpenChange={() => undefined} defaultSymbol="EURUSD" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("badge-live-status").textContent).not.toBe("LOADING"));
    fireEvent.click(screen.getByTestId("btn-order-type-BUY_STOP_LIMIT"));
    fireEvent.change(screen.getByTestId("input-live-sl"), { target: { value: "1.08" } });
    fireEvent.change(screen.getByTestId("input-live-price"), { target: { value: "1.11" } });
    fireEvent.change(screen.getByTestId("input-live-stop-limit"), { target: { value: "1.12" } });
    await waitFor(() => expect(screen.getByTestId("live-confirm-disabled-reason").textContent).toMatch(/limit price must be below the stop price/));
  });
});
