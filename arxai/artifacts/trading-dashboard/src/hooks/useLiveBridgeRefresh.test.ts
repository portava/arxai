// Presentation-only checks. Real transport, persistence and shared-provider
// controls are exercised in useLiveAccountSnapshot.test.ts without mocking the hook.
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLiveBridgeRefreshState, type BridgeState } from "./useLiveBridgeRefresh";
import type { UseLiveAccountSnapshotResult, ConnectionStatus, Freshness } from "./useLiveAccountSnapshot";

function makeBase(overrides: Partial<UseLiveAccountSnapshotResult> = {}): UseLiveAccountSnapshotResult {
  return {
    snapshot: null, live: null, connectionStatus: "live", freshness: "live",
    lastUpdatedMs: null, reload: vi.fn(), autoRefreshEnabled: true,
    setAutoRefreshEnabled: vi.fn(), isRefreshing: false, notLiveReason: null,
    isEstimate: false, isStale: false, isUnavailable: false, warnings: [], ...overrides,
  };
}

describe("shared account controls — presentation and evidence", () => {
  const cases: Array<[ConnectionStatus, Freshness, BridgeState]> = [
    ["live", "live", "live"], ["polling", "live", "live"],
    ["live", "fresh", "delayed"], ["live", "delayed", "delayed"],
    ["polling", "fresh", "delayed"], ["polling", "delayed", "delayed"],
    ["polling", "stale", "stale"], ["polling", "unavailable", "stale"],
    ["disconnected", "live", "offline"], ["unavailable", "fresh", "offline"],
    ["paused", "live", "paused"], ["paused", "stale", "paused"],
  ];
  it.each(cases)("%s transport with %s data displays %s", (connectionStatus, freshness, expected) => {
    const { result } = renderHook(() => useLiveBridgeRefreshState(makeBase({ connectionStatus, freshness })));
    expect(result.current.bridgeState).toBe(expected);
  });

  it("delegates the toggle to the shared setting; no independent checkbox state", () => {
    const base = makeBase();
    const { result, rerender } = renderHook(useLiveBridgeRefreshState, { initialProps: base });
    act(() => result.current.toggleAutoRefresh());
    expect(base.setAutoRefreshEnabled).toHaveBeenCalledExactlyOnceWith(false);
    rerender({ ...base, autoRefreshEnabled: false });
    expect(result.current.autoRefreshEnabled).toBe(false);
    act(() => result.current.toggleAutoRefresh());
    expect(base.setAutoRefreshEnabled).toHaveBeenLastCalledWith(true);
  });

  it("refresh delegates once, and only actual transport state drives its spinner", () => {
    const base = makeBase({ lastUpdatedMs: 1000 });
    const { result, rerender } = renderHook(useLiveBridgeRefreshState, { initialProps: base });
    act(() => result.current.refreshNow());
    expect(base.reload).toHaveBeenCalledTimes(1);
    expect(result.current.isRefreshing).toBe(false);
    rerender({ ...base, isRefreshing: true });
    expect(result.current.isRefreshing).toBe(true);
    // Failure can finish without a new data timestamp; no endless spinner.
    rerender({ ...base, isRefreshing: false, connectionStatus: "disconnected" });
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.lastRefreshAt).toBe(1000);
    expect(result.current.bridgeState).toBe("offline");
  });

  it("does not invent a next-poll deadline from a data timestamp", () => {
    const { result } = renderHook(() => useLiveBridgeRefreshState(makeBase({ connectionStatus: "polling", lastUpdatedMs: 1 })));
    expect(result.current.nextRefreshInMs).toBeNull();
    expect(result.current.lastRefreshAt).toBe(1);
  });
});
