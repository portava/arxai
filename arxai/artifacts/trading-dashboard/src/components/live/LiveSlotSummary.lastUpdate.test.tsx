// Live slot summary — "Last update" is the broker's last report, not the time
// the page fetched. The server's lastUpdated is that data time (null when the
// broker never reported); the card and the Open Trades panel must render it as
// a broker time and say "none received" when it is null.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveSlotSummaryCard } from "./LiveSlotSummaryCard";
import { LiveOpenTradesPanel } from "./LiveOpenTradesPanel";

function summary(over: Record<string, unknown>) {
  return {
    accountCurrency: "USD", balance: 1000, equity: 1005, margin: 10, freeMargin: 995, marginLevelPercent: 10050,
    openPnL: 5, positions: [], isLive: false, isStale: true, isAllocated: true, allocationNote: null,
    ...over,
  };
}

function stub(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })));
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("slot summary last update", () => {
  it("card and panel show the broker's last report time, marked stale", async () => {
    const then = new Date(Date.now() - 40 * 60_000);
    stub(summary({ lastUpdated: then.toISOString(), servedAt: new Date().toISOString() }));
    wrap(<><LiveSlotSummaryCard /><LiveOpenTradesPanel /></>);
    await waitFor(() => expect(screen.getByTestId("slot-last-update")).toBeTruthy());
    const expected = then.toLocaleTimeString();
    expect(screen.getByTestId("slot-last-update").textContent).toBe(`Last broker update: ${expected} (stale)`);
    await waitFor(() => expect(screen.getByTestId("open-trades-last-update")).toBeTruthy());
    expect(screen.getByTestId("open-trades-last-update").textContent).toBe(`Last broker update: ${expected} (stale)`);
  });

  it("no broker report: says none received instead of a time", async () => {
    stub(summary({ lastUpdated: null, isStale: false }));
    wrap(<><LiveSlotSummaryCard /><LiveOpenTradesPanel /></>);
    await waitFor(() => expect(screen.getByTestId("slot-last-update")).toBeTruthy());
    expect(screen.getByTestId("slot-last-update").textContent).toBe("Last broker update: none received");
    await waitFor(() => expect(screen.getByTestId("open-trades-last-update")).toBeTruthy());
    expect(screen.getByTestId("open-trades-last-update").textContent).toBe("Last broker update: none received");
  });
});
