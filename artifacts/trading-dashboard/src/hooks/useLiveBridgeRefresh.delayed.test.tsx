// Truth regression: the bridge badge may only pulse "Live" for a snapshot the
// server itself calls live or fresh. A "delayed" snapshot (30 s – 2 min old)
// is delayed even while the SSE stream is connected. The "Checked … ago"
// label must keep ageing on screen even when nothing else re-renders
// (auto-refresh off).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { useLiveBridgeRefreshState } from "./useLiveBridgeRefresh";
import type { UseLiveAccountSnapshotResult } from "./useLiveAccountSnapshot";
import { LiveBridgeAutoRefreshControl } from "@/components/live/LiveBridgeAutoRefreshControl";

function base(over: Partial<UseLiveAccountSnapshotResult>): UseLiveAccountSnapshotResult {
  return {
    snapshot: null,
    live: null,
    connectionStatus: "live",
    freshness: "live",
    lastUpdatedMs: null,
    error: null,
    reload: vi.fn(),
    ...over,
  } as UseLiveAccountSnapshotResult;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("bridge badge truth", () => {
  it("a delayed snapshot on a connected stream is Delayed, not Live", () => {
    const { result } = renderHook(() =>
      useLiveBridgeRefreshState(base({ connectionStatus: "live", freshness: "delayed" })),
    );
    expect(result.current.bridgeState).toBe("delayed");
  });

  it("a stale snapshot on a connected stream is still Stale", () => {
    const { result } = renderHook(() =>
      useLiveBridgeRefreshState(base({ connectionStatus: "live", freshness: "stale" })),
    );
    expect(result.current.bridgeState).toBe("stale");
  });
});

// Codex line: the label is an absolute "Checked at <time>" (it cannot go
// stale as a relative "just now" can), so the test checks it names the real
// check time and never claims "just now" 70 s later. (Truth kept a relative
// "Checked Ns ago" label alive with a 1 s clock tick.)
describe("Checked … label", () => {
  it("names the real check time and never freezes on 'just now' with auto-refresh off", () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-28T12:00:00Z");
    vi.setSystemTime(now);
    render(
      <LiveBridgeAutoRefreshControl
        autoRefreshEnabled={false}
        toggleAutoRefresh={() => undefined}
        refreshNow={() => undefined}
        isRefreshing={false}
        lastRefreshAt={now - 1_000}
        nextRefreshInMs={null}
        bridgeState="delayed"
      />,
    );
    const checkedAt = `Checked at ${new Date(now - 1_000).toLocaleTimeString()}`;
    expect(screen.getByText(checkedAt)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(70_000); });
    expect(screen.queryByText(/just now/)).toBeNull();
    expect(screen.getByText(checkedAt)).toBeTruthy();
  });
});
