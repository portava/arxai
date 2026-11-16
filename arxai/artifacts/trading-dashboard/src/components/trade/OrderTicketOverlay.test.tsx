// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const ocState = {
  mode: { on: false, scope: "live" as "live" | "demo" | null, canEnable: true, blockReason: null, defaultVolume: 0.1, maxLotPerClick: 2, loading: false },
  busyKey: null, switching: false,
  execute: vi.fn(), closePosition: vi.fn(), enable: vi.fn(), disable: vi.fn(),
};
vi.mock("@/hooks/useOneClickMode", () => ({ useOneClickMode: () => ocState }));

const placeOrder = vi.fn(async () => ({ ok: true, status: "sent", reason: null, commandId: "c1", via: "standard" as const }));
vi.mock("@/lib/tradeActions", async (orig) => ({ ...(await orig<typeof import("@/lib/tradeActions")>()), placeOrder: (...a: unknown[]) => placeOrder(...(a as [])) }));

import { OrderTicketButton, OrderTicketOverlay } from "./OrderTicketOverlay";

const quote = { symbol: "EURUSD", bid: 1.1000, ask: 1.1002, available: true, stale: false, ageMs: 900, source: "mt5-ea" };

function renderTicket(props: Partial<React.ComponentProps<typeof OrderTicketOverlay>> = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(quote))));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPlaced = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <OrderTicketOverlay open onOpenChange={onOpenChange} symbol="EURUSD" source="chart" onPlaced={onPlaced} {...props} />
    </QueryClientProvider>,
  );
  return { onPlaced, onOpenChange };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); placeOrder.mockClear(); toast.mockClear(); ocState.mode.on = false; ocState.mode.scope = "live"; });

describe("OrderTicketOverlay", () => {
  it("shows the eight MT5 order types, the live Bid/Ask and the MT5 button wording", async () => {
    renderTicket();
    await waitFor(() => expect(screen.getByTestId("order-ticket-ask").textContent).toBe("1.10020"));
    expect(screen.getByTestId("order-ticket-bid").textContent).toBe("1.10000");
    for (const id of ["MARKET_BUY", "MARKET_SELL", "BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP", "BUY_STOP_LIMIT", "SELL_STOP_LIMIT"]) {
      expect(screen.getByTestId(`order-type-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId("order-ticket-submit").textContent).toContain("Buy by Market");
    fireEvent.click(screen.getByTestId("order-type-SELL_LIMIT"));
    expect(screen.getByTestId("order-ticket-submit").textContent).toContain("Place Sell Limit");
    expect(screen.getByTestId("order-type-hint").textContent).toMatch(/above the Bid/);
  });

  it("refuses a Buy Limit above the Ask before any request, and places it once the price is below", async () => {
    const { onPlaced, onOpenChange } = renderTicket();
    await waitFor(() => expect(screen.getByTestId("order-ticket-ask").textContent).toBe("1.10020"));
    fireEvent.click(screen.getByTestId("order-type-BUY_LIMIT"));
    fireEvent.change(screen.getByTestId("order-ticket-price"), { target: { value: "1.1010" } });
    expect((screen.getByTestId("order-ticket-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("order-ticket-error").textContent).toMatch(/Buy Limit price must be below the Ask/);
    fireEvent.change(screen.getByTestId("order-ticket-price"), { target: { value: "1.0990" } });
    fireEvent.change(screen.getByTestId("order-ticket-sl"), { target: { value: "1.0940" } });
    fireEvent.change(screen.getByTestId("order-ticket-tp"), { target: { value: "1.1090" } });
    expect(screen.getByTestId("order-ticket-rr").textContent).toMatch(/1 : 2/);
    expect((screen.getByTestId("order-ticket-submit") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("order-ticket-submit"));
    await waitFor(() => expect(placeOrder).toHaveBeenCalledTimes(1));
    const args = placeOrder.mock.calls[0]![0] as unknown as { scope: string; oneClickOn: boolean; draft: { orderType: string; price: number; lot: number; stopLoss: number } };
    expect(args).toMatchObject({ scope: "live", oneClickOn: false, draft: { orderType: "BUY_LIMIT", price: 1.099, lot: 0.1, stopLoss: 1.094 } });
    await waitFor(() => expect(onPlaced).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stop limit needs the limit leg on the correct side of the stop; expiry choices appear for pending orders", async () => {
    renderTicket();
    await waitFor(() => expect(screen.getByTestId("order-ticket-ask").textContent).toBe("1.10020"));
    fireEvent.click(screen.getByTestId("order-type-BUY_STOP_LIMIT"));
    fireEvent.change(screen.getByTestId("order-ticket-price"), { target: { value: "1.1010" } });
    fireEvent.change(screen.getByTestId("order-ticket-stop-limit"), { target: { value: "1.1015" } });
    expect(screen.getByTestId("order-ticket-error").textContent).toMatch(/limit price must be below the stop/);
    fireEvent.change(screen.getByTestId("order-ticket-stop-limit"), { target: { value: "1.1005" } });
    expect((screen.getByTestId("order-ticket-submit") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("order-ticket-exp-GTC")).toBeTruthy();
    fireEvent.click(screen.getByTestId("order-ticket-exp-SPECIFIED"));
    expect(screen.getByTestId("order-ticket-exp-at")).toBeTruthy();
    expect((screen.getByTestId("order-ticket-submit") as HTMLButtonElement).disabled).toBe(true); // no date yet
  });

  it("a market order is disabled while the quote is stale; a pending order is not", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...quote, stale: true }))));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><OrderTicketOverlay open onOpenChange={() => {}} symbol="EURUSD" source="chart" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("order-ticket-error").textContent).toMatch(/stale/));
    expect((screen.getByTestId("order-ticket-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("order-type-SELL_STOP"));
    fireEvent.change(screen.getByTestId("order-ticket-price"), { target: { value: "1.0950" } });
    expect((screen.getByTestId("order-ticket-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("demo: pending types are sent and the server's EA-version refusal is shown in plain words", async () => {
    ocState.mode.scope = "demo";
    const { DEMO_PENDING_UNSUPPORTED_NOTE } = await import("@/lib/tradeActions");
    placeOrder.mockImplementationOnce(async () => ({ ok: false, status: "FAILED", reason: DEMO_PENDING_UNSUPPORTED_NOTE, commandId: null, via: "demo" as const }) as never);
    renderTicket();
    await waitFor(() => expect(screen.getByTestId("order-ticket-ask").textContent).toBe("1.10020"));
    fireEvent.click(screen.getByTestId("order-type-BUY_STOP"));
    fireEvent.change(screen.getByTestId("order-ticket-price"), { target: { value: "1.1050" } });
    const submit = screen.getByTestId("order-ticket-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(placeOrder).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("order-ticket-error").textContent).toMatch(/older than v1\.32/));
  });

  it("the trigger button opens the ticket", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(quote))));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><OrderTicketButton symbol="EURUSD" source="scanner" /></QueryClientProvider>);
    expect(screen.queryByTestId("order-ticket")).toBeNull();
    fireEvent.click(screen.getByTestId("order-ticket-open"));
    expect(screen.getByTestId("order-ticket")).toBeTruthy();
  });
});
