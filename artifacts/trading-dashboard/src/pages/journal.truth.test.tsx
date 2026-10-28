// Trade Journal: "No journal entries yet" must only mean the journal is
// empty. An emotion filter with no matches, or a failed GET /journal, must
// say what actually happened (the stats row above still counts the entries).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import JournalPage from "./journal";

function entry(id: number, over: Record<string, unknown> = {}) {
  return {
    id, symbol: "EURUSD", direction: "BUY", strategy: "Trend Continuation", entryIdea: "x",
    actualOutcome: "y", pnl: 5, emotionTag: "Calm", mistakeTag: null, lessonLearned: null,
    createdAt: "2026-10-27T10:00:00.000Z", ...over,
  };
}
function serve(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><JournalPage /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Trade Journal truth", () => {
  it("a filter that hides every entry says so, not 'No journal entries yet'", async () => {
    serve(200, Array.from({ length: 30 }, (_, i) => entry(i + 1)));
    renderPage();
    await screen.findAllByText("EURUSD");
    fireEvent.click(screen.getByRole("button", { name: "Revenge" }));
    expect(screen.queryByText("No journal entries yet")).toBeNull();
    expect(screen.getByTestId("journal-empty").textContent).toMatch(/No entries match the "Revenge" filter/);
    expect(screen.getByTestId("journal-empty").textContent).toMatch(/30/);
  });

  it("a failed load is an error state, not an empty journal with zero stats", async () => {
    serve(500, { error: "db down" });
    renderPage();
    const err = await screen.findByTestId("journal-load-error");
    expect(err.textContent).toMatch(/could not be loaded/i);
    expect(screen.queryByText("No journal entries yet")).toBeNull();
    expect(document.body.textContent).not.toContain("$0.00");
  });

  it("an empty journal still says 'No journal entries yet'", async () => {
    serve(200, []);
    renderPage();
    expect((await screen.findByTestId("journal-empty")).textContent).toMatch(/No journal entries yet/);
  });

  it("at the server's 100-entry page the count is labelled as the newest 100, not the total", async () => {
    serve(200, Array.from({ length: 100 }, (_, i) => entry(i + 1)));
    renderPage();
    await screen.findAllByText("EURUSD");
    expect(screen.getByText("Entries (newest 100)")).toBeTruthy();
    expect(screen.queryByText("Total Entries")).toBeNull();
  });
});
