// Reconciliation marker across the SSE → poll fallback. The stream snapshot
// carries `reconciliation` (summed position P/L vs equity − balance). When the
// stream drops, the hook rebuilt the snapshot from /api/me/live/slot-summary
// and silently DROPPED the marker — so a P/L the stream had flagged "under
// verification" re-appeared as normal live profit, and an unchecked poll total
// read as reconciled. The poll-built snapshot now carries an explicit marker.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLiveAccountSnapshot, pollReconciliationMarker, type LiveAccountSnapshot } from "./useLiveAccountSnapshot";

class MockEventSource {
  static OPEN = 1 as const; static CONNECTING = 0 as const; static CLOSED = 2 as const;
  static instances: MockEventSource[] = [];
  readyState = 0;
  onerror: ((ev: unknown) => void) | null = null;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  constructor(public url: string) { MockEventSource.instances.push(this); }
  addEventListener(t: string, cb: (ev: unknown) => void) { (this.listeners[t] ??= []).push(cb); }
  removeEventListener() {}
  close() { this.readyState = 2; }
  emit(data: unknown) { this.readyState = 1; for (const cb of this.listeners["message"] ?? []) cb({ data: JSON.stringify(data) }); }
  fail() { this.onerror?.({}); }
}

const FLAGGED = {
  snapshotSummedPL: -10, equityMinusBalancePL: -42, discrepancy: 32, exceedsThreshold: true,
  excludedCount: 0, brokerAbsentExcludedCount: 0, stalePLCount: 0,
};

function streamSnapshot(reconciliation: LiveAccountSnapshot["reconciliation"]) {
  const snapshot: LiveAccountSnapshot = {
    userId: "u1", accountMode: "LIVE_SHARED", source: "mt5", balance: 1000, equity: 958, margin: 0,
    freeMargin: 958, marginLevel: null, openPL: -10, openPositionsCount: 1, positions: [],
    lastComputedAtMs: Date.now(), freshness: "fresh", warnings: [], reconciliation,
  };
  return { type: "account_snapshot", snapshot };
}

beforeEach(() => {
  MockEventSource.instances = [];
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ dataFreshness: "FRESH", isAllocated: true, isLive: true, balance: 1000, equity: 990, openPnL: -10, openPositionCount: 1, positions: [] }),
  })));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("useLiveAccountSnapshot reconciliation marker on the poll fallback", () => {
  it("a discrepancy flagged by the stream is not cleared when the stream drops", async () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => { MockEventSource.instances[0]!.emit(streamSnapshot(FLAGGED)); });
    expect(result.current.snapshot?.reconciliation?.exceedsThreshold).toBe(true);
    await act(async () => { MockEventSource.instances[0]!.fail(); await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(result.current.connectionStatus).toBe("polling"));
    expect(result.current.snapshot?.reconciliation?.exceedsThreshold).toBe(true);
    expect(result.current.snapshot?.reconciliation?.discrepancy).toBe(32);
  });

  it("a poll-built snapshot is never marked reconciled", async () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => { MockEventSource.instances[0]!.emit(streamSnapshot({ ...FLAGGED, exceedsThreshold: false, discrepancy: 0 })); });
    await act(async () => { MockEventSource.instances[0]!.fail(); await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(result.current.connectionStatus).toBe("polling"));
    const rec = result.current.snapshot?.reconciliation;
    expect(rec).toBeDefined();
    expect(rec?.unverified).toBe(true);
    expect(rec?.exceedsThreshold).toBe(true);
    expect(rec?.equityMinusBalancePL).toBeNull();
  });

  it("the marker helper keeps a flagged marker and flags an unchecked one", () => {
    expect(pollReconciliationMarker(FLAGGED, -5)).toEqual(FLAGGED);
    expect(pollReconciliationMarker(null, -5)).toMatchObject({ snapshotSummedPL: -5, exceedsThreshold: true, unverified: true });
  });
});

describe("useLiveAccountSnapshot carried position rows on the poll fallback", () => {
  it("rows frozen from the last stream snapshot lose their live label", async () => {
    const { result } = renderHook(() => useLiveAccountSnapshot());
    const ev = streamSnapshot(FLAGGED);
    ev.snapshot.positions = [{
      positionId: "p1", symbol: "EURUSD", direction: "buy", volume: 0.1, entryPrice: 1.08, currentPrice: 1.081,
      unrealizedPL: 10, plSource: "broker", plIsEstimate: false, lastUpdateAtMs: Date.now(), freshness: "live",
    }];
    act(() => { MockEventSource.instances[0]!.emit(ev); });
    expect(result.current.snapshot?.positions[0]?.freshness).toBe("live");
    await act(async () => { MockEventSource.instances[0]!.fail(); await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(result.current.connectionStatus).toBe("polling"));
    expect(result.current.snapshot?.positions[0]?.freshness).toBe("stale");
  });
});

// slot-summary reports openPnL / equity / freeMargin as an explicit null while
// any open position is unpriced. The poll fallback used `?? prev`, so the
// server's deliberate "unknown" was replaced by the last stream figure and
// stamped fresh. Only an ABSENT key may fall back to the carried value.
describe("useLiveAccountSnapshot withheld figures on the poll fallback", () => {
  it("an explicit null from slot-summary stays null; it is never replaced by the last stream value", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        dataFreshness: "FRESH", isAllocated: true, isLive: true, balance: 1000,
        openPnL: null, equity: null, freeMargin: null, marginLevelPercent: null,
        openPnLIncomplete: true, unpricedPositionCount: 1, openPositionCount: 1, positions: [],
      }),
    })));
    const { result } = renderHook(() => useLiveAccountSnapshot());
    const ev = streamSnapshot(FLAGGED);
    ev.snapshot.openPL = 12.5; ev.snapshot.equity = 1000; ev.snapshot.freeMargin = 950; ev.snapshot.marginLevel = 400;
    act(() => { MockEventSource.instances[0]!.emit(ev); });
    expect(result.current.snapshot?.openPL).toBe(12.5);
    await act(async () => { MockEventSource.instances[0]!.fail(); await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(result.current.connectionStatus).toBe("polling"));
    expect(result.current.snapshot?.openPL).toBeNull();
    expect(result.current.snapshot?.equity).toBeNull();
    expect(result.current.snapshot?.freeMargin).toBeNull();
    expect(result.current.snapshot?.marginLevel).toBeNull();
    expect(result.current.snapshot?.balance).toBe(1000);
  });

  it("a key slot-summary does not send at all still falls back to the carried value", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ dataFreshness: "FRESH", isAllocated: true, isLive: true, openPnL: -3, openPositionCount: 1, positions: [] }),
    })));
    const { result } = renderHook(() => useLiveAccountSnapshot());
    act(() => { MockEventSource.instances[0]!.emit(streamSnapshot(FLAGGED)); });
    await act(async () => { MockEventSource.instances[0]!.fail(); await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(result.current.connectionStatus).toBe("polling"));
    expect(result.current.snapshot?.openPL).toBe(-3);
    expect(result.current.snapshot?.balance).toBe(1000);
    expect(result.current.snapshot?.equity).toBe(958);
  });
});
