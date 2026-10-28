// Truth: a draft's stored pendingStatus is the bridge answer from when it was
// saved or last submitted. The panel must not show it as the bridge's state
// now without a time, must show the server's current answer when it has one,
// and its footer must not say the bridge cannot take pending orders when the
// draft's own status says the EA reports support. A failed list is "could not
// be loaded", not "No pending-order drafts".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PendingOrdersPanel } from "./PendingOrdersPanel";

function renderWith(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PendingOrdersPanel /></QueryClientProvider>);
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 9, orderType: "BUY_LIMIT", symbol: "EURUSD", side: "BUY", lotSize: 0.01, entryPrice: 1.1,
  stopTriggerPrice: null, stopLimitPrice: null, stopLoss: 1.09, takeProfit: 1.13, expiration: null,
  pendingStatus: "BRIDGE_DISCONNECTED", status: "awaiting_confirmation", reason: null,
  createdAt: "2026-10-28T09:00:00.000Z", ...over,
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("PendingOrdersPanel", () => {
  it("saved while disconnected, EA back: the badge is the answer now, with its time; the old one is labelled as recorded", async () => {
    renderWith(200, {
      ok: true, bridgeCheckedAt: "2026-10-28T11:40:00.000Z", bridgeCheckError: null,
      drafts: [row({
        currentPendingStatus: "READ_ONLY",
        currentPendingReason: "Your connected EA (EA v1.50) reports pending-order support, but ARX is paper-only: its pending-order path is read-only and does not deliver pending orders to the broker.",
      })],
    });
    const item = await screen.findByTestId("pending-order-9");
    expect(screen.getByTestId("pending-order-status-9").textContent).toBe("READ_ONLY");
    expect(item.textContent).toMatch(/Bridge checked 2026-10-28 11:40 UTC/);
    expect(item.textContent).toMatch(/Recorded when saved or last submitted: BRIDGE_DISCONNECTED/);
    expect(item.textContent).toMatch(/saved 2026-10-28 09:00 UTC/);
    expect(item.textContent).toContain("reports pending-order support");
  });

  it("without a current answer, the stored status is labelled as recorded, with its date", async () => {
    renderWith(200, {
      ok: true, bridgeCheckedAt: null,
      bridgeCheckError: "Your MT5 bridge status could not be read, so what a submit would answer now is not shown.",
      drafts: [row({ currentPendingStatus: null, currentPendingReason: null })],
    });
    const item = await screen.findByTestId("pending-order-9");
    expect(item.textContent).toMatch(/Recorded when saved or last submitted/);
    expect(item.textContent).toMatch(/saved 2026-10-28 09:00 UTC/);
    expect(screen.getByTestId("pending-orders-panel").textContent).toMatch(/could not be read/);
  });

  it("footer does not contradict a draft whose EA reports pending-order support", async () => {
    renderWith(200, {
      ok: true, bridgeCheckedAt: "2026-10-28T11:40:00.000Z", bridgeCheckError: null,
      drafts: [row({ pendingStatus: "BLOCKED_BY_PAPER_LOCK", currentPendingStatus: "READ_ONLY", currentPendingReason: "Your connected EA reports pending-order support, but ARX is paper-only." })],
    });
    await screen.findByTestId("pending-order-9");
    const footer = screen.getByTestId("pending-orders-footer").textContent ?? "";
    expect(footer).not.toMatch(/bridge does not yet accept pending orders/i);
    expect(footer).not.toMatch(/until the bridge is upgraded/i);
    expect(footer).toMatch(/never sent/i);
  });

  it("a failed list says it could not be loaded, not that there are no drafts", async () => {
    renderWith(500, { ok: false, error: "drafts_list_failed" });
    await waitFor(() => expect(screen.getByTestId("pending-orders-load-error").textContent).toMatch(/could not be loaded/));
    expect(screen.queryByText(/No pending-order drafts/)).toBeNull();
  });
});
