// Live Intent Queue: an admin-only scoped payload is not an empty queue, and
// a failed read is not "Total 0". The Convert button never promises that
// connecting the bridge will enable it (it is disabled unconditionally).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const { default: LiveIntentQueuePage } = await import("./live-intent-queue");

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Live Intent Queue truth labels", () => {
  it("a non-admin scoped payload shows the scope note, not 'Submit one…' and 'Total 0'", async () => {
    stubFetch(200, {
      intents: [],
      counts: { total: 0, pendingMt5: 0, ready: 0, rejected: 0, executedLater: 0 },
      modeScopeApplied: true,
      scopeNote: "Live Intent Queue is admin-only operator data.",
    });
    render(<LiveIntentQueuePage />);
    await waitFor(() => expect(screen.getByTestId("intent-queue-scope-note")).toBeTruthy());
    expect(screen.getByTestId("intent-queue-scope-note").textContent).toContain("admin-only operator data");
    expect(screen.queryByText(/No intents match filters/)).toBeNull();
    expect(screen.queryByText(/Submit one from Live Manual/)).toBeNull();
    // Count tiles must not present withheld data as a measured 0.
    for (const tile of screen.getAllByTestId("intent-count-value")) {
      expect(tile.textContent).toBe("—");
    }
  });

  it("a 500 shows an error state, not an empty queue", async () => {
    stubFetch(500, { error: "list intents failed" });
    render(<LiveIntentQueuePage />);
    await waitFor(() => expect(screen.getByTestId("intent-queue-error")).toBeTruthy());
    expect(screen.getByTestId("intent-queue-error").textContent).toMatch(/could not load/i);
    expect(screen.queryByText(/No intents match filters/)).toBeNull();
    for (const tile of screen.getAllByTestId("intent-count-value")) {
      expect(tile.textContent).toBe("—");
    }
  });

  it("the always-disabled Convert button does not promise bridge-dependent enablement", async () => {
    stubFetch(200, {
      intents: [{
        id: 1, intentId: "i-1", source: "MANUAL", symbol: "EURUSD", direction: "BUY",
        lotSize: 0.01, stopLoss: null, takeProfit: null, status: "PENDING_MT5_CONNECTION",
        rejectionReason: null, confidenceScore: null, riskScore: null,
        mt5ConnectedAtSubmit: false, brokerExecuted: false,
        createdAt: "2026-10-28T10:00:00.000Z", auditEventId: null,
      }],
      counts: { total: 1, pendingMt5: 1, ready: 0, rejected: 0, executedLater: 0 },
    });
    render(<LiveIntentQueuePage />);
    const btn = await screen.findByRole("button", { name: /Convert to Broker Order/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute("title") ?? "").not.toMatch(/Connect MT5 bridge to enable/i);
    expect(screen.queryByText(/No intents match filters/)).toBeNull();
    const tiles = screen.getAllByTestId("intent-count-value").map((t) => t.textContent);
    expect(tiles[0]).toBe("1");
  });
});

// GET /live-intent/queue counts only the newest `limit` intents (default 100).
describe("Live Intent Queue count window", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: i, intentId: `i-${i}`, source: "MANUAL", symbol: "EURUSD", direction: "BUY",
    lotSize: 0.01, stopLoss: 1.05, takeProfit: null, status: i % 2 ? "REJECTED_BY_RISK" : "PENDING_MT5_CONNECTION",
    rejectionReason: null, confidenceScore: null, riskScore: null,
    mt5ConnectedAtSubmit: false, brokerExecuted: false,
    createdAt: "2026-10-28T10:00:00.000Z", auditEventId: null,
  }));

  it("a capped window is labelled 'latest 100', not shown as the queue total", async () => {
    stubFetch(200, {
      intents: rows(100),
      counts: { total: 100, pendingMt5: 50, ready: 0, rejected: 50, executedLater: 0 },
      limit: 100, hasMore: true, modeScopeApplied: true, adminScope: true,
    });
    render(<LiveIntentQueuePage />);
    await waitFor(() => expect(screen.getByTestId("intent-count-scope")).toBeTruthy());
    expect(screen.getByText("Total (latest 100)")).toBeTruthy();
    expect(screen.queryByText("Total")).toBeNull();
    expect(screen.getByTestId("intent-count-scope").textContent).toMatch(/newest 100 intents only\. Older intents exist/);
  });

  it("an older server that does not report the window still discloses the 100 cap", async () => {
    stubFetch(200, {
      intents: rows(100),
      counts: { total: 100, pendingMt5: 50, ready: 0, rejected: 50, executedLater: 0 },
      modeScopeApplied: true, adminScope: true,
    });
    render(<LiveIntentQueuePage />);
    await waitFor(() => expect(screen.getByTestId("intent-count-scope")).toBeTruthy());
    expect(screen.getByText("Total (latest 100)")).toBeTruthy();
    expect(screen.getByTestId("intent-count-scope").textContent).toMatch(/at most 100/);
  });

  it("a window that holds the whole queue is a plain total", async () => {
    stubFetch(200, {
      intents: rows(3),
      counts: { total: 3, pendingMt5: 2, ready: 0, rejected: 1, executedLater: 0 },
      limit: 100, hasMore: false, modeScopeApplied: true, adminScope: true,
    });
    render(<LiveIntentQueuePage />);
    await waitFor(() => expect(screen.getByTestId("intent-count-scope")).toBeTruthy());
    expect(screen.getByText("Total")).toBeTruthy();
    expect(screen.getByTestId("intent-count-scope").textContent).toBe("Counts cover all 3 intents in the queue.");
  });
});
