// Guard test for the self-healing stale-refetch behavior (Task #440, locked by
// Task #442).
//
// CONTRACT under test (see useLiveAccountSnapshot.ts, the Task #440 effect):
//   - When a snapshot arrives whose freshness flips to `stale` (either the
//     overall snapshot.freshness OR the canonical live.freshness.status), the
//     hook schedules EXACTLY ONE proactive re-fetch after STALE_REFETCH_DEBOUNCE_MS.
//   - It fires ONLY on the transition INTO stale — a burst of repeated stale
//     snapshots must NOT schedule repeated re-fetches (no loop).
//   - Honesty contract: the stale badge is NEVER cleared optimistically; the
//     hook stays stale until genuinely fresh data arrives.
//   - Visible tab self-heals via reload() (SSE reconnect). Hidden tab self-heals
//     via an immediate poll().
//
// READ-ONLY / OFFLINE: EventSource and fetch are mocked, timers are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLiveBridgeRefresh, useLiveBridgeRefreshState } from "./useLiveBridgeRefresh";

import {
  useLiveAccountSnapshot,
  STALE_REFETCH_DEBOUNCE_MS,
  type LiveAccountSnapshot,
} from "./useLiveAccountSnapshot";

// ── Mock EventSource ──────────────────────────────────────────────────────────
// A controllable EventSource so the test can deliver SSE snapshots on demand and
// count how many connections (reconnects) the hook opens.
class MockEventSource {
  static OPEN = 1 as const;
  static CONNECTING = 0 as const;
  static CLOSED = 2 as const;
  static instances: MockEventSource[] = [];

  url: string;
  withCredentials: boolean;
  readyState = MockEventSource.CONNECTING;
  onerror: ((ev: unknown) => void) | null = null;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(url: string, opts?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = opts?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: (ev: unknown) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== cb);
  }
  close() {
    this.readyState = MockEventSource.CLOSED;
  }
  /** Test helper: deliver an SSE `message` payload to this connection. */
  emit(data: unknown) {
    this.readyState = MockEventSource.OPEN;
    const ev = { data: JSON.stringify(data) };
    for (const cb of this.listeners["message"] ?? []) cb(ev);
  }
  static latest(): MockEventSource {
    const es = MockEventSource.instances[MockEventSource.instances.length - 1];
    if (!es) throw new Error("no EventSource opened yet");
    return es;
  }
}

// ── Snapshot factories ────────────────────────────────────────────────────────
function snapshotEvent(opts: {
  snapFreshness: LiveAccountSnapshot["freshness"];
  liveFreshness: "fresh" | "stale" | "unavailable";
}) {
  const snapshot: LiveAccountSnapshot = {
    userId: "u1",
    accountMode: "LIVE_SHARED",
    source: "mt5",
    balance: 1000,
    equity: 990,
    margin: 0,
    freeMargin: 990,
    marginLevel: null,
    openPL: -10,
    openPositionsCount: 0,
    positions: [],
    lastComputedAtMs: Date.now(),
    freshness: opts.snapFreshness,
    warnings: [],
  };
  return {
    type: "account_snapshot",
    snapshot,
    live: {
      source: "live_shared" as const,
      allocatedBalance: 1000,
      realizedPnL: 0,
      floatingPnL: -10,
      liveEquity: 990,
      marginUsed: 0,
      freeMargin: 990,
      availableBalance: 990,
      openTradeCount: 0,
      freshness: {
        status: opts.liveFreshness,
        lastUpdatedAt: null,
        ageMs: opts.liveFreshness === "stale" ? 99_999 : 1_000,
      },
    },
  };
}

// Canonical balance freshness is independent of heartbeat freshness. The
// transport tests deliberately vary these separately to prevent promotion.
function liveBlock(status: "fresh" | "stale" | "unavailable") {
  return {
    source: "live_shared" as const,
    allocatedBalance: 1000,
    realizedPnL: 0,
    floatingPnL: -10,
    liveEquity: 990,
    marginUsed: 0,
    freeMargin: 990,
    availableBalance: 990,
    openTradeCount: 0,
    freshness: {
      status,
      lastUpdatedAt: null,
      ageMs: status === "stale" ? 99_999 : 1_000,
    },
  };
}

