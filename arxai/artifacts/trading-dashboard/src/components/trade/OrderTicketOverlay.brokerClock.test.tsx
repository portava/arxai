// @vitest-environment jsdom
// The order window's "Today" expiry uses the trader's own broker clock; when
// that clock is unknown it says "Today" ends 23:59 UTC.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const ocState = {
  mode: { on: false, scope: "live" as "live" | "demo" | null, canEnable: true, blockReason: null, defaultVolume: 0.1, maxLotPerClick: 2, loading: false },
  busyKey: null, switching: false,
  execute: vi.fn(), closePosition: vi.fn(), enable: vi.fn(), disable: vi.fn(),
};
vi.mock("@/hooks/useOneClickMode", () => ({ useOneClickMode: () => ocState }));
const placeOrder = vi.fn(async (_a: unknown) => ({ ok: true, status: "sent", reason: null, commandId: "c1", via: "standard" as const }));
vi.mock("@/lib/tradeActions", async (orig) => ({ ...(await orig<typeof import("@/lib/tradeActions")>()), placeOrder: (a: unknown) => placeOrder(a) }));

import { OrderTicketOverlay } from "./OrderTicketOverlay";

const quote = { symbol: "EURUSD", bid: 1.1, ask: 1.1002, available: true, stale: false, ageMs: 900, source: "mt5-ea" };

function renderTicket(clock: Record<string, unknown> | null) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/me/broker-clock")) return new Response(JSON.stringify(clock ?? { bridgeConnectionId: null, brokerClockOffsetMs: null, brokerClockOffsetMeasuredAt: null }));
    return new Response(JSON.stringify(quote));
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <OrderTicketOverlay open onOpenChange={() => {}} symbol="EURUSD" source="chart" />
    </QueryClientProvider>,
  );
}

async function pickTodayBuyLimit() {
  await waitFor(() => expect(screen.getByTestId("order-ticket-ask").textContent).toBe("1.10020"));
  fireEvent.click(screen.getByTestId("order-type-BUY_LIMIT"));
  fireEvent.change(screen.getByTestId("order-ticket-price"), { target: { value: "1.0990" } });
  fireEvent.click(screen.getByTestId("order-ticket-exp-TODAY"));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); placeOrder.mockClear(); });

describe("OrderTicketOverlay — Today on the broker clock", () => {
  it("shows the 23:59 UTC hint when the broker clock is unknown", async () => {
    renderTicket(null);
    await pickTodayBuyLimit();
    await waitFor(() => expect(screen.getByTestId("order-ticket-exp-broker-clock-hint").textContent).toBe("Broker clock unknown — 'Today' ends 23:59 UTC"));
  });

  it("no hint with a known offset, and the order carries it", async () => {
    renderTicket({ bridgeConnectionId: 7, brokerClockOffsetMs: 7_200_000, brokerClockOffsetMeasuredAt: "2026-11-04T09:00:00.000Z" });
    await pickTodayBuyLimit();
    await waitFor(() => expect((screen.getByTestId("order-ticket-submit") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("order-ticket-exp-broker-clock-hint")).toBeNull();
    fireEvent.click(screen.getByTestId("order-ticket-submit"));
    await waitFor(() => expect(placeOrder).toHaveBeenCalled());
    const arg = placeOrder.mock.calls[0]![0] as { draft: { expiration: string; brokerClockOffsetMs: number } };
    expect(arg.draft.expiration).toBe("TODAY");
    expect(arg.draft.brokerClockOffsetMs).toBe(7_200_000);
  });

  it("the hint is not shown for GTC", async () => {
    renderTicket(null);
    await waitFor(() => expect(screen.getByTestId("order-ticket-ask").textContent).toBe("1.10020"));
    fireEvent.click(screen.getByTestId("order-type-BUY_LIMIT"));
    expect(screen.queryByTestId("order-ticket-exp-broker-clock-hint")).toBeNull();
  });
});
