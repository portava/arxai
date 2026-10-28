// HighImpactEventBanner truth.
//
// The banner used to (a) render "0m · HIGH" for an event that had already
// released (Math.max(0, …)), (b) vanish once the route's eventTime >= now
// filter dropped it — while the Truth news window still treats the first 30
// minutes after a release as active — and (c) render nothing on a failed
// fetch, identical to a quiet calendar.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HighImpactEventBanner } from "./HighImpactEventBanner";

function mount(respond: (url: string) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    respond(typeof input === "string" ? input : input.toString()),
  );
  vi.stubGlobal("fetch", fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <HighImpactEventBanner />
    </QueryClientProvider>,
  );
  return fetchMock;
}

function event(offsetMs: number) {
  return { id: 7, eventName: "CPI y/y", currency: "USD", impactLevel: "HIGH", eventTime: new Date(Date.now() + offsetMs).toISOString() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HighImpactEventBanner", () => {
  it("a just-released event reads 'released Xm ago', never '0m', and stays visible", async () => {
    const fetchMock = mount(() => new Response(JSON.stringify({ events: [event(-10 * 60_000)] }), { status: 200 }));
    const row = await screen.findByTestId("high-impact-event-7");
    expect(row.textContent).toMatch(/^released 10m ago · HIGH/);
    expect(row.textContent).not.toMatch(/^0m/);
    expect(screen.getByTestId("high-impact-banner").textContent).toMatch(/post-release volatility window/);
    // The banner asks the server for the post-release window.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("pastMinutes=30");
  });

  it("an upcoming event shows its countdown", async () => {
    mount(() => new Response(JSON.stringify({ events: [event(20 * 60_000)] }), { status: 200 }));
    const row = await screen.findByTestId("high-impact-event-7");
    expect(row.textContent).toMatch(/^in 20m · HIGH/);
  });

  it("a failed calendar check says so instead of rendering nothing", async () => {
    mount(() => new Response(JSON.stringify({ error: "Invalid request" }), { status: 400 }));
    const note = await screen.findByTestId("high-impact-banner-unavailable");
    expect(note.textContent).toMatch(/Could not check the economic calendar/);
    expect(note.textContent).toMatch(/not an all-clear/);
  });

  it("a quiet calendar renders nothing", async () => {
    const fetchMock = mount(() => new Response(JSON.stringify({ events: [] }), { status: 200 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("high-impact-banner")).toBeNull();
    expect(screen.queryByTestId("high-impact-banner-unavailable")).toBeNull();
  });
});
