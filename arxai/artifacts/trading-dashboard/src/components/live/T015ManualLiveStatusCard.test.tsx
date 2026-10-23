import {
  describe, it, expect, beforeEach, afterEach, vi,
} from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { T015ManualLiveStatusCard } from "./T015ManualLiveStatusCard";

/**
 * Regression guard for the /admin/live-shared route crash ("This page hit a
 * snag").
 *
 * The card is the only surface on that route that historically read nested
 * fields off the t015-status payload without per-field guards
 * (`data.allocation.availableAllocationUsd.toFixed(2)`,
 * `data.phase.note`, `data?.readiness.decision`). When the allocation balance
 * source returns a null figure — or the payload omits a nested object — those
 * unguarded reads throw during render and take the whole route down into
 * RouteErrorBoundary.
 *
 * These tests feed deliberately-degraded (but truthy, ok:true) payloads and
 * assert the card renders a calm fallback instead of throwing.
 */

function mockFetchOnce(payload: unknown, status = 200) {
  const f = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", f);
  return f;
}

const FULL = {
  ok: true,
  phase: { tag: "T015", label: "L", active: true, perTradeLimit: null, note: "phase note here" },
  readiness: { decision: "PASS", primaryReason: null, blockReasons: [], bridgeKind: "shared", previewStopLoss: 1.05 },
  allocation: {
    assignedAllocationUsd: 7,
    reservedRiskUsd: 0,
    availableAllocationUsd: 7,
    bridgeAvailability: "AVAILABLE",
    bridgeMessage: "ok",
  },
  manualLiveTradeCount: 0,
  t014History: { note: "history note", cycles: [] },
};

describe("T015ManualLiveStatusCard render robustness", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("renders a complete payload without crashing", async () => {
    mockFetchOnce(FULL);
    render(<T015ManualLiveStatusCard />);
    await waitFor(() => expect(screen.getByTestId("t015-allocation")).toBeTruthy());
    expect(screen.getByTestId("t015-allocation").textContent).toContain("$7.00");
  });

  it("does not crash when allocation balances are null", async () => {
    mockFetchOnce({
      ...FULL,
      allocation: {
        ...FULL.allocation,
        assignedAllocationUsd: null,
        availableAllocationUsd: null,
      },
    });
    render(<T015ManualLiveStatusCard />);
    await waitFor(() => expect(screen.getByTestId("card-t015-status")).toBeTruthy());
    expect(screen.getByTestId("t015-allocation")).toBeTruthy();
  });

  it("does not crash when nested objects are missing", async () => {
    mockFetchOnce({ ok: true, manualLiveTradeCount: 2 });
    render(<T015ManualLiveStatusCard />);
    await waitFor(() => expect(screen.getByTestId("card-t015-status")).toBeTruthy());
  });

  it("does not crash on malformed cycle-history rows", async () => {
    mockFetchOnce({
      ...FULL,
      t014History: { note: "n", cycles: [null, undefined, "x", { status: "COMPLETED" }] },
    });
    render(<T015ManualLiveStatusCard />);
    await waitFor(() => expect(screen.getByTestId("card-t015-status")).toBeTruthy());
  });
});
