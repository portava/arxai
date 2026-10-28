// Truth: a paper close whose P&L could not be sized for its instrument stores
// 0 as a placeholder. The balance used to stay put on a stop or target hit,
// reading as a measured zero change. The server now counts such a close at
// the paper risk model and says so in account.pnlSizing; the card must show
// that note next to the balance, and show nothing extra when every close was
// sized. The same note covers open positions the equity cannot size.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperAccountCard } from "./PaperAccountCard";

const account = {
  id: 9, accountName: "Practice", startingBalance: 10_000, currentBalance: 9_990, equity: 9_990,
  marginUsed: 0, isActive: 1, createdAt: "2026-10-28T00:00:00Z",
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderWith(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PaperAccountCard /></QueryClientProvider>);
}

describe("PaperAccountCard balance sizing note", () => {
  it("says when the balance counts closes whose P&L could not be sized", async () => {
    const note = "Balance includes 1 closed trade whose P&L could not be sized for the instrument (no contract size or currency conversion). It is counted at the paper risk model (price move × lots × 100), not a measured amount.";
    renderWith({ account: { ...account, pnlSizing: { unsizedClosedOrders: 1, unsizedOpenPositions: 0, note } } });
    await waitFor(() => expect(screen.getByText("Practice")).toBeTruthy());
    expect(screen.getByTestId("paper-account-sizing-note").textContent).toBe(note);
  });

  it("shows no note when every close was sized", async () => {
    renderWith({ account: { ...account, pnlSizing: { unsizedClosedOrders: 0, unsizedOpenPositions: 0, note: null } } });
    await waitFor(() => expect(screen.getByText("Practice")).toBeTruthy());
    expect(screen.queryByTestId("paper-account-sizing-note")).toBeNull();
  });
});
