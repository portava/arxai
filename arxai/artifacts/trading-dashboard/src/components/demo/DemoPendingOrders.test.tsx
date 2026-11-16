// @vitest-environment jsdom
// Demo pending orders list: shows only server rows (PLACED_DEMO) and Cancel
// queues CANCEL_PENDING_ORDER for that order ticket.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
const cancel = vi.fn(async () => ({ ok: true, status: "CANCELLED_DEMO", reason: null, commandId: "c9", via: "demo" as const }));
vi.mock("@/lib/tradeActions", () => ({ cancelDemoPendingOrder: (...a: unknown[]) => cancel(...(a as [])) }));

import { DemoPendingOrders, pendingOrderRows, pendingTypeLabel } from "./DemoPendingOrders";

const row = {
  commandId: "dmcmd_p1", orderTicket: "5001", symbol: "EURUSD", side: "BUY", orderType: "BUY_STOP_LIMIT",
  lotSize: 0.02, price: 1.105, stopLimitPrice: 1.103, stopLoss: 1.09, takeProfit: 1.12, expirationEpoch: null, placedAt: null,
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); cancel.mockClear(); toast.mockClear(); });

describe("DemoPendingOrders", () => {
  it("parses only the server's rows and labels MT5 types", () => {
    expect(pendingOrderRows({ items: [row, { nope: 1 }] })).toHaveLength(1);
    expect(pendingOrderRows({ ok: true })).toEqual([]);
    expect(pendingOrderRows(null)).toEqual([]);
    expect(pendingTypeLabel("SELL_STOP_LIMIT")).toBe("Sell Stop Limit");
  });

  it("renders nothing without pending orders", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
    const { container } = render(<DemoPendingOrders />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("lists a placed order and Cancel queues CANCEL_PENDING_ORDER for its ticket", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [row] }))));
    const onChanged = vi.fn();
    render(<DemoPendingOrders onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId("demo-pending-orders")).toBeTruthy());
    expect(screen.getByText("Buy Stop Limit")).toBeTruthy();
    expect(screen.getByText("GTC")).toBeTruthy();
    fireEvent.click(screen.getByTestId("cancel-pending-order"));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ orderTicket: "5001", symbol: "EURUSD" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(toast.mock.calls[0]![0]).toMatchObject({ title: "Pending order cancelled" });
  });
});
