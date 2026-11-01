import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { getGetMeSharedAccountSummaryQueryKey } from "@workspace/api-client-react";
import { readSharedAccountSummary, sharedAccountSummaryReadOptions, ACCOUNT_SUMMARY_READ_TIMEOUT_MS } from "./readSharedAccountSummary";
import { createSharedAccountChangeRefresh } from "./sharedAccountChangeRefresh";

const key = getGetMeSharedAccountSummaryQueryKey();
const report = (balance: string) => ({ ok: true, masterMt5: { nativeAccountReport: {
  status: "reported", currentVerified: false, currency: "KWD", currencyDigits: 3,
  observedAt: "2026-11-01T12:00:00.000Z", receivedAt: "2026-11-01T12:00:00.100Z",
  amounts: { balance, equity: "0.000", profit: "-9.123", credit: "1.000", margin: "0.000", freeMargin: "0.000" },
} } });
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
  const observer = new QueryObserver(client, { queryKey: key, ...sharedAccountSummaryReadOptions });
  const unsubscribe = observer.subscribe(() => {});
  const refresh = createSharedAccountChangeRefresh(client);
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
  const value = await readSharedAccountSummary({ signal: new AbortController().signal });
  expect(value).toEqual(report("12345678901234567890.123"));
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start a request for a cancelled observer", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController(); controller.abort();
  await expect(readSharedAccountSummary({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("cancellation rejects even an abort-ignoring transport and removes its deadline", async () => {
  const fetcher = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  const result = readSharedAccountSummary({ signal: controller.signal }).catch(error => error);
  controller.abort();
  expect(await result).toMatchObject({ name: "AbortError" });
  expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([null, new Error("offline")])("rejects the original failure and clears its deadline (%s)", async failure => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
  const outcome = await readSharedAccountSummary({ signal: new AbortController().signal }).then(
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
    const result=readSharedAccountSummary({signal:new AbortController().signal}).then(value=>({ok:true,value}),error=>({ok:false,error}));
    // The transport continuation can be queued before a busy event loop runs
    // its overdue timeout task. Advance only the monotonic clock, not timers.
    await Promise.resolve();clock+=ACCOUNT_SUMMARY_READ_TIMEOUT_MS;
    resolveOld(stage==="headers"?response(report("900.000")):JSON.stringify(report("900.000")));
    const settled=await result;
    expect(settled.ok).toBe(false);expect("error" in settled && settled.error).toEqual(new Error("Account update timed out. Waiting for a new report."));
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
    // A later canonical read is independent and can recover immediately.
    expect(await readSharedAccountSummary({signal:new AbortController().signal})).toEqual(report("1200.000"));
    expect(fetcher).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
  } finally {monotonic.mockRestore();}
});

it('accepts completed decoding just before the monotonic deadline',async()=>{
 let clock=100,resolve!: (value:Response)=>void;const now=vi.spyOn(performance,'now').mockImplementation(()=>clock);
 vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(done=>{resolve=done;})));
 try{const result=readSharedAccountSummary({signal:new AbortController().signal});clock+=ACCOUNT_SUMMARY_READ_TIMEOUT_MS-1;resolve(response(report('1234.567')));expect(await result).toEqual(report('1234.567'));expect(vi.getTimerCount()).toBe(0);}finally{now.mockRestore();}
});
it('preserves an original failure even when its timer callback has been delayed',async()=>{
 let clock=100,reject!: (value:unknown)=>void;const now=vi.spyOn(performance,'now').mockImplementation(()=>clock),failure=new Error('Transport failed');
 vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>((_done,fail)=>{reject=fail;})));
 try{const result=readSharedAccountSummary({signal:new AbortController().signal}).catch(error=>error);clock+=ACCOUNT_SUMMARY_READ_TIMEOUT_MS;reject(failure);expect(await result).toBe(failure);expect(vi.getTimerCount()).toBe(0);}finally{now.mockRestore();}
});
