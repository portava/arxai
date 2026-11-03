// Reports page truth: the Rows column printed `rowCount ?? 0`, so a report
// still processing or one that failed read "0 rows" as if it had completed
// empty. The demo-trade report types also read a different book (the trades
// logged on My Demo Trades) from the Calendar page and Ruby Memory (the demo
// sandbox order ledger) under the same "Demo Trades" name.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import ReportsPage from "./reports";

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

describe("Reports — demo-trade book and date range are named", () => {
  it("says which demo-trade record the reports read and that the end day is included", async () => {
    await renderWith([]);
    const note = screen.getByTestId("reports-range-source-note").textContent ?? "";
    expect(note).toContain("My Demo Trades");
    expect(note).toMatch(/Calendar page/);
    expect(note).toMatch(/end day is included/i);
  });
});