// slot-summary poll body that maps to a LIVE_SHARED + stale snapshot.
function stalePollBody() {
  return {
    dataFreshness: "STALE",
    isAllocated: true,
    isLive: true,
    balance: 1000,
    equity: 990,
    margin: 0,
    freeMargin: 990,
    marginLevelPercent: null,
    openPnL: -10,
    openPositionCount: 0,
    positions: [],
    live: liveBlock("stale"),
  };
}

// slot-summary poll body that maps to a LIVE_SHARED + FRESH snapshot — the
// genuinely-healed result the one-shot hidden poll receives. The carried block
// is stamped "unavailable" to prove the hook heals the detailed status up to
// "fresh" from the verified poll freshness (Task #451).
function freshPollBody() {
  return {
    dataFreshness: "FRESH",
    isAllocated: true,
    isLive: true,
    balance: 1000,
    equity: 990,
    margin: 0,
    freeMargin: 990,
    marginLevelPercent: null,
    openPnL: -10,
    openPositionCount: 0,
    positions: [],
    live: liveBlock("fresh"),
  };
}

// ── Document.hidden control ───────────────────────────────────────────────────
// Mirrors POLL_INTERVAL_MS in the hook (not exported); used only to advance the
// fake clock past one poll interval to prove the hidden-tab pause holds.
const POLL_INTERVAL_FLOOR_MS = 5_000;

let hiddenValue = false;
function setHidden(v: boolean) {
  hiddenValue = v;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  MockEventSource.instances = [];
  hiddenValue = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hiddenValue,
  });
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => stalePollBody(),
  }));
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

