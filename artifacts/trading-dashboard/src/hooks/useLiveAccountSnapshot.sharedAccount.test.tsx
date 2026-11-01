import React, { type ReactNode } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryObserver, useQuery } from "@tanstack/react-query";
import { getGetMeSharedAccountSummaryQueryKey } from "@workspace/api-client-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveAccountSnapshot } from "./useLiveAccountSnapshot";
import { LiveAccountSnapshotProvider, useLiveAccountSnapshotCtx } from "./useLiveAccountSnapshotContext";
import { NativeAccountReport } from "../components/sharedAccount/NativeAccountReport";
import { createSharedAccountChangeStream } from "../../../api-server/src/lib/live/sharedAccountChangeStream";

class Stream {
  static OPEN = 1;
  static instances: Stream[] = [];
  readyState = 0;
  onerror: (() => void) | null = null;
  listeners: ((event: { data: string }) => void)[] = [];
  constructor() { Stream.instances.push(this); }
  addEventListener(_type: string, listener: (event: { data: string }) => void) { this.listeners.push(listener); }
  close() { this.readyState = 2; }
  emit(data: unknown) { this.readyState = 1; this.listeners.forEach(listener => listener({ data: JSON.stringify(data) })); }
}
const key = getGetMeSharedAccountSummaryQueryKey();
const hint = { type: "shared_account_changed" };
const oldSummary = { masterMt5: { balance: 100, updatedAt: "2026-01-01T00:00:00Z" } };
let hidden = false;
let clients: QueryClient[];
let unsubscribers: (() => void)[];
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  hidden = false;
  clients = [];
  unsubscribers = [];
  Stream.instances = [];
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.stubGlobal("EventSource", Stream);
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});
afterEach(() => {
  cleanup();
  unsubscribers.forEach(unsubscribe => unsubscribe());
  clients.forEach(client => client.clear());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  clients.push(client);
  client.setQueryData(key, oldSummary);
  const requests: { resolve: (value: typeof oldSummary) => void; reject: (error: Error) => void; signal: AbortSignal }[] = [];
  const queryFn = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<typeof oldSummary>((resolve, reject) => requests.push({ resolve, reject, signal })));
  const observer = new QueryObserver(client, { queryKey: key, queryFn });
  unsubscribers.push(observer.subscribe(() => {}));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useLiveAccountSnapshot(), { wrapper });
  return { client, requests, queryFn, hook, observer, stream: Stream.instances[0]! };
}
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(30); }); }

