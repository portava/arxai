// Demo order ticket — a refused market order shows the server's plain-English
// reason (not a bare code like IDEMPOTENCY_KEY_REQUIRED), the footer does not
// promise that market orders execute, and a booked order says what it was
// filled at, from which source, as of when.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperOrderTicket } from "./PaperOrderTicket";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><PaperOrderTicket accountId={1} /></QueryClientProvider>);
  fireEvent.change(screen.getByTestId("input-sl"), { target: { value: "1.08" } });
  fireEvent.change(screen.getByTestId("input-tp"), { target: { value: "1.09" } });
  fireEvent.click(screen.getByTestId("button-place-order"));
  return fetchMock;
}

describe("PaperOrderTicket market order truth", () => {
  it("a refusal shows the server's message, not the reason code", async () => {
    mount(400, {
      ok: false,
      result: {
        status: "REJECTED", mode: "SIMULATED", reason: "IDEMPOTENCY_KEY_REQUIRED",
        message: "A simulated open needs a request key so a retry cannot book twice.",
      },
    });
    const err = await screen.findByTestId("order-ticket-error");
    expect(err.textContent).toContain("A simulated open needs a request key so a retry cannot book twice.");
    expect(err.textContent).not.toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("a refusal with no message names the code as a refusal, not as bare text", async () => {
    mount(400, { ok: false, result: { status: "REJECTED", mode: "SIMULATED", reason: "SOME_GATE" } });
    const err = await screen.findByTestId("order-ticket-error");
    expect(err.textContent).toMatch(/refused/i);
    expect(err.textContent).toContain("SOME_GATE");
  });

  it("the footer does not claim that market orders execute", () => {
    vi.stubGlobal("fetch", vi.fn());
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><PaperOrderTicket accountId={1} /></QueryClientProvider>);
    expect(screen.getByTestId("order-ticket").textContent).not.toContain("Market orders execute as SIMULATED");
    expect(screen.getByTestId("order-ticket-footer").textContent).toMatch(/refuse/i);
  });

  it("a booked order shows its fill price, price source and quote time", async () => {
    const quoteAt = "2026-10-28T10:15:30.000Z";
    mount(200, {
      ok: true,
      result: {
        status: "SIMULATED_FILL", mode: "SIMULATED", reason: "PAPER_ORDER:9",
        paper: { paperOrderId: 9, fillPrice: 1.08512, priceSource: "REAL:twelvedata", quoteAt, replayed: false },
      },
    });
    const ok = await screen.findByTestId("order-ticket-filled");
    expect(ok.textContent).toContain("1.08512");
    expect(ok.textContent).toContain("REAL:twelvedata");
    expect(ok.textContent).toContain(new Date(quoteAt).toLocaleTimeString());
    expect(ok.textContent).not.toBe("Market order accepted.");
  });
});