describe("cockpit refresh controls own the shared transport", () => {
  it("pausing aborts a pending read and visibility changes cannot restart it", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useLiveBridgeRefresh());
    act(() => MockEventSource.latest().emit({ type: "error_safe" }));
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    act(() => result.current.setAutoRefreshEnabled(false));
    expect(signal.aborted).toBe(true);
    expect(result.current.isRefreshing).toBe(false);
    act(() => { setHidden(true); document.dispatchEvent(new Event("visibilitychange")); });
    act(() => { setHidden(false); document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(MockEventSource.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a paused manual read times out without turning automatic updates back on", async () => {
    localStorage.setItem("arx_autoRefresh_enabled", "false");
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useLiveBridgeRefresh());
    act(() => result.current.refreshNow());
    expect(result.current.isRefreshing).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.snapshot).toBeNull();
    expect(result.current.bridgeState).toBe("paused");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a stream carrying heartbeats but no snapshot falls back to a bounded read", async () => {
    const { result } = renderHook(() => useLiveBridgeRefresh());
    act(() => MockEventSource.latest().emit({ type: "heartbeat" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.live?.liveEquity).toBe(990);
    expect(result.current.live?.freshness.status).toBe("stale");
  });

  it("a preference change from another tab pauses the existing stream", () => {
    const { result } = renderHook(() => useLiveBridgeRefresh());
    const stream = MockEventSource.latest();
    act(() => {
      localStorage.setItem("arx_autoRefresh_enabled", "false");
      window.dispatchEvent(new StorageEvent("storage", { key: "arx_autoRefresh_enabled", newValue: "false" }));
    });
    expect(result.current.autoRefreshEnabled).toBe(false);
    expect(stream.readyState).toBe(MockEventSource.CLOSED);
  });

  it("stored OFF opens no stream and starts no automatic requests", async () => {
    localStorage.setItem("arx_autoRefresh_enabled", "false");
    const { result } = renderHook(() => useLiveBridgeRefresh());
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(result.current.autoRefreshEnabled).toBe(false);
    expect(MockEventSource.instances).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.bridgeState).toBe("paused");
  });

  it("OFF closes the stream and cancels stale recovery; ON reconnects once", async () => {
    const { result } = renderHook(() => useLiveBridgeRefresh());
    const stream = MockEventSource.latest();
    act(() => stream.emit(snapshotEvent({ snapFreshness: "stale", liveFreshness: "stale" })));
    act(() => result.current.setAutoRefreshEnabled(false));
    expect(stream.readyState).toBe(MockEventSource.CLOSED);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(MockEventSource.instances).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.live?.freshness.status).toBe("stale");
    act(() => result.current.setAutoRefreshEnabled(true));
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("manual refresh while paused performs one read, then stays paused", async () => {
    localStorage.setItem("arx_autoRefresh_enabled", "false");
    const { result } = renderHook(() => useLiveBridgeRefresh());
    await act(async () => result.current.refreshNow());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.live?.liveEquity).toBe(990);
    expect(result.current.isRefreshing).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances).toHaveLength(0);
    expect(result.current.bridgeState).toBe("paused");
  });

  it("a failed manual read ends the spinner without fabricating a response", async () => {
    localStorage.setItem("arx_autoRefresh_enabled", "false");
    fetchMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useLiveBridgeRefresh());
    await act(async () => result.current.refreshNow());
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.lastRefreshAt).toBeNull();
    expect(result.current.snapshot).toBeNull();
  });

  it("two controls over one provider share the setting without duplicate streams", () => {
    const { result } = renderHook(() => {
      const base = useLiveAccountSnapshot();
      return { first: useLiveBridgeRefreshState(base), second: useLiveBridgeRefreshState(base) };
    });
    expect(MockEventSource.instances).toHaveLength(1);
    act(() => result.current.first.toggleAutoRefresh());
    expect(result.current.second.autoRefreshEnabled).toBe(false);
    expect(MockEventSource.latest().readyState).toBe(MockEventSource.CLOSED);
  });

  it("the cockpit control does not restart a slow fallback at five seconds", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    renderHook(() => useLiveBridgeRefresh());
    act(() => MockEventSource.latest().emit({ type: "error_safe" }));
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(signal.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances).toHaveLength(1);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("confirmed account updates survive transport races", () => {
  it("a stream reconnect does not discard a valid fallback still in flight", async () => {
    let finish!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => MockEventSource.latest().onerror?.({}));
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(MockEventSource.instances).toHaveLength(2);
    expect(signal.aborted).toBe(false);
    await act(async () => { finish({ ok: true, json: async () => freshPollBody() }); });
    expect(result.current.live?.liveEquity).toBe(990);
  });

  it("repeated stream errors do not keep restarting the same fallback request", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    renderHook(() => useLiveAccountSnapshot());
    act(() => MockEventSource.latest().emit({ type: "error_safe" }));
    act(() => MockEventSource.latest().emit({ type: "error_safe" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
  });

  it.each(["stale", "unavailable"] as const)("a fresh heartbeat cannot upgrade a %s canonical balance", async status => {
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ ...freshPollBody(), live: liveBlock(status) }) }));
    const { result } = renderHook(() => useLiveAccountSnapshot());
    await act(async () => MockEventSource.latest().emit({ type: "error_safe" }));
    expect(result.current.live?.freshness.status).toBe(status);
  });

  it("a poll without canonical funds keeps the last figures marked stale", async () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => MockEventSource.latest().emit(snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" })));
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ ...freshPollBody(), live: undefined }) }));
    await act(async () => MockEventSource.latest().emit({ type: "error_safe" }));
    expect(result.current.live?.liveEquity).toBe(990);
    expect(result.current.live?.freshness.status).toBe("stale");
  });

  it("leaving the allocated live mode cannot retain a previous live balance", async () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => MockEventSource.latest().emit(snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" })));
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ ...freshPollBody(), isAllocated: false, live: undefined }) }));
    await act(async () => MockEventSource.latest().emit({ type: "error_safe" }));
    expect(result.current.live).toBeNull();
  });

  it("a slow fallback cannot overwrite a newer streamed balance", async () => {
    let finish!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => MockEventSource.latest().emit({ type: "error_safe" }));
    const confirmed = snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" });
    confirmed.snapshot.equity = 1234;
    confirmed.live.liveEquity = 1234;
    act(() => MockEventSource.latest().emit(confirmed));
    await act(async () => { finish({ ok: true, json: async () => stalePollBody() }); });
    expect(result.current.snapshot?.equity).toBe(1234);
    expect(result.current.live?.liveEquity).toBe(1234);
    expect(result.current.connectionStatus).toBe("live");
  });

  it("a recovered stream stops fallback polling", async () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());
    await act(async () => MockEventSource.latest().emit({ type: "error_safe" }));
    act(() => MockEventSource.latest().emit(snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" })));
    fetchMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.connectionStatus).toBe("live");
  });

  it("late events and errors from a replaced connection cannot change the current stream", () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());
    const retired = MockEventSource.latest();
    act(() => result.current.reload());
    const current = MockEventSource.latest();
    expect(current).not.toBe(retired);
    const confirmed = snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" });
    confirmed.snapshot.equity = 1234;
    act(() => current.emit(confirmed));
    act(() => retired.emit(snapshotEvent({ snapFreshness: "stale", liveFreshness: "stale" })));
    act(() => retired.onerror?.({}));
    expect(result.current.snapshot?.equity).toBe(1234);
    expect(result.current.connectionStatus).toBe("live");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(current.readyState).toBe(MockEventSource.OPEN);
  });

  it("slow polling never stacks requests and is aborted on unmount", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderHook(() => useLiveAccountSnapshot());
    act(() => MockEventSource.latest().emit({ type: "error_safe" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("a hung fallback is bounded and the next poll can recover", async () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => MockEventSource.latest().emit({ type: "error_safe" }));
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(signal.aborted).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(result.current.snapshot?.equity).toBe(990);
  });

  it("two explicit refreshes in the same millisecond are both honored", () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => result.current.reload());
    act(() => result.current.reload());
    expect(MockEventSource.instances).toHaveLength(3);
  });
});

