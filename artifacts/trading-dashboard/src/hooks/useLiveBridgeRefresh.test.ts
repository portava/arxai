// Deterministic guard test for useLiveBridgeRefreshState (Task #673).
//
// CONTRACT under test (see useLiveBridgeRefresh.ts):
//   - It is a PURE layering over an already-obtained snapshot base result; it
//     opens NO transport of its own (the standalone useLiveBridgeRefresh()
//     composes it with useLiveAccountSnapshot()).
//   - autoRefreshEnabled is localStorage-persisted and defaults to ON.
//   - refreshNow() sets isRefreshing=true and calls base.reload() exactly once;
//     isRefreshing clears only when a genuinely newer snapshot arrives
//     (base.lastUpdatedMs changes), never optimistically.
//   - bridgeState classifies (live/delayed/stale/offline) from the underlying
//     connection status + freshness and NEVER relabels a stale/offline bridge
//     as live (honesty rule).
//   - nextRefreshInMs is null while the SSE connection is live (the stream
//     already pushes sub-second updates).
//
// READ-ONLY / OFFLINE: no network, no EventSource. The base result is a plain
// synthetic object so the layering logic is exercised in isolation.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import {
  useLiveBridgeRefreshState,
  type BridgeState,
} from "./useLiveBridgeRefresh";
import type {
  UseLiveAccountSnapshotResult,
  ConnectionStatus,
  Freshness,
} from "./useLiveAccountSnapshot";

const LS_KEY = "arx_autoRefresh_enabled";

// Build a synthetic base snapshot result. reload is a spy so we can assert the
// layering hook never fabricates a transport call.
function makeBase(
  overrides: Partial<UseLiveAccountSnapshotResult> = {},
): UseLiveAccountSnapshotResult {
  return {
    snapshot: null,
    live: null,
    connectionStatus: "live",
    freshness: "live",
    lastUpdatedMs: null,
    error: null,
    reload: vi.fn(),
    ...overrides,
  } as UseLiveAccountSnapshotResult;
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
});

describe("useLiveBridgeRefreshState — bridge-state honesty", () => {
  // [connectionStatus, freshness] => expected bridgeState
  const cases: Array<[ConnectionStatus, Freshness, BridgeState]> = [
    ["live", "live", "live"],
    ["polling", "live", "live"],
    ["live", "fresh", "live"], // live connection + fresh => still live
    ["polling", "fresh", "delayed"],
    ["polling", "delayed", "delayed"], // not stale/unavailable => delayed bucket
    ["polling", "stale", "stale"],
    ["polling", "unavailable", "stale"],
    ["disconnected", "live", "offline"], // connection trumps a stale "live" label
    ["unavailable", "fresh", "offline"],
  ];

  for (const [connectionStatus, freshness, expected] of cases) {
    it(`classifies (${connectionStatus}, ${freshness}) => ${expected}`, () => {
      const { result } = renderHook(() =>
        useLiveBridgeRefreshState(makeBase({ connectionStatus, freshness })),
      );
      expect(result.current.bridgeState).toBe(expected);
    });
  }

  it("never relabels a disconnected/unavailable bridge as live", () => {
    for (const status of ["disconnected", "unavailable"] as ConnectionStatus[]) {
      const { result } = renderHook(() =>
        // even with a (stale) freshness="live" payload, an offline transport wins
        useLiveBridgeRefreshState(makeBase({ connectionStatus: status, freshness: "live" })),
      );
      expect(result.current.bridgeState).toBe("offline");
      expect(result.current.bridgeState).not.toBe("live");
    }
  });
});

describe("useLiveBridgeRefreshState — auto-refresh toggle persistence", () => {
  it("defaults to ON when nothing is stored", () => {
    const { result } = renderHook(() => useLiveBridgeRefreshState(makeBase()));
    expect(result.current.autoRefreshEnabled).toBe(true);
  });

  it("reads a stored 'false' as OFF", () => {
    localStorage.setItem(LS_KEY, "false");
    const { result } = renderHook(() => useLiveBridgeRefreshState(makeBase()));
    expect(result.current.autoRefreshEnabled).toBe(false);
  });

  it("toggle persists the new value to localStorage", () => {
    const { result } = renderHook(() => useLiveBridgeRefreshState(makeBase()));
    expect(result.current.autoRefreshEnabled).toBe(true);

    act(() => result.current.toggleAutoRefresh());
    expect(result.current.autoRefreshEnabled).toBe(false);
    expect(localStorage.getItem(LS_KEY)).toBe("false");

    act(() => result.current.toggleAutoRefresh());
    expect(result.current.autoRefreshEnabled).toBe(true);
    expect(localStorage.getItem(LS_KEY)).toBe("true");
  });
});

describe("useLiveBridgeRefreshState — refreshNow + isRefreshing honesty", () => {
  it("refreshNow sets isRefreshing and calls base.reload exactly once", () => {
    const base = makeBase({ connectionStatus: "polling", freshness: "fresh" });
    const { result } = renderHook(() => useLiveBridgeRefreshState(base));

    expect(result.current.isRefreshing).toBe(false);
    act(() => result.current.refreshNow());

    expect(result.current.isRefreshing).toBe(true);
    expect(base.reload).toHaveBeenCalledTimes(1);
  });

  it("isRefreshing clears only when a genuinely newer snapshot arrives", () => {
    let base = makeBase({ connectionStatus: "polling", freshness: "fresh", lastUpdatedMs: 1000 });
    const { result, rerender } = renderHook(
      (b: UseLiveAccountSnapshotResult) => useLiveBridgeRefreshState(b),
      { initialProps: base },
    );

    act(() => result.current.refreshNow());
    expect(result.current.isRefreshing).toBe(true);

    // Same lastUpdatedMs => still refreshing (no optimistic clear).
    base = makeBase({ connectionStatus: "polling", freshness: "fresh", lastUpdatedMs: 1000, reload: base.reload });
    rerender(base);
    expect(result.current.isRefreshing).toBe(true);

    // A newer snapshot => clears.
    base = makeBase({ connectionStatus: "polling", freshness: "fresh", lastUpdatedMs: 2000, reload: base.reload });
    rerender(base);
    expect(result.current.isRefreshing).toBe(false);
  });

  it("tracks lastRefreshAt from the base lastUpdatedMs", () => {
    let base = makeBase({ lastUpdatedMs: null });
    const { result, rerender } = renderHook(
      (b: UseLiveAccountSnapshotResult) => useLiveBridgeRefreshState(b),
      { initialProps: base },
    );
    expect(result.current.lastRefreshAt).toBeNull();

    base = makeBase({ lastUpdatedMs: 4242 });
    rerender(base);
    expect(result.current.lastRefreshAt).toBe(4242);
  });
});

describe("useLiveBridgeRefreshState — countdown gating", () => {
  it("nextRefreshInMs is null while the SSE connection is live", () => {
    const { result } = renderHook(() =>
      useLiveBridgeRefreshState(makeBase({ connectionStatus: "live", freshness: "live", lastUpdatedMs: Date.now() })),
    );
    expect(result.current.nextRefreshInMs).toBeNull();
  });

  it("nextRefreshInMs is null when auto-refresh is disabled", () => {
    localStorage.setItem(LS_KEY, "false");
    const { result } = renderHook(() =>
      useLiveBridgeRefreshState(makeBase({ connectionStatus: "polling", freshness: "fresh", lastUpdatedMs: Date.now() })),
    );
    expect(result.current.nextRefreshInMs).toBeNull();
  });
});
