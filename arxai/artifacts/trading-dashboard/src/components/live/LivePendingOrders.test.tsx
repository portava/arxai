// LivePendingOrders — Cancel / Modify for live pending orders.
//   vitest run src/components/live/LivePendingOrders.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
const oc = { mode: { on: false } };
vi.mock("@/hooks/useOneClickMode", () => ({ useOneClickMode: () => oc }));

const { LivePendingOrders } = await import("./LivePendingOrders");
const { pendingModifyChanges } = await import("@/lib/livePendingControl");

const order = (over: Record<string, unknown> = {}) => ({
  commandId: "lvcmd_a", orderTicket: "7001", symbol: "EURUSD", side: "BUY", orderType: "BUY_LIMIT", volume: 0.1,
  price: 1.09, stopLimitPrice: null, stopLoss: 1.08, takeProfit: 1.12, expiration: null, placedAt: null,
  controllable: true, controlInFlight: false, ...over,
});

type Call = { url: string; body: Record<string, unknown> | null };
function stubFetch(items: unknown[], opts: { hold?: Promise<void>; reply?: Record<string, unknown>; status?: number } = {}) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ url, body });
    if (url.includes("/api/me/live/pending-orders/") && init?.method === "POST") {
      if (opts.hold) await opts.hold;
      return new Response(JSON.stringify(opts.reply ?? { ok: true, commandId: "lvcmd_ctl" }), { status: opts.status ?? 200 });
    }
    if (url.includes("/api/data/quote")) return new Response(JSON.stringify({ bid: 1.0999, ask: 1.1, stale: false }));
    return new Response(JSON.stringify({ ok: true, items }));
  });
  vi.stubGlobal("fetch", f);
  return calls;
}
const posts = (calls: Call[]) => calls.filter((c) => c.body != null);
const listLoads = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/api/me/live/pending-orders")).length;

function withQc(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); toast.mockClear(); oc.mode.on = false; });

describe("LivePendingOrders cancel", () => {
  it("one-click OFF: asks first, then sends confirmedByUser and refreshes the list", async () => {
    const calls = stubFetch([order()]);
    render(withQc(<LivePendingOrders />));
    fireEvent.click(await screen.findByTestId("live-pending-cancel-7001"));
    expect(screen.getByTestId("live-pending-cancel-confirm")).toBeTruthy();
    expect(posts(calls)).toHaveLength(0);
    const before = listLoads(calls);
    fireEvent.click(screen.getByTestId("live-pending-cancel-confirm-ok"));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]!.url).toMatch(/\/api\/me\/live\/pending-orders\/lvcmd_a\/cancel$/);
    expect(posts(calls)[0]!.body).toEqual({ confirmedByUser: true });
    await waitFor(() => expect(listLoads(calls)).toBeGreaterThan(before));
    expect(toast.mock.calls[0]![0]).toMatchObject({ title: "Cancel sent to MT5" });
  });

  it("one-click ON: sends on the first press, buttons disabled while in flight, no double submit", async () => {
    oc.mode.on = true;
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const calls = stubFetch([order(), order({ commandId: "lvcmd_b", orderTicket: "7002" })], { hold });
    render(withQc(<LivePendingOrders />));
    const btn = await screen.findByTestId("live-pending-cancel-7001") as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(screen.queryByTestId("live-pending-cancel-confirm")).toBeNull();
    await waitFor(() => expect((screen.getByTestId("live-pending-cancel-7001") as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByTestId("live-pending-cancel-7002") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("live-pending-modify-7001") as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect((screen.getByTestId("live-pending-cancel-7001") as HTMLButtonElement).disabled).toBe(false));
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]!.body).toEqual({ oneClick: true });
  });

  it("a refusal is shown, not reported as sent", async () => {
    oc.mode.on = true;
    stubFetch([order()], { status: 409, reply: { ok: false, reason: "PENDING_ORDER_CONTROL_IN_FLIGHT", detail: "A cancel or change for this order is already on its way to MT5." } });
    render(withQc(<LivePendingOrders />));
    fireEvent.click(await screen.findByTestId("live-pending-cancel-7001"));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0]![0]).toMatchObject({ variant: "destructive", title: "Cancel not sent", description: expect.stringMatching(/already on its way/) });
  });

  it("orders ARX cannot control, or with a control in flight, have their buttons disabled", async () => {
    stubFetch([order({ controllable: false }), order({ commandId: "lvcmd_b", orderTicket: "7002", controlInFlight: true })]);
    render(withQc(<LivePendingOrders />));
    expect(((await screen.findByTestId("live-pending-cancel-7001")) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("live-pending-modify-7001") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("live-pending-cancel-7002") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("live-pending-inflight-7002")).toBeTruthy();
  });
});

describe("LivePendingOrders modify", () => {
  it("MT5 side rule: a Buy Limit above the Ask is refused before sending", async () => {
    const calls = stubFetch([order()]);
    render(withQc(<LivePendingOrders />));
    fireEvent.click(await screen.findByTestId("live-pending-modify-7001"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/data/quote"))).toBe(true));
    fireEvent.change(screen.getByTestId("live-pending-modify-price"), { target: { value: "1.101" } });
    await waitFor(() => expect(screen.getByTestId("live-pending-modify-error").textContent).toMatch(/below the Ask/));
    expect((screen.getByTestId("live-pending-modify-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(posts(calls)).toHaveLength(0);
  });

  it("sends only the changed levels with confirmedByUser, then closes", async () => {
    const calls = stubFetch([order()]);
    render(withQc(<LivePendingOrders />));
    fireEvent.click(await screen.findByTestId("live-pending-modify-7001"));
    fireEvent.change(screen.getByTestId("live-pending-modify-price"), { target: { value: "1.095" } });
    fireEvent.change(screen.getByTestId("live-pending-modify-tp"), { target: { value: "1.13" } });
    const submit = screen.getByTestId("live-pending-modify-submit") as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]!.url).toMatch(/\/lvcmd_a\/modify$/);
    expect(posts(calls)[0]!.body).toEqual({ confirmedByUser: true, price: 1.095, tp: 1.13 });
    await waitFor(() => expect(screen.queryByTestId("live-pending-modify-dialog")).toBeNull());
  });

  it("an unchanged ticket cannot be submitted", async () => {
    stubFetch([order()]);
    render(withQc(<LivePendingOrders />));
    fireEvent.click(await screen.findByTestId("live-pending-modify-7001"));
    expect((screen.getByTestId("live-pending-modify-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("live-pending-modify-error").textContent).toMatch(/Change the price/);
  });
});

describe("pendingModifyChanges", () => {
  const current = { price: 1.09, stopLoss: 1.08, takeProfit: 1.12 };
  it("empty or equal fields are not sent; bad numbers refused", () => {
    expect(pendingModifyChanges({ current, priceText: "", slText: "1.08", tpText: "1.125" })).toEqual({ price: null, stopLoss: null, takeProfit: 1.125, error: null });
    expect(pendingModifyChanges({ current, priceText: "abc", slText: "", tpText: "" }).error).toMatch(/Price must be/);
    expect(pendingModifyChanges({ current, priceText: "1.09", slText: "", tpText: "" }).error).toMatch(/Change the price/);
  });
});