describe("useLiveAccountSnapshot — self-healing stale refetch (Task #440/#442)", () => {
  it("visible tab: a stale snapshot.freshness schedules exactly one SSE reconnect after the debounce", () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());

    // One SSE connection opened on mount.
    expect(MockEventSource.instances.length).toBe(1);

    act(() => {
      MockEventSource.latest().emit(
        snapshotEvent({ snapFreshness: "stale", liveFreshness: "fresh" }),
      );
    });
    expect(result.current.isStale).toBe(true);

    // Before the debounce window elapses: no reconnect yet.
    act(() => {
      vi.advanceTimersByTime(STALE_REFETCH_DEBOUNCE_MS - 1);
    });
    expect(MockEventSource.instances.length).toBe(1);

    // After the debounce: exactly one reconnect (reload → new EventSource).
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(MockEventSource.instances.length).toBe(2);
  });

  it("visible tab: a stale live.freshness.status (canonical block) also triggers the reconnect", () => {
    renderHook(() => useLiveAccountSnapshot());
    expect(MockEventSource.instances.length).toBe(1);

    // Overall snapshot is fresh; only the canonical balance block is stale.
    act(() => {
      MockEventSource.latest().emit(
        snapshotEvent({ snapFreshness: "fresh", liveFreshness: "stale" }),
      );
    });

    act(() => {
      vi.advanceTimersByTime(STALE_REFETCH_DEBOUNCE_MS);
    });
    expect(MockEventSource.instances.length).toBe(2);
  });

  it("fires ONLY on the transition into stale — repeated stale snapshots do not loop", () => {
    renderHook(() => useLiveAccountSnapshot());

    act(() => {
      MockEventSource.latest().emit(
        snapshotEvent({ snapFreshness: "stale", liveFreshness: "stale" }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(STALE_REFETCH_DEBOUNCE_MS);
    });
    // One self-heal reconnect.
    expect(MockEventSource.instances.length).toBe(2);

    // Now flood the (reconnected) stream with more stale snapshots. Because the
    // hook stays stale (no transition), NO further reconnect is scheduled.
    for (let i = 0; i < 5; i++) {
      act(() => {
        MockEventSource.latest().emit(
          snapshotEvent({ snapFreshness: "stale", liveFreshness: "stale" }),
        );
      });
      act(() => {
        vi.advanceTimersByTime(STALE_REFETCH_DEBOUNCE_MS);
      });
    }
    expect(MockEventSource.instances.length).toBe(2);
  });

  it("re-arms after returning to fresh, then going stale again", () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());

    // Stale → self-heal (reconnect #1).
    act(() => {
      MockEventSource.latest().emit(
        snapshotEvent({ snapFreshness: "stale", liveFreshness: "fresh" }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(STALE_REFETCH_DEBOUNCE_MS);
    });
    expect(MockEventSource.instances.length).toBe(2);

    // Genuinely fresh data arrives → stale clears, transition flag resets.
    act(() => {
      MockEventSource.latest().emit(
        snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" }),
      );
    });
    expect(result.current.isStale).toBe(false);

    // Going stale again must re-arm the self-heal (a second debounced reconnect).
    act(() => {
      MockEventSource.latest().emit(
        snapshotEvent({ snapFreshness: "stale", liveFreshness: "fresh" }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(STALE_REFETCH_DEBOUNCE_MS);
    });
    expect(MockEventSource.instances.length).toBe(3);
  });

  it("honesty: the stale badge is never cleared optimistically during/after the refetch", () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());

    act(() => {
      MockEventSource.latest().emit(
        snapshotEvent({ snapFreshness: "stale", liveFreshness: "stale" }),
      );
    });
    expect(result.current.isStale).toBe(true);
    expect(result.current.freshness).toBe("stale");

    // The refetch fires (reconnect) but does NOT clear staleness — only real
    // fresh data may. While the reconnect is in flight, the hook stays stale.
    act(() => {
      vi.advanceTimersByTime(STALE_REFETCH_DEBOUNCE_MS);
    });
    expect(result.current.isStale).toBe(true);
    expect(result.current.freshness).toBe("stale");

    // Genuinely fresh data finally arrives → only now does the badge clear.
    act(() => {
      MockEventSource.latest().emit(
        snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" }),
      );
    });
    expect(result.current.isStale).toBe(false);
    expect(result.current.freshness).toBe("fresh");
  });

  it("hidden tab: the self-heal issues EXACTLY ONE proactive poll (no SSE reconnect, no recurring loop) — Task #445", async () => {
    // Mount visible so SSE delivers a stale snapshot (the only way a snapshot can
    // arrive — a hidden tab never opens SSE), then hide the tab before the
    // debounce fires so the self-heal evaluates the `document.hidden` branch.
    const { result } = renderHook(() => useLiveAccountSnapshot());
    expect(MockEventSource.instances.length).toBe(1);

    act(() => {
      MockEventSource.latest().emit(
        snapshotEvent({ snapFreshness: "stale", liveFreshness: "stale" }),
      );
    });
    expect(result.current.isStale).toBe(true);

    // Tab goes to the background BEFORE the debounce window elapses. Going hidden
    // starts the recurring poll interval, but its mount poll + 5s ticks honor the
    // hidden-tab perf guard → no fetch. Clear the counter so we isolate the
    // self-heal's single one-shot poll below.
    act(() => {
      setHidden(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    fetchMock.mockClear();

    // After the debounce: the self-heal takes the hidden branch — a SINGLE
    // proactive poll via doPoll({ allowWhileHidden: true }) that bypasses the
    // hidden-tab pause for this one heal only. It must NOT open a new EventSource
    // (reopening SSE on a backgrounded tab would defeat the hidden-tab pause).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALE_REFETCH_DEBOUNCE_MS);
    });
    expect(MockEventSource.instances.length).toBe(1); // no SSE reconnect
    expect(fetchMock).toHaveBeenCalledTimes(1); // exactly one proactive poll
    expect(result.current.isStale).toBe(true); // honesty: never optimistically cleared

    // The recurring 5s interval stays paused while hidden: advancing several
    // poll intervals triggers NO further fetches — the one-shot heal did not turn
    // into a loop and the perf guard on the interval is intact.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FLOOR_MS * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Returning to the foreground reconnects SSE (normal resume), proving the
    // hidden branch above genuinely suppressed the reconnect rather than the hook
    // being dead.
    act(() => {
      setHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(MockEventSource.instances.length).toBe(2);
  });

  it("hidden tab: when the one-shot poll returns FRESH data, the stale badge actually heals while still hidden (no SSE reconnect) — Task #449", async () => {
    // Mount visible so SSE can deliver a stale snapshot (a hidden tab never opens
    // SSE), then hide the tab before the debounce fires so the self-heal takes the
    // `document.hidden` → doPoll({ allowWhileHidden: true }) branch.
    const { result } = renderHook(() => useLiveAccountSnapshot());
    expect(MockEventSource.instances.length).toBe(1);

    act(() => {
      MockEventSource.latest().emit(
        snapshotEvent({ snapFreshness: "stale", liveFreshness: "stale" }),
      );
    });
    expect(result.current.isStale).toBe(true);
    expect(result.current.freshness).toBe("stale");

    // Background the tab and arm the one-shot poll to return GENUINELY FRESH data
    // (dataFreshness: "FRESH"), unlike the prior test where it stayed stale.
    act(() => {
      setHidden(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => freshPollBody(),
    }));

    // After the debounce: the hidden branch issues exactly one proactive poll. Its
    // FRESH result must be applied — the heal really heals, it doesn't just fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALE_REFETCH_DEBOUNCE_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // exactly one proactive poll
    expect(MockEventSource.instances.length).toBe(1); // SSE stays closed while hidden
    expect(result.current.isStale).toBe(false); // badge genuinely cleared
    expect(result.current.freshness).toBe("fresh");
  });

  it("hidden tab FRESH heal: the detailed balance status heals to FRESH now that slot-summary carries the canonical block (Task #451)", async () => {
    // Mount visible so SSE can deliver a snapshot whose canonical balance block
    // (live.freshness.status) is stale, then hide the tab before the debounce so
    // the self-heal takes the doPoll({ allowWhileHidden: true }) branch.
    const { result } = renderHook(() => useLiveAccountSnapshot());
    expect(MockEventSource.instances.length).toBe(1);

    act(() => {
      MockEventSource.latest().emit(
        snapshotEvent({ snapFreshness: "stale", liveFreshness: "stale" }),
      );
    });
    // Both signals start stale and AGREE.
    expect(result.current.freshness).toBe("stale");
    expect(result.current.live?.freshness.status).toBe("stale");

    // Background the tab; arm the one-shot poll to return GENUINELY FRESH data.
    act(() => {
      setHidden(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => freshPollBody(),
    }));

    // After the debounce: exactly one proactive poll, no SSE reconnect.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALE_REFETCH_DEBOUNCE_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances.length).toBe(1);

    // Both the heartbeat and the returned canonical balance are fresh.
    // A separate regression above proves one cannot upgrade the other.
    expect(result.current.freshness).toBe("fresh");
    expect(result.current.live?.freshness.status).toBe("fresh");

    // The headline and the detailed status now agree (both fresh) — and the
    // detailed figures came from the same re-verified poll, never fabricated.
    expect(result.current.live?.floatingPnL).toBe(-10);
    expect(result.current.live?.availableBalance).toBe(990);
  });

  it("hidden tab STALE poll: the detailed balance status is marked stale (never falsely fresh) — Task #451", async () => {
    // Drive a stale → self-heal poll where the poll itself comes back STALE. The
    // detailed block must be marked stale to match the verified poll freshness —
    // a stale poll can never produce a falsely-fresh detailed balance.
    const { result } = renderHook(() => useLiveAccountSnapshot());
    expect(MockEventSource.instances.length).toBe(1);

    act(() => {
      MockEventSource.latest().emit(
        snapshotEvent({ snapFreshness: "stale", liveFreshness: "stale" }),
      );
    });
    expect(result.current.isStale).toBe(true);

    act(() => {
      setHidden(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => stalePollBody(),
    }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALE_REFETCH_DEBOUNCE_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.freshness).toBe("stale");
    expect(result.current.live?.freshness.status).toBe("stale");
  });

  it("hidden tab at mount: polling is paused (no fetch) until the tab is visible", async () => {
    setHidden(true);
    renderHook(() => useLiveAccountSnapshot());

    // Hidden tab never opens an SSE connection.
    expect(MockEventSource.instances.length).toBe(0);

    // The mount poll + 5s interval both honor the hidden-tab guard: no fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_FLOOR_MS);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Becoming visible switches to SSE.
    act(() => {
      setHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(MockEventSource.instances.length).toBe(1);
  });
});


describe("account evidence expires without another network message", () => {
  it("ages canonical funds while paused without issuing a request", async () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => MockEventSource.latest().emit(snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" })));
    act(() => result.current.setAutoRefreshEnabled(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(29_001); });
    expect(result.current.live?.freshness.status).toBe("stale");
    expect(result.current.live?.liveEquity).toBe(990);
    expect(result.current.connectionStatus).toBe("paused");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("heartbeat-only traffic cannot renew a Live snapshot", async () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => MockEventSource.latest().emit(snapshotEvent({ snapFreshness: "live", liveFreshness: "fresh" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
    act(() => MockEventSource.latest().emit({ type: "heartbeat" }));
    expect(result.current.freshness).toBe("fresh");
    await act(async () => { await vi.advanceTimersByTimeAsync(25_001); });
    expect(result.current.live?.freshness.status).toBe("stale");
    expect(result.current.freshness).toBe("delayed");
  });

  it("a newly delivered old snapshot is already expired", () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());
    const event = snapshotEvent({ snapFreshness: "live", liveFreshness: "fresh" });
    event.snapshot.lastComputedAtMs -= 130_000;
    act(() => MockEventSource.latest().emit(event));
    expect(result.current.freshness).toBe("stale");
    expect(result.current.live?.freshness.status).toBe("stale");
  });

  it("fresh funds without either an age or a data time are unavailable", () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());
    const event = snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" });
    event.live.freshness.ageMs = null as unknown as number;
    act(() => MockEventSource.latest().emit(event));
    expect(result.current.live?.freshness.status).toBe("unavailable");
    expect(result.current.live?.liveEquity).toBe(990);
  });

  it("only replacement account evidence restores freshness", async () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => MockEventSource.latest().emit(snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(29_001); });
    expect(result.current.live?.freshness.status).toBe("stale");
    act(() => MockEventSource.latest().emit(snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" })));
    expect(result.current.live?.freshness.status).toBe("fresh");
  });
});

describe('funds-only polls do not certify position completeness',()=>{
  it('first funds poll without a count has unknown count and incomplete positions',async()=>{
    const body={...freshPollBody()} as Record<string,unknown>;delete body.openPositionCount;
    fetchMock.mockResolvedValue({ok:true,json:async()=>body});
    const {result}=renderHook(()=>useLiveAccountSnapshot());
    await act(async()=>{MockEventSource.latest().emit({type:"error_safe"});await Promise.resolve();await Promise.resolve();});
    expect(result.current.snapshot?.positionsComplete).toBe(false);
    expect(result.current.snapshot?.positionCountKnown).toBe(false);
  });
  it('a reported count does not make an absent position list complete; SSE restores it',async()=>{
    fetchMock.mockResolvedValue({ok:true,json:async()=>({...freshPollBody(),openPositionCount:2})});
    const {result}=renderHook(()=>useLiveAccountSnapshot());
    await act(async()=>{MockEventSource.latest().emit({type:"error_safe"});await Promise.resolve();await Promise.resolve();});
    expect(result.current.snapshot?.openPositionsCount).toBe(2);
    expect(result.current.snapshot?.positionCountKnown).toBe(true);
    expect(result.current.snapshot?.positionsComplete).toBe(false);
    act(()=>MockEventSource.latest().emit(snapshotEvent({snapFreshness:'fresh',liveFreshness:'fresh'})));
    expect(result.current.snapshot?.positionsComplete).not.toBe(false);
    expect(result.current.snapshot?.openPositionsCount).toBe(0);
  });
  it('malformed counts cannot be displayed as known',async()=>{
    fetchMock.mockResolvedValue({ok:true,json:async()=>({...freshPollBody(),openPositionCount:'0'})});
    const {result}=renderHook(()=>useLiveAccountSnapshot());
    await act(async()=>{MockEventSource.latest().emit({type:"error_safe"});await Promise.resolve();await Promise.resolve();});
    expect(result.current.snapshot?.positionCountKnown).toBe(false);
  });
});


describe("successful partial funds responses cannot refresh old amounts", () => {
  const fields = [
    ["balance", "balance"], ["equity", "equity"], ["margin", "margin"],
    ["freeMargin", "freeMargin"], ["marginLevelPercent", "marginLevel"], ["openPnL", "openPL"],
  ] as const;
  it.each([null, undefined, "12", Number.NaN, Number.POSITIVE_INFINITY])("clears unknown or malformed funds (%s) instead of reusing old numbers", async (value) => {
    const body = freshPollBody() as Record<string, unknown>;
    for (const [wire] of fields) {
      if (value === undefined) delete body[wire]; else body[wire] = value;
    }
    fetchMock.mockResolvedValue({ ok: true, json: async () => body });
    const { result } = renderHook(() => useLiveAccountSnapshot());
    const prior = snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" });
    for (const [, field] of fields) prior.snapshot[field] = 123;
    act(() => MockEventSource.latest().emit(prior));
    await act(async () => { MockEventSource.latest().emit({ type: "error_safe" }); });
    for (const [, field] of fields) expect(result.current.snapshot?.[field]).toBeNull();
  });
  it("keeps newly reported zeroes and a negative open loss", async () => {
    const body = freshPollBody() as Record<string, unknown>;
    for (const [wire] of fields) body[wire] = 0;
    body.openPnL = -7;
    fetchMock.mockResolvedValue({ ok: true, json: async () => body });
    const { result } = renderHook(() => useLiveAccountSnapshot());
    await act(async () => { MockEventSource.latest().emit({ type: "error_safe" }); });
    for (const [, field] of fields) expect(result.current.snapshot?.[field]).toBe(field === "openPL" ? -7 : 0);
  });
  it.each([null, undefined])("does not revive a previously known position count when the response count is %s", async (value) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...freshPollBody(), openPositionCount: value }) });
    const { result } = renderHook(() => useLiveAccountSnapshot());
    const prior = snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" });
    prior.snapshot.openPositionsCount = 3;
    act(() => MockEventSource.latest().emit(prior));
    await act(async () => { MockEventSource.latest().emit({ type: "error_safe" }); });
    expect(result.current.snapshot?.positionCountKnown).toBe(false);
  });
  it("explicitly unavailable canonical funds clear the previous canonical block", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...freshPollBody(), live: null }) });
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => MockEventSource.latest().emit(snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" })));
    await act(async () => { MockEventSource.latest().emit({ type: "error_safe" }); });
    expect(result.current.live).toBeNull();
  });
  it.each([false, "false", 1])("requires boolean live allocation signals (%s)", async (flag) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...freshPollBody(), isAllocated: flag }) });
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => MockEventSource.latest().emit(snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" })));
    await act(async () => { MockEventSource.latest().emit({ type: "error_safe" }); });
    expect(result.current.snapshot?.accountMode).toBe("UNKNOWN");
    expect(result.current.live).toBeNull();
    for (const [, field] of fields) expect(result.current.snapshot?.[field]).toBeNull();
  });
  it("does not carry paper account canonical values into a live fallback", async () => {
    const body = freshPollBody() as Record<string, unknown>; delete body.live;
    fetchMock.mockResolvedValue({ ok: true, json: async () => body });
    const { result } = renderHook(() => useLiveAccountSnapshot());
    const prior = snapshotEvent({ snapFreshness: "fresh", liveFreshness: "fresh" });
    prior.snapshot.accountMode = "PAPER";
    act(() => MockEventSource.latest().emit(prior));
    await act(async () => { MockEventSource.latest().emit({ type: "error_safe" }); });
    expect(result.current.live).toBeNull();
  });
});
