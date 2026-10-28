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
