// Reports page truth: the Rows column printed `rowCount ?? 0`, so a report
// still processing or one that failed read "0 rows" as if it had completed
// empty. The demo-trade report types also read a different book (the trades
// logged on My Demo Trades) from the Calendar page and Ruby Memory (the demo
// sandbox order ledger) under the same "Demo Trades" name.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import ReportsPage from "./reports";
import { DEFAULT_ASSISTANT_NAME } from "@/lib/assistant-name";

const row = (id: number, status: string, rowCount: number | null) => ({
  id, reportType: "performance_calendar", format: "csv", status, title: `r${id}`,
  fileName: null, fileSize: null, rowCount, downloadUrl: null, errorMessage: null,
  createdAt: "2026-10-27T10:00:00.000Z", completedAt: null,
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function renderWith(reports: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ reports, isEmpty: reports.length === 0, emptyHints: [] }) }) as Response));
  render(<ReportsPage />);
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
}
const rowsCell = (id: number) => screen.getByTestId(`report-row-${id}`).querySelectorAll("td")[4]!.textContent;

describe("Reports — Rows column", () => {
  it("a processing or failed report has no row count, never 0", async () => {
    await renderWith([row(1, "processing", null), row(2, "failed", null), row(3, "completed", 0), row(4, "completed", 12)]);
    expect(rowsCell(1)).not.toBe("0");
    expect(rowsCell(1)).toMatch(/not counted/i);
    expect(rowsCell(2)).not.toBe("0");
    expect(rowsCell(2)).toMatch(/not counted/i);
    expect(rowsCell(3)).toBe("0");
    expect(rowsCell(4)).toBe("12");
  });
});

// A failed history read used to leave the list empty (api() returned the
// error body as-is, then `r.reports ?? []`), so it read "No reports yet."
describe("Reports — failed history read", () => {
  async function renderReply(reply: { ok: boolean; status: number; body: unknown } | "network") {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (reply === "network") throw new TypeError("Failed to fetch");
      return { ok: reply.ok, status: reply.status, json: async () => reply.body } as Response;
    }));
    render(<ReportsPage />);
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
  }

  it("a 401/500 says the reports could not be loaded, never 'No reports yet.'", async () => {
    await renderReply({ ok: false, status: 500, body: { error: "internal" } });
    expect(screen.getByTestId("reports-load-error").textContent).toMatch(/could not be loaded; this is not an empty list/);
    expect(screen.queryByTestId("reports-empty-state")).toBeNull();
    expect(document.body.textContent).not.toMatch(/No reports yet/);
  });

  it("a network error is a load failure too", async () => {
    await renderReply("network");
    expect(screen.getByTestId("reports-load-error")).toBeTruthy();
    expect(screen.queryByTestId("reports-empty-state")).toBeNull();
  });

  it("an ok reply without a reports array is not read as empty", async () => {
    await renderReply({ ok: true, status: 200, body: { error: "unexpected" } });
    expect(screen.getByTestId("reports-load-error")).toBeTruthy();
    expect(screen.queryByTestId("reports-empty-state")).toBeNull();
  });

  it("a good empty read still shows the empty state", async () => {
    await renderWith([]);
    expect(screen.getByTestId("reports-empty-state")).toBeTruthy();
    expect(screen.queryByTestId("reports-load-error")).toBeNull();
  });
});

describe("Reports — demo-trade book and date range are named", () => {
  it("says which demo-trade record the reports read and that the end day is included", async () => {
    await renderWith([]);
    const note = screen.getByTestId("reports-range-source-note").textContent ?? "";
    expect(note).toContain("My Demo Trades");
    expect(note).toMatch(/Calendar page/);
    // Port: the assistant's Memory tab is named through the assistant-name resolver.
    expect(note).toContain(`Memory tab in ${DEFAULT_ASSISTANT_NAME} Command Center`);
    expect(note).toMatch(/end day is included/i);
  });
});
