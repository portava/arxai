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

// Task #451 — the canonical balance block slot-summary now carries (the same
// wire shape the SSE stream sends as its `live` sibling). The block's own
// freshness.status is intentionally set to a DIFFERENT value than the poll's
// dataFreshness in these fixtures so the tests prove the hook forces the
// detailed status to the verified poll freshness, not the block's stamp.
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
    live: liveBlock("unavailable"),
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

    // CONTRACT (Task #451): slot-summary now CARRIES the canonical balance block,
    // so a FRESH poll-based heal rebuilds the detailed balance from the poll
    // response and marks its freshness to the verified poll freshness — the
    // detailed status heals all the way to "fresh", NOT the old "unavailable"
    // downgrade. The fixture stamps the carried block "unavailable" to prove the
    // hook forces it to the poll's verdict rather than echoing the block's stamp.
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
