// The paper open-positions panel collapsed a failed or pending read (and a
// missing account) into "Open demo positions (0) / No open demo positions",
// and a refused Close did nothing visible. Each state now says what it is.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperOpenPositionsPanel } from "./PaperOpenPositionsPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(accountId: number | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PaperOpenPositionsPanel accountId={accountId} /></QueryClientProvider>);
}

describe("PaperOpenPositionsPanel states", () => {
  it("a failed read is not shown as zero open positions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Failed to load orders" }), { status: 500 })));
    mount(1);
    await waitFor(() => expect(screen.getByTestId("paper-open-state").textContent).toMatch(/Couldn't load/));
    expect(screen.getByTestId("paper-open-heading").textContent).not.toContain("(0)");
    expect(document.body.textContent).not.toContain("No open demo positions.");
  });

  it("no account selected is not shown as zero open positions", () => {
    vi.stubGlobal("fetch", vi.fn());
    mount(null);
    expect(screen.getByTestId("paper-open-state").textContent).toMatch(/No demo account selected/);
    expect(screen.getByTestId("paper-open-heading").textContent).not.toContain("(0)");
  });

  it("a successful empty read says none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders: [] }), { status: 200 })));
    mount(1);
    await waitFor(() => expect(screen.getByTestId("paper-open-state").textContent).toBe("No open demo positions."));
    expect(screen.getByTestId("paper-open-heading").textContent).toContain("(0)");
  });

  it("a refused close shows the server's reason", async () => {
    const order = { id: 5, symbol: "EURUSD", direction: "BUY", lotSize: 1, entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.09, status: "OPEN", profitLoss: 0, openedAt: "2026-10-28T00:00:00Z" };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => init?.method === "POST"
      ? new Response(JSON.stringify({ error: "No current real quote for EURUSD" }), { status: 503 })
      : new Response(JSON.stringify({ orders: [order] }), { status: 200 })));
    mount(1);
    fireEvent.click(await screen.findByText("Close"));
    await waitFor(() => expect(screen.getByTestId("paper-close-error").textContent).toContain("No current real quote for EURUSD"));
  });
});
