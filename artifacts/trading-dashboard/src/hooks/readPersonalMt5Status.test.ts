import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { getGetMt5StatusQueryKey } from "@workspace/api-client-react";
import { readPersonalMt5Status, mt5StatusReadOptions, ACCOUNT_SUMMARY_READ_TIMEOUT_MS } from "./readSharedAccountSummary";
import { createPersonalAccountChangeRefresh } from "./sharedAccountChangeRefresh";

const key = getGetMt5StatusQueryKey();
const report = (balance: string) => ({ connected: true, nativeAccountReport: {
  status: "reported", currentVerified: false, currency: "KWD", currencyDigits: 3,
  observedAt: "2026-11-01T12:00:00.000Z", receivedAt: "2026-11-01T12:00:00.100Z",
  amounts: { balance, equity: "0.000", profit: "-9.123", credit: "1.000", margin: "0.000", freeMargin: "0.000" },
} });
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each([
  ["headers", "pre-hint"], ["body", "pre-hint"],
  ["headers", "hint-started"], ["body", "hint-started"],
])("retires a stalled %s %s read and preserves the last report, then consumes a waiting hint", async (stage, origin) => {
  let resolveOld!: (value: any) => void;
  const stalled = new Promise<any>(resolve => { resolveOld = resolve; });
  const fetcher = vi.fn().mockImplementationOnce(() => stage === "headers" ? stalled : Promise.resolve({
    ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }),
    text: () => stalled,
  })).mockResolvedValue(response(report("1100.456")));
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(key, report("1000.123"));
  const observer = new QueryObserver(client, { queryKey: key, ...mt5StatusReadOptions });
  const unsubscribe = observer.subscribe(() => {});
  const refresh = createPersonalAccountChangeRefresh(client);
  try {
    if (origin === "pre-hint") void client.refetchQueries({ queryKey: key, exact: true });
    else refresh.notify();
    refresh.notify();
    await vi.advanceTimersByTimeAsync(ACCOUNT_SUMMARY_READ_TIMEOUT_MS - 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(key)).toEqual(report("1000.123"));
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getQueryState(key)?.fetchStatus).toBe("idle");
    expect(client.getQueryState(key)?.status).toBe("error");
    expect(client.getQueryData(key)).toEqual(report("1000.123"));
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(25);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(key)).toEqual(report("1100.456"));
    resolveOld(stage === "headers" ? response(report("900.000")) : JSON.stringify(report("900.000")));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getQueryData(key)).toEqual(report("1100.456"));
    expect(fetcher.mock.calls.every(([, options]) => options.method === "GET" && options.cache === "no-store")).toBe(true);
  } finally { refresh.dispose(); unsubscribe(); client.clear(); }
});

it("passes one exact report through without rounding, substituting profit or turning zero equity into balance", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response(report("12345678901234567890.123"))));
  const value = await readPersonalMt5Status({ signal: new AbortController().signal });
  expect(value).toEqual(report("12345678901234567890.123"));
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start a request for a cancelled observer", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController(); controller.abort();
  await expect(readPersonalMt5Status({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("cancellation rejects even an abort-ignoring transport and removes its deadline", async () => {
  const fetcher = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  const result = readPersonalMt5Status({ signal: controller.signal }).catch(error => error);
  controller.abort();
  expect(await result).toMatchObject({ name: "AbortError" });
  expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([null, new Error("offline")])("rejects the original failure and clears its deadline (%s)", async failure => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
  const outcome = await readPersonalMt5Status({ signal: new AbortController().signal }).then(
    value => ({ ok: true, value }), error => ({ ok: false, error }),
  );
  expect(outcome).toEqual({ ok: false, error: failure });
  expect(vi.getTimerCount()).toBe(0);
});


it.each(["headers", "body"])("rejects overdue %s completion before a delayed timeout callback can run", async stage => {
  let clock=100, resolveOld!: (value:any)=>void;
  const monotonic=vi.spyOn(performance,"now").mockImplementation(()=>clock);
  const pending=new Promise<any>(resolve=>{resolveOld=resolve;});
  const fetcher=vi.fn().mockImplementationOnce(()=>stage==="headers"?pending:Promise.resolve({
    ok:true,status:200,headers:new Headers({"content-type":"application/json"}),text:()=>pending,
  })).mockResolvedValue(response(report("1200.000")));
  vi.stubGlobal("fetch",fetcher);
  try {
    const result=readPersonalMt5Status({signal:new AbortController().signal}).then(value=>({ok:true,value}),error=>({ok:false,error}));
    // The transport continuation can be queued before a busy event loop runs
    // its overdue timeout task. Advance only the monotonic clock, not timers.
    await Promise.resolve();clock+=ACCOUNT_SUMMARY_READ_TIMEOUT_MS;
    resolveOld(stage==="headers"?response(report("900.000")):JSON.stringify(report("900.000")));
    const settled=await result;
    expect(settled.ok).toBe(false);expect("error" in settled && settled.error).toEqual(new Error("Account update timed out. Waiting for a new report."));
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
    // A later canonical read is independent and can recover immediately.
    expect(await readPersonalMt5Status({signal:new AbortController().signal})).toEqual(report("1200.000"));
    expect(fetcher).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
  } finally {monotonic.mockRestore();}
});

it("manual pending tracks the pre-click read and burst-coalesced trailing read until both settle", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let resolveFirst!: (value: unknown) => void, resolveNext!: (value: unknown) => void;
  const queryFn = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveNext = resolve; }));
  const observer = new QueryObserver(client, { queryKey: key, queryFn });
  const off = observer.subscribe(() => {}); const pending = vi.fn();
  const refresh = createPersonalAccountChangeRefresh(client, pending);
  try {
    refresh.notify(); refresh.notify(); refresh.notify();
    expect(pending.mock.calls).toEqual([[true]]); expect(queryFn).toHaveBeenCalledTimes(1);
    resolveFirst(report("1.000")); await vi.advanceTimersByTimeAsync(25);
    expect(queryFn).toHaveBeenCalledTimes(2); expect(pending.mock.calls).toEqual([[true]]);
    resolveNext(report("2.000")); await vi.advanceTimersByTimeAsync(0);
    expect(pending.mock.calls).toEqual([[true], [false]]);
    expect(client.getQueryData(key)).toEqual(report("2.000"));
  } finally { refresh.dispose(); off(); client.clear(); }
});

it.each(["missing", "disabled", "inactive-fetching"])("manual notification neither fetches nor stays busy for a %s reader", async kind => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const queryFn = vi.fn(async () => report("1.000"));
  let off = () => {};
  if (kind === "disabled") off = new QueryObserver(client, { queryKey: key, queryFn, enabled: false }).subscribe(() => {});
  if (kind === "inactive-fetching") {
    void client.fetchQuery({ queryKey: key, queryFn: () => new Promise(() => {}) }).catch(() => {});
  }
  const pending = vi.fn(); const refresh = createPersonalAccountChangeRefresh(client, pending);
  try {
    expect(refresh.notify()).toBe(true); await vi.advanceTimersByTimeAsync(0);
    expect(queryFn).not.toHaveBeenCalled(); expect(pending.mock.calls).toEqual([[true], [false]]);
    refresh.dispose(); expect(refresh.notify()).toBe(false);
  } finally { refresh.dispose(); off(); client.clear(); }
});
