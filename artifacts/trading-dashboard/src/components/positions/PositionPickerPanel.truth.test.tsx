import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import React from "react";
import { PositionPickerPanel } from "./PositionPickerPanel";
import type { UnifiedPosition } from "./PositionSideCard";

/**
 * Truth guard for the "My open positions" list and the side card it feeds.
 * The server's per-row freshness verdict must reach every place that shows the
 * row's P/L, and a FRESH verdict must not outlive its 30s window when the
 * poll starts failing.
 */

vi.mock("./PositionMiniChart", () => ({ PositionMiniChart: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: null }) }));

function row(patch: Partial<UnifiedPosition>): UnifiedPosition {
  return {
    scope: "live",
    brokerTicket: "777",
    symbol: "EURUSD",
    side: "BUY",
    lotSize: 0.1,
    entryPrice: 1.1,
    currentPrice: 1.101,
    stopLoss: 1.099,
    takeProfit: 1.103,
    floatingPnl: 12.5,
    openedAt: new Date().toISOString(),
    sourceCommandId: null,
    accountMode: "LIVE",
    source: "MT5_LIVE_BRIDGE",
    ...patch,
  };
}

function body(live: UnifiedPosition[]) {
  return JSON.stringify({ ok: true, live, demo: [], liveCount: live.length, demoCount: 0, notLiveReason: null });
}

/** positions: a queue of responses for /api/me/positions/all ("fail" = network error). */
function stubFetch(positions: Array<string | "fail">) {
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/chart/candles")) {
      return new Response(JSON.stringify({ candles: [], feedStatus: null }), { status: 200 });
    }
    const next = positions[Math.min(i++, positions.length - 1)];
    if (next === "fail") throw new Error("network down");
    return new Response(next, { status: 200 });
  }));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PositionPickerPanel side card after the poll starts failing", () => {
  it("downgrades a cached FRESH row once its report is older than 30s, and the age keeps moving", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    stubFetch([body([row({ observedAt: new Date(Date.now() - 3_000).toISOString(), freshness: "FRESH" })]), "fail"]);
    render(<PositionPickerPanel />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByTestId("btn-select-position-live-777"));
    expect(screen.getByTestId("text-position-status").textContent).toBe("Open — reported by bridge");

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByTestId("text-position-status").textContent).toBe("Unconfirmed — last reported 1m ago");
    expect(screen.getByTestId("text-position-last-reported").textContent).toMatch(/\(1m ago\)$/);
    // The failed refresh is named, and the kept list is labelled as the last successful load.
    expect(screen.getByTestId("positions-load-error").textContent).toMatch(/^Could not refresh positions \(network down\)\. The list below is from the last successful load at /);
  });
});
