import { describe, expect, it, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ageAccountSnapshot, useAgedAccountSnapshot } from "./useAgedAccountSnapshot";
import type { LiveAccountSnapshot } from "./useLiveAccountSnapshot";

const now = 1_800_000_000_000;
function source(): LiveAccountSnapshot {
  return { userId: "fixture", accountMode: "LIVE_SHARED", source: "mt5", balance: 1000, equity: 1100,
    margin: 0, freeMargin: 1100, marginLevel: null, openPL: 100, openPositionsCount: 0, positions: [],
    lastComputedAtMs: now, freshness: "live", warnings: [], live: {
      source: "live_shared", allocatedBalance: 1000, realizedPnL: 0, floatingPnL: 100, liveEquity: 1100,
      marginUsed: 0, freeMargin: 1100, availableBalance: 1000, openTradeCount: 0,
      freshness: { status: "fresh", lastUpdatedAt: new Date(now).toISOString(), ageMs: 0 },
    } };
}
afterEach(() => vi.useRealTimers());
describe("display evidence aging", () => {
  it.each([[5000,"live"],[5001,"fresh"],[30000,"fresh"],[30001,"delayed"],[120000,"delayed"],[120001,"stale"]] as const)("preserves inclusive server boundary %s", (elapsed, expected) => {
    expect(ageAccountSnapshot(source(), elapsed).snapshot.freshness).toBe(expected);
  });
  it("does not mutate money or the incoming server object", () => {
    const incoming = source(); const before = JSON.stringify(incoming);
    const result = ageAccountSnapshot(incoming, 120001);
    expect(JSON.stringify(incoming)).toBe(before);
    expect(result.snapshot.live?.liveEquity).toBe(1100);
    expect(result.snapshot.live?.availableBalance).toBe(1000);
    expect(result.snapshot.live?.freshness.status).toBe("stale");
    expect(result.nextInMs).toBe(Infinity);
  });
  it.each(["stale", "unavailable"] as const)("never promotes a server %s verdict", status => {
    const incoming = source(); incoming.freshness = status; incoming.live!.freshness.status = status;
    const result = ageAccountSnapshot(incoming, 0);
    expect(result.snapshot.freshness).toBe(status);
    expect(result.snapshot.live?.freshness.status).toBe(status);
  });
  it.each(["invalid", new Date(now + 1000).toISOString()])("holds inconsistent data timestamps %s", stamp => {
    const incoming = source(); incoming.live!.freshness.lastUpdatedAt = stamp;
    expect(ageAccountSnapshot(incoming, 0).snapshot.live?.freshness.status).toBe("unavailable");
  });
  it("uses the older evidence when timestamp and age disagree", () => {
    const incoming = source(); incoming.live!.freshness.lastUpdatedAt = new Date(now - 31000).toISOString();
    expect(ageAccountSnapshot(incoming, 0).snapshot.live?.freshness.status).toBe("stale");
  });
  it("expires old position marks even when account figures were just computed", () => {
    const incoming = source(); incoming.positions = [{ positionId: "p", symbol: "TEST", direction: "buy", volume: 1,
      entryPrice: 10, currentPrice: 11, unrealizedPL: 1, plSource: "broker", plIsEstimate: false,
      lastUpdateAtMs: now - 31000, freshness: "fresh" }];
    const result = ageAccountSnapshot(incoming, 0).snapshot;
    expect(result.positions[0]?.freshness).toBe("delayed");
    expect(result.freshness).toBe("delayed");
    expect(result.live?.freshness.status).toBe("stale");
  });
  it("backward wall-clock changes cannot restore expired funds", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const incoming = source(); const { result } = renderHook(() => useAgedAccountSnapshot(incoming));
    act(() => vi.advanceTimersByTime(30001));
    expect(result.current?.live?.freshness.status).toBe("stale");
    vi.setSystemTime(now - 3600000);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current?.live?.freshness.status).toBe("stale");
  });
  it("accounts for sleep on visibility restoration and cancels timers on unmount", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const incoming = source(); const { result, unmount } = renderHook(() => useAgedAccountSnapshot(incoming));
    expect(vi.getTimerCount()).toBe(1);
    vi.setSystemTime(now + 180000);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current?.freshness).toBe("stale");
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });
});
