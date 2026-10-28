// SL / TP editor: PATCH /positions/:id/stop-loss|take-profit queues the change
// to the broker and returns the UNCHANGED ledger row plus `pending`. The editor
// gave no sign of that, so a trader could take the edit as applied. It now
// says the request was sent and is not applied until the broker confirms.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StopLossTakeProfitEditor } from "./StopLossTakeProfitEditor";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const POSITION = { id: 11, stopLoss: 1.08, takeProfit: 1.09 } as never;

function mount(respond: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return respond(url, init);
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><StopLossTakeProfitEditor position={POSITION} /></QueryClientProvider>);
  return calls;
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("StopLossTakeProfitEditor pending broker confirmation", () => {
  it("a queued SL move says it is not applied until the broker confirms", async () => {
    mount(() => json({ id: 11, stopLoss: 1.08, pending: { commandId: "c1", venue: "LIVE", stopLoss: 1.081 } }));
    fireEvent.change(screen.getAllByPlaceholderText("empty = remove")[0], { target: { value: "1.081" } });
    fireEvent.click(screen.getByText("Update SL"));
    await waitFor(() => expect(screen.getByTestId("sltp-pending").textContent).toMatch(/Stop loss change request sent to the broker\. It is not applied until the broker confirms/));
  });

  it("a refused TP change shows the server's reason, not a pending note", async () => {
    mount(() => json({ error: "NOT_AN_ARX_GOVERNED_POSITION", message: "ARX did not open this position, so it cannot change it; use your trading terminal." }, 409));
    fireEvent.click(screen.getByText("Update TP"));
    await waitFor(() => expect(screen.getByTestId("sltp-error").textContent).toMatch(/ARX did not open this position/));
    expect(screen.queryByTestId("sltp-pending")).toBeNull();
  });
});
