// Task #374 safety regressions — "drawing never auto-executes" + draw lockup.
//
// Two invariants are pinned here:
//
//   1. SAFETY: opening the trade ticket from an AI/Ruby setup-preview
//      ("Use this setup") must NEVER auto-dispatch, even for one-click-armed
//      shared-account users. ChartTradeEntry must pass `suppressAutoConfirm`
//      to the shared ticket whenever the open was initiated by a prefill, and
//      must NOT set it when the user manually clicks Buy/Sell. A drawing is a
//      drawing; only an explicit human Confirm click may dispatch.
//
//   2. LIFECYCLE: useChartSetupPreview must release its in-flight guard even
//      when the chart symbol/timeframe changes mid-request, or every future
//      draw would be silently dead-locked.
//
// The heavy ticket / badge children are stubbed so the prop-wiring proof stays
// hermetic; the real ChartTradeEntry logic runs unmocked.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, renderHook, act } from "@testing-library/react";

// Capture the props the (stubbed) shared ticket is rendered with.
let lastSharedProps: Record<string, unknown> | null = null;
let lastStandardProps: Record<string, unknown> | null = null;

vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["EURUSD", vi.fn()],
  bareSymbol: (s: string) => s,
}));

const mockAccess = { loaded: true, canTrade: true } as Record<string, unknown>;
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({
  useMasterLiveAccess: () => mockAccess,
}));

vi.mock("@/components/charts/ChartFeedConfidence", () => ({
  ChartFeedConfidence: () => null,
}));
vi.mock("@/components/news/EventImpactBadge", () => ({
  EventImpactBadge: () => null,
}));
vi.mock("@/components/news/HighImpactEventBanner", () => ({
  HighImpactEventBanner: () => null,
}));
vi.mock("@/components/live/LiveSharedTradeTicket", () => ({
  LiveSharedTradeTicket: (props: Record<string, unknown>) => {
    lastSharedProps = props;
    return null;
  },
}));
vi.mock("@/components/live/LiveTradeTicket", () => ({
  LiveTradeTicket: (props: Record<string, unknown>) => {
    lastStandardProps = props;
    return null;
  },
}));

// Imported AFTER the mocks (vi.mock is hoisted) so it binds the stubs.
import { ChartTradeEntry } from "./ChartTradeEntry";
import { useChartSetupPreview } from "@/hooks/useChartSetupPreview";

afterEach(() => {
  cleanup();
  lastSharedProps = null;
  lastStandardProps = null;
  mockAccess.canTrade = true;
  mockAccess.loaded = true;
  vi.restoreAllMocks();
});

describe("ChartTradeEntry — a drawing never auto-executes", () => {
  it("suppresses auto-confirm when the shared ticket is opened from a setup prefill", () => {
    render(
      <ChartTradeEntry
        prefill={{ token: 1, side: "BUY", stopLoss: 1.09, takeProfit: 1.12 }}
      />,
    );
    // Approved (canTrade) → shared ticket variant, opened by the prefill effect.
    expect(lastSharedProps).not.toBeNull();
    expect(lastSharedProps!.open).toBe(true);
    expect(lastSharedProps!.suppressAutoConfirm).toBe(true);
    // The SL/TP prefill is still threaded through (a prefill, never an order).
    expect(lastSharedProps!.prefillSltp).toMatchObject({ stopLoss: 1.09, takeProfit: 1.12 });
  });

  it("does NOT suppress auto-confirm for a manual Buy/Sell open (one-click preserved)", () => {
    render(<ChartTradeEntry />);
    // Manual click opens the ticket WITHOUT a prefill.
    fireEvent.click(screen.getByTestId("btn-chart-open-buy"));
    expect(lastSharedProps).not.toBeNull();
    expect(lastSharedProps!.open).toBe(true);
    expect(lastSharedProps!.suppressAutoConfirm).toBe(false);
    expect(lastSharedProps!.prefillSltp).toBeNull();
  });

  it("surfaces the preview source/freshness note for a setup-preview prefill", () => {
    render(
      <ChartTradeEntry
        prefill={{
          token: 1,
          side: "BUY",
          stopLoss: 1.09,
          takeProfit: 1.12,
          sourceNote: "From AI setup preview — Trend pullback, High confidence · Verified live feed",
        }}
      />,
    );
    const note = screen.getByTestId("chart-trade-prefill-source");
    expect(note.textContent).toContain("From AI setup preview");
    expect(note.textContent).toContain("Verified live feed");
    // It must be framed as a review-only prefill, never an executed order.
    expect(note.textContent).toContain("review only");
  });

  it("does NOT show a source note for a manual open (no prefill attribution)", () => {
    render(<ChartTradeEntry />);
    fireEvent.click(screen.getByTestId("btn-chart-open-buy"));
    expect(screen.queryByTestId("chart-trade-prefill-source")).toBeNull();
  });
});

interface Deferred {
  promise: Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  resolve: (v: { setupPreview: unknown }) => void;
}
function deferred(): Deferred {
  let resolve!: Deferred["resolve"];
  const promise = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>(
    (res) => {
      resolve = (body) => res({ ok: true, status: 200, json: async () => body });
    },
  );
  return { promise, resolve };
}

describe("useChartSetupPreview — a mid-request chart switch never deadlocks draws", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("releases the in-flight guard when symbol changes mid-request, so a later draw still fires", async () => {
    const d1 = deferred();
    const d2 = deferred();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ symbol }) => useChartSetupPreview({ symbol, timeframe: "M5", aiUsable: true }),
      { initialProps: { symbol: "EURUSD" } },
    );

    // First draw — request goes in flight.
    act(() => result.current.requestDraw("BUY"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Chart switches symbol while request #1 is still in flight.
    rerender({ symbol: "GBPUSD" });

    // Request #1 now resolves (stale — its state update is discarded, but the
    // in-flight guard MUST be released regardless).
    await act(async () => {
      d1.resolve({ setupPreview: { previewId: "stale" } });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Clear the throttle window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // A fresh draw on the new symbol must fire a second request — proving the
    // guard was released (the pre-fix code would deadlock here at 1 call).
    act(() => result.current.requestDraw("BUY"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
