// Scalp Journal summary strip: the page asks for limit 200 and the service
// caps at 200 (scalpJournalService.getScalpJournal), so a full page of 200
// rows is the newest 200, not the whole record. "signals tracked: 200" and
// counts/win rate derived from it must say they cover only that window.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ entries: [] as unknown[] }));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetMeScalpJournal: () => ({ data: { entries: h.entries, generatedAt: "2026-10-28T12:00:00Z" }, isFetching: false, isLoading: false, isError: false, refetch: () => {} }),
  useGetMeScalpReviews: () => ({ data: { reviews: [], generatedAt: "2026-10-28T12:00:00Z" }, isFetching: false, isLoading: false, isError: false, refetch: () => {} }),
  useGetMeScalpPersonality: () => ({ data: { symbols: [], generatedAt: "2026-10-28T12:00:00Z" }, isFetching: false, isLoading: false, isError: false, refetch: () => {} }),
}));

const { default: ScalpJournalPage } = await import("./scalp-journal");

function entry(id: number) {
  return {
    id, accountMode: "PAPER", symbol: "EURUSD", displayName: "EUR/USD", isSynthetic: false,
    direction: "BUY", timeframe: "M1", entryCount: 1, addOnCount: 0, status: "CLOSED",
    result: id % 2 ? "WIN" : "LOSS", plQuality: "REALIZED", realizedPl: 1,
    openedAt: "2026-10-27T10:00:00Z", closedAt: "2026-10-27T10:05:00Z",
  };
}

afterEach(cleanup);

describe("Scalp Journal summary scope", () => {
  it("a full 200-row page is labelled as the newest 200, not the whole record", () => {
    h.entries = Array.from({ length: 200 }, (_, i) => entry(i + 1));
    render(<ScalpJournalPage />);
    const total = screen.getByTestId("scalp-summary-total").textContent ?? "";
    expect(total).not.toMatch(/^200signals tracked$/);
    expect(total).toMatch(/newest 200/);
    expect(screen.getByTestId("scalp-summary-scope").textContent).toMatch(/older signals are not loaded or counted/);
    expect(screen.getByText(/of the newest 200 signals/)).toBeTruthy();
  });

  it("below the page limit the count is the whole record", () => {
    h.entries = Array.from({ length: 12 }, (_, i) => entry(i + 1));
    render(<ScalpJournalPage />);
    expect(screen.getByTestId("scalp-summary-total").textContent).toBe("12signals tracked");
    expect(screen.queryByTestId("scalp-summary-scope")).toBeNull();
  });
});
