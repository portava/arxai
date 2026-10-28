// Regression: Orders showed "No pending orders yet. Orders you place will show
// up here." for any empty filter (e.g. "Closed" with 10 filled orders present)
// and after a failed /api/orders fetch, which also left "0 of 0" as if the
// book were empty.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";

const { default: OrdersPage } = await import("./orders");

function order(i: number) {
  return {
    orderId: `ord_${i}_abcdefgh`, environment: "DEMO_SIMULATOR", source: "MANUAL", symbol: "EURUSD", direction: "BUY",
    orderType: "MARKET", lotSize: 0.05, status: "FILLED_SIMULATOR", createdAt: "2026-10-28T09:00:00.000Z",
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Orders empty state truth", () => {
  it("an empty filter says no orders match that filter, not that there are no orders", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders: Array.from({ length: 10 }, (_, i) => order(i)) }), { status: 200 })));
    render(<OrdersPage />);
    await waitFor(() => expect(screen.getByText("10 of 10")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(screen.queryByText("No pending orders yet.")).toBeNull();
    expect(screen.getByText("No orders match the “Closed” filter.")).toBeTruthy();
    expect(screen.getByText(/10 orders are loaded; choose All to see them\./)).toBeTruthy();
  });

  it("a failed fetch is reported as an error, not as an empty order book", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    render(<OrdersPage />);
    await waitFor(() => expect(screen.getByTestId("orders-load-error").textContent).toMatch(/Orders could not be loaded \(Failed to fetch\)/));
    expect(screen.queryByText("No pending orders yet.")).toBeNull();
    expect(screen.queryByText("0 of 0")).toBeNull();
  });

  it("a failed refresh after a good load says the list is a cached copy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n += 1;
      if (n > 1) return new Response(JSON.stringify({ error: "db down" }), { status: 500 });
      return new Response(JSON.stringify({ orders: [order(1)] }), { status: 200 });
    }));
    render(<OrdersPage />);
    await waitFor(() => expect(screen.getByText("1 of 1")).toBeTruthy());
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await waitFor(() => expect(screen.getByTestId("orders-load-error").textContent)
      .toMatch(/Could not refresh orders \(HTTP 500\)\. Showing the list as last loaded at .*\./));
    expect(screen.getByText("1 of 1")).toBeTruthy();
  });

  it("a genuinely empty book says there are no orders", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders: [] }), { status: 200 })));
    render(<OrdersPage />);
    await waitFor(() => expect(screen.getByText("No orders yet.")).toBeTruthy());
  });
});
