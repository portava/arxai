// Post-trade Debriefs: a failed GET /post-trade-debriefs used to read as
// "History (0)" / "No debriefs yet." (the page did r.json() with no ok
// check). The "waiting for debrief" count only covers the active paper
// account's newest orders page (server caps GET /paper/orders at 200), so it
// must say so, and an unavailable active account must not silently hide it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PostTradeDebriefsPage from "./post-trade-debriefs";

type Route = { status: number; body: unknown };
function serve(routes: { debriefs: Route; active: Route; orders?: Route }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const r = url.startsWith("/api/post-trade-debriefs") ? routes.debriefs
      : url.startsWith("/api/paper/accounts/active") ? routes.active
      : url.startsWith("/api/paper/orders") ? (routes.orders ?? { status: 200, body: { orders: [] } })
      : { status: 404, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }));
}
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PostTradeDebriefsPage /></QueryClientProvider>);
}
function order(id: number) {
  return { id, symbol: "EURUSD", direction: "BUY", status: "CLOSED", profitLoss: 1.5, closedAt: "2026-10-27T10:00:00Z" };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Post-trade Debriefs truth", () => {
  it("a failed debrief load is an error, not 'History (0)' / 'No debriefs yet.'", async () => {
    serve({ debriefs: { status: 500, body: { error: "db down" } }, active: { status: 200, body: { account: { id: 7 } } } });
    renderPage();
    const err = await screen.findByTestId("debriefs-load-error");
    expect(err.textContent).toMatch(/could not be loaded/i);
    expect(document.body.textContent).not.toContain("No debriefs yet.");
    expect(document.body.textContent).not.toContain("History (0)");
  });

  it("the waiting count is labelled as covering only the active account's newest orders page", async () => {
    const orders = Array.from({ length: 200 }, (_, i) => order(1000 - i));
    serve({
      debriefs: { status: 200, body: { debriefs: [] } },
      active: { status: 200, body: { account: { id: 7 } } },
      orders: { status: 200, body: { orders } },
    });
    renderPage();
    const banner = await screen.findByTestId("debriefs-waiting");
    expect(banner.textContent).toMatch(/At least 200 closed trades waiting/);
    expect(banner.textContent).toMatch(/active paper account/);
    expect(banner.textContent).toMatch(/older/i);
  });

  it("an unavailable active paper account says the waiting list could not be checked", async () => {
    serve({
      debriefs: { status: 200, body: { debriefs: [] } },
      active: { status: 503, body: { error: "Paper account valuation unavailable: a current real quote is required" } },
    });
    renderPage();
    const note = await screen.findByTestId("debriefs-waiting-unchecked");
    expect(note.textContent).toMatch(/could not be checked/);
    expect(note.textContent).toMatch(/503/);
  });
});
