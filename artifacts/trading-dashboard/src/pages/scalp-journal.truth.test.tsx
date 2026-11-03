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

// Regression (review of 8152161c): fmtMoney was removed from scalpLabels while
// this page still imported it, so a KNOWN or ESTIMATED entry threw on render
// ("fmtMoney is not a function") and the production build failed. Journal P/L
// is in the account's currency, which the entry does not carry: it must not be
// printed with an assumed "$".
describe("Scalp Journal P/L currency", () => {
  it("a KNOWN realised P/L renders in the account currency, never an assumed $", () => {
    h.entries = [{ ...entry(1), plQuality: "KNOWN", realizedPl: 12.4 }];
    render(<ScalpJournalPage />);
    const row = screen.getByTestId("scalp-journal-row");
    expect(row.textContent).toContain("12.40 (account currency)");
    expect(row.textContent).not.toMatch(/\$/);
  });

  it("an ESTIMATED P/L renders in the account currency and says it is estimated", () => {
    h.entries = [{ ...entry(2), plQuality: "ESTIMATED", realizedPl: null, lastFloatingPl: -3.5 }];
    render(<ScalpJournalPage />);
    const row = screen.getByTestId("scalp-journal-row");
    expect(row.textContent).toContain("-3.50 (account currency)");
    expect(row.textContent).toMatch(/estimated from the last reading/);
    expect(row.textContent).not.toMatch(/\$/);
  });
});

describe("Scalp Journal results graded from an estimate", () => {
  it("ESTIMATED rows are badged as likely outcomes and the win rate is labelled estimated", () => {
    h.entries = Array.from({ length: 6 }, (_, i) => ({ ...entry(i + 1), plQuality: "ESTIMATED", realizedPl: null, lastFloatingPl: 2 }));
    render(<ScalpJournalPage />);
    const rows = screen.getAllByTestId("scalp-journal-row");
    expect(rows[0]!.textContent).toMatch(/Likely (win|loss) \(estimated\)/);
    for (const r of rows) expect(r.textContent).not.toMatch(/\bWin\b|\bLoss\b/);
    expect(screen.getByTestId("scalp-summary-winrate").textContent).toMatch(/estimated win rate/);
  });

  it("a KNOWN (broker-realised) row keeps a plain Win badge", () => {
    h.entries = [{ ...entry(1), plQuality: "KNOWN", realizedPl: 5 }];
    render(<ScalpJournalPage />);
    const row = screen.getByTestId("scalp-journal-row");
    expect(row.textContent).toMatch(/Win/);
    expect(row.textContent).not.toMatch(/estimated\)/);
  });
});