describe("shared-account advisory hints on the existing account stream", () => {
  it("recovers a missed account event in both rendered monetary views using the same canonical report", async () => {
    const now = Date.now();
    const original = {
      status: "reported" as const, currentVerified: false as const,
      observedAt: new Date(now - 2000).toISOString(), receivedAt: new Date(now - 1000).toISOString(),
      currency: "KWD", currencyDigits: 3,
      amounts: { balance: "1000.123", equity: "1001.234", profit: "1.111", credit: "0.000", margin: "20.000", freeMargin: "981.234" },
    };
    let persisted = original;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    clients.push(client);
    client.setQueryData(key, original);
    const read = vi.fn(async () => persisted);
    function MoneyView() {
      const result = useQuery({ queryKey: key, queryFn: read });
      return <NativeAccountReport report={result.data ?? null} failed={result.isError} />;
    }
    render(<QueryClientProvider client={client}><LiveAccountSnapshotProvider><MoneyView /><MoneyView /></LiveAccountSnapshotProvider></QueryClientProvider>);
    const server = createSharedAccountChangeStream({
      // No local notifications: simulate a committed report on another process.
      bus: { onConnection() {}, offConnection() {} }, readScope: async () => 81,
      sendHint: () => Stream.instances[0]!.emit(hint), schedulerOptions: { minGapMs: 0 },
    });
    try {
      await act(async () => { server.request(); await vi.advanceTimersByTimeAsync(30); });
      expect(read).toHaveBeenCalledTimes(1);
      persisted = { ...original, amounts: { balance: "1100.123", equity: "1090.234", profit: "-9.889", credit: "2.000", margin: "30.000", freeMargin: "1060.234" } };
      // A connection or heartbeat alone is not money evidence.
      act(() => Stream.instances[0]!.emit({ type: "heartbeat" }));
      expect(screen.getAllByTestId("native-money-balance").map(node => node.textContent)).toEqual(["KWD 1,000.123", "KWD 1,000.123"]);
      await act(async () => { server.request(); await vi.advanceTimersByTimeAsync(30); });
      expect(read).toHaveBeenCalledTimes(2);
      for (const [field, expected] of Object.entries({ balance: "1,100.123", equity: "1,090.234", profit: "-9.889", credit: "2.000", margin: "30.000", freeMargin: "1,060.234" })) {
        expect(screen.getAllByTestId(`native-money-${field}`).map(node => node.textContent)).toEqual([`KWD ${expected}`, `KWD ${expected}`]);
      }
      expect(screen.getAllByText(/current state unverified/)).toHaveLength(2);
      expect(screen.getAllByText(`Terminal-reported observation: ${original.observedAt}. Received by ARX: ${original.receivedAt}.`)).toHaveLength(2);
      expect(Stream.instances).toHaveLength(1);
    } finally { server.stop(); }
  });

  it("refreshes the canonical summary immediately without promoting stream or money freshness", async () => {
    const { client, requests, queryFn, hook, stream } = setup();
    const before = client.getQueryState(key)!;
    act(() => stream.emit(hint));
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(key)).toEqual(oldSummary);
    expect(client.getQueryState(key)!.dataUpdatedAt).toBe(before.dataUpdatedAt);
    expect(hook.result.current.snapshot).toBeNull();
    expect(hook.result.current.connectionStatus).toBe("connecting");
    await act(async () => requests[0]!.resolve({ masterMt5: { balance: 101, updatedAt: "2026-01-01T00:00:00Z" } }));
    expect(client.getQueryData(key)).toEqual({ masterMt5: { balance: 101, updatedAt: "2026-01-01T00:00:00Z" } });
    expect(Stream.instances).toHaveLength(1);
  });

  it("coalesces a burst into one leading and one trailing read without cancelling either", async () => {
    const { requests, queryFn, stream } = setup();
    act(() => { for (let i = 0; i < 50; i++) stream.emit(hint); });
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(requests[0]!.signal.aborted).toBe(false);
    await act(async () => requests[0]!.resolve(oldSummary));
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(2);
    await act(async () => requests[1]!.resolve(oldSummary));
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("waits for a pre-hint request, then refetches so its older response cannot consume the change", async () => {
    const { client, requests, queryFn, stream } = setup();
    void client.refetchQueries({ queryKey: key, exact: true });
    act(() => stream.emit(hint));
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(requests[0]!.signal.aborted).toBe(false);
    await act(async () => requests[0]!.resolve(oldSummary));
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("retains the pending change if another reader cancels the pre-hint request", async () => {
    const { client, queryFn, stream } = setup();
    void client.refetchQueries({ queryKey: key, exact: true });
    act(() => stream.emit(hint));
    await act(async () => client.cancelQueries({ queryKey: key, exact: true }));
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it.each(["hidden", "paused", "disconnected", "unmounted"] as const)("drops queued trailing work when %s", async (reason) => {
    const { requests, queryFn, hook, stream } = setup();
    act(() => { stream.emit(hint); stream.emit(hint); });
    expect(queryFn).toHaveBeenCalledTimes(1);
    act(() => {
      if (reason === "hidden") { hidden = true; document.dispatchEvent(new Event("visibilitychange")); }
      if (reason === "paused") hook.result.current.setAutoRefreshEnabled(false);
      if (reason === "disconnected") stream.onerror?.();
      if (reason === "unmounted") hook.unmount();
    });
    await act(async () => requests[0]!.resolve(oldSummary));
    act(() => stream.emit(hint)); // Even a queued message from the closed stream is ignored.
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("drops an idle waiter if the authenticated query cache is cleared", async () => {
    const { client, queryFn, stream } = setup();
    void client.refetchQueries({ queryKey: key, exact: true });
    act(() => stream.emit(hint));
    act(() => client.clear());
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(key)).toBeUndefined();
  });

  it("does not rewrite cached evidence on query failure and a later hint can recover", async () => {
    const { client, requests, queryFn, stream } = setup();
    act(() => stream.emit(hint));
    expect(queryFn).toHaveBeenCalledTimes(1);
    await act(async () => requests[0]!.reject(new Error("offline")));
    await settle();
    expect(client.getQueryData(key)).toEqual(oldSummary);
    act(() => stream.emit(hint));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("only invalidates the exact active summary, not nearby keys or unrelated account reads", () => {
    const { client, queryFn, stream } = setup();
    const sibling = [...key, "other-user"];
    client.setQueryData(sibling, 42);
    act(() => stream.emit(hint));
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(sibling)?.isInvalidated).toBe(false);
  });

  it("marks an inactive summary stale without starting an unobserved request", async () => {
    const { client, queryFn, stream } = setup();
    unsubscribers.forEach(unsubscribe => unsubscribe());
    act(() => stream.emit(hint));
    await settle();
    expect(queryFn).not.toHaveBeenCalled();
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryData(key)).toEqual(oldSummary);
  });

  it("cancels the already-scheduled trailing timer when hidden, then accepts new hints on resume", async () => {
    const { requests, queryFn, stream } = setup();
    act(() => { stream.emit(hint); stream.emit(hint); });
    await act(async () => requests[0]!.resolve(oldSummary));
    // The first request settled, but its coalesced trailing timer has not fired.
    act(() => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(1);
    act(() => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
    act(() => Stream.instances[1]!.emit(hint));
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(Stream.instances).toHaveLength(2); // Reconnection, not a parallel stream.
    expect(stream.readyState).toBe(2);
  });

  it("preserves a delayed snapshot and its observation times while rereading the summary", () => {
    const { hook, stream, queryFn } = setup();
    act(() => stream.emit({ type: "account_snapshot", snapshot: {
      userId: "u1", accountMode: "LIVE_SHARED", source: "mt5", balance: 100,
      equity: 99, margin: 0, freeMargin: 99, marginLevel: null, openPL: -1,
      openPositionsCount: 0, positions: [], lastComputedAtMs: Date.now() - 10000,
      accountSyncedAtMs: Date.now() - 10000, freshness: "delayed", warnings: [],
    } }));
    const before = hook.result.current.snapshot;
    expect(before).not.toBeNull();
    act(() => stream.emit(hint));
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(hook.result.current.snapshot).toEqual(before);
  });

  it("drops a waiter for a pre-existing read on unmount without aborting that other reader", async () => {
    const { client, requests, queryFn, hook, stream } = setup();
    void client.refetchQueries({ queryKey: key, exact: true });
    act(() => stream.emit(hint));
    hook.unmount();
    expect(requests[0]!.signal.aborted).toBe(false);
    await act(async () => requests[0]!.resolve(oldSummary));
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("uses one provider stream to refresh the shared query observed by multiple surfaces", async () => {
    const { client, hook, requests, queryFn } = setup();
    hook.unmount();
    Stream.instances = [];
    const second = new QueryObserver(client, { queryKey: key, queryFn });
    unsubscribers.push(second.subscribe(() => {}));
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><LiveAccountSnapshotProvider>{children}</LiveAccountSnapshotProvider></QueryClientProvider>;
    renderHook(() => [useLiveAccountSnapshotCtx(), useLiveAccountSnapshotCtx()], { wrapper });
    act(() => Stream.instances[0]!.emit(hint));
    expect(Stream.instances).toHaveLength(1);
    expect(queryFn).toHaveBeenCalledTimes(1);
    const updated = { masterMt5: { balance: 102, updatedAt: "2026-01-01T00:00:00Z" } };
    await act(async () => requests[0]!.resolve(updated));
    expect(second.getCurrentResult().data).toEqual(updated);
  });
});
