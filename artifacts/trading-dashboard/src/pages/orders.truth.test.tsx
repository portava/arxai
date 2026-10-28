// Orders page — environment and status labels say what the order is.
//
// Before: environment PAPER rendered as "DEMO" (and the quick-create select
// offered "DEMO" for value PAPER) although DEMO is a distinct MT5 account
// mode; FILLED_SIMULATOR read as a bare "Filled"; PENDING_MT5_CONNECTION —
// a live-tester intent the OMS parks and never sends anywhere — read as
// "Pending"; and the response's dataSource SIMULATOR was dropped. A failed
// read rendered "No pending orders yet."

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const { default: OrdersPage } = await import("./orders");

const base = {
  source: "MANUAL", symbol: "EURUSD", direction: "BUY", orderType: "MARKET", lotSize: 0.01,
  createdAt: new Date().toISOString(),
};
const orders = [
  { ...base, orderId: "ord_aaaa0001", environment: "PAPER", status: "FILLED_SIMULATOR" },
  { ...base, orderId: "ord_bbbb0002", environment: "LIVE_TESTER_INTENT", status: "PENDING_MT5_CONNECTION" },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Orders page — labels", () => {
  it("never relabels PAPER as DEMO and says a parked intent was not sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ orders, dataSource: "SIMULATOR" })));
    render(<OrdersPage />);
    const paper = (await screen.findByText("aaaa0001")).parentElement!;
    expect(within(paper).queryByText("DEMO")).toBeNull();
    expect(within(paper).getByText(/^Paper \(simulator\)$/)).toBeTruthy();
    expect(within(paper).getByText("Filled in simulator")).toBeTruthy();

    const intent = screen.getByText("bbbb0002").parentElement!;
    expect(within(intent).queryByText("Pending")).toBeNull();
    expect(within(intent).getByText(/Not sent — no MT5 bridge/)).toBeTruthy();

    // The create form's PAPER option is not called DEMO either.
    const option = document.querySelector('option[value="PAPER"]')!;
    expect(option.textContent).not.toBe("DEMO");
    expect(screen.getByTestId("orders-data-source").textContent).toMatch(/SIMULATOR/);
  });

  it("a failed read says the list could not be loaded, not 'No pending orders yet.'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "nope" }, 500)));
    render(<OrdersPage />);
    await screen.findByText(/could not load your simulator orders/i);
    expect(screen.queryByText("No pending orders yet.")).toBeNull();
  });
});
