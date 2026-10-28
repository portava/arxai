// Alerts Center: the badge must be the server's open (unacknowledged) count,
// labelled, not the length of whatever page is shown (which switches to
// open+acknowledged on "Show all"). The alert store is in server memory and
// lost on restart, so a failed load or an empty store must not read as
// "No alerts yet — start the scanner".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AlertsCenter from "./alerts-center";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");

function alert(i: number, over: Record<string, unknown> = {}) {
  return {
    alertId: `a${i}`, severity: "info", source: "SCANNER", symbol: "EURUSD", timeframe: "M15",
    message: `HOT setup ${i}`, reason: "Trend + pullback", recommendedAction: "Backtest first.",
    createdAt: new Date(NOW - 2 * 60_000).toISOString(), acknowledgedAt: null, ...over,
  };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Alerts Center counts and empty state", () => {
  it("a failed load is an error state, not 'No alerts yet'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    render(<AlertsCenter />);
    const err = await screen.findByTestId("alerts-load-error");
    expect(err.textContent).toMatch(/could not be loaded/i);
    expect(document.body.textContent).not.toMatch(/No alerts yet/);
    expect(document.body.textContent).not.toMatch(/start the scanner/);
  });

  it("an empty store says it is in-memory and cleared on restart", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ alerts: [], count: 0 }), { status: 200 })));
    render(<AlertsCenter />);
    const empty = await screen.findByTestId("alerts-empty");
    expect(empty.textContent).toMatch(/server memory/i);
    expect(empty.textContent).toMatch(/restart/i);
    expect(empty.textContent).not.toMatch(/start the scanner/);
  });

  it("the badge is the server's open count, labelled, not the length of the shown page", async () => {
    const shown = Array.from({ length: 100 }, (_, i) => alert(i, i % 2 ? { acknowledgedAt: new Date(NOW).toISOString() } : {}));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ alerts: shown, count: 42 }), { status: 200 })));
    render(<AlertsCenter />);
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    await screen.findByTestId("alert-a0");
    await waitFor(() => expect(screen.getByTestId("alerts-open-count").textContent).toBe("42 open"));
    expect(screen.getByTestId("alerts-shown-count").textContent).toMatch(/Showing the newest 100/);
  });

  it("a complete count over the list limit is the true number, not 'at least 100'", async () => {
    const shown = Array.from({ length: 100 }, (_, i) => alert(i));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ alerts: shown, count: 150, countComplete: true }), { status: 200 })));
    render(<AlertsCenter />);
    await screen.findByTestId("alert-a0");
    expect(screen.getByTestId("alerts-open-count").textContent).toBe("150 open");
  });

  it("a count the server marks incomplete is a lower bound, with the server's reason as the tooltip", async () => {
    const note = "At least this many: 50 older open alerts were pushed out because the server keeps only the newest 200.";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ alerts: [alert(1)], count: 200, countComplete: false, countNote: note }), { status: 200 })));
    render(<AlertsCenter />);
    await screen.findByTestId("alert-a1");
    const badge = screen.getByTestId("alerts-open-count");
    expect(badge.textContent).toBe("at least 200 open");
    expect(badge.getAttribute("title")).toBe(note);
  });
});
