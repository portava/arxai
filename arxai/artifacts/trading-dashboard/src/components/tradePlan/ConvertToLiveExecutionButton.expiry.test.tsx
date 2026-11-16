// A plan sent to confirmation shows the request's state. The request expires
// 5 minutes after it is created, but GET /execution-confirmations/:id does not
// sweep expiry, so every refetch returns the same PENDING row. React Query
// keeps the same data reference for an unchanged row and the component did
// not re-render, so "Waiting for your confirmation — expires at X" stayed on
// screen after X. The text must turn to "Expired" once the expiry passes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SentToConfirmationStatus } from "./ConvertToLiveExecutionButton";

const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
let row: Record<string, unknown>;
const fetchMock = vi.fn(async () => new Response(JSON.stringify(row), { status: 200, headers: { "content-type": "application/json" } }));

let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: T0 });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function confirmation(patch: Record<string, unknown>) {
  return {
    id: 7, status: "PENDING", practiceMode: true, executionResult: null, executedTradeId: null,
    confirmedAtIso: null, cancelledAtIso: null, executedAtIso: null,
    expiresAtIso: new Date(T0 + 2 * 60_000).toISOString(),
    ...patch,
  };
}

describe("SentToConfirmationStatus — expiry is re-evaluated as time passes", () => {
  for (const status of ["PENDING", "CONFIRMED"]) {
    it(`a ${status} request turns to Expired after its expiry with no change to the row`, async () => {
      row = confirmation({ status, confirmedAtIso: status === "CONFIRMED" ? new Date(T0).toISOString() : null });
      render(
        <QueryClientProvider client={client}>
          <SentToConfirmationStatus confirmationId={7} />
        </QueryClientProvider>,
      );
      expect(await screen.findByText(status === "PENDING" ? /Waiting for your confirmation/ : /not executed yet/)).toBeTruthy();
      expect(screen.queryByText(/Expired/)).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60_000 + 1_000);
      });
      expect(screen.getByText(/Expired .*without being confirmed and executed/)).toBeTruthy();
      expect(screen.queryByText(/Waiting for your confirmation/)).toBeNull();
      expect(screen.queryByText(/not executed yet/)).toBeNull();
    });
  }

  it("a cancelled request sets no expiry timer and keeps its text", async () => {
    row = confirmation({ status: "CANCELLED", cancelledAtIso: new Date(T0).toISOString() });
    render(
      <QueryClientProvider client={client}>
        <SentToConfirmationStatus confirmationId={7} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/^Cancelled/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(screen.getByText(/^Cancelled/)).toBeTruthy();
    expect(screen.queryByText(/Expired/)).toBeNull();
  });
});
