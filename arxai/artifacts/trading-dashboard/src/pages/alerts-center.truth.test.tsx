// Alerts Center: GET /alerts/scanner is one process-wide list (no per-user
// filter, no expiry) stamped with the time each alert was pushed. The page
// must not call it a personal "Simulator only" feed, and a HOT setup raised
// hours ago must not keep reading as an actionable open recommendation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AlertsCenter, { alertAge } from "./alerts-center";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");

function alert(over: Record<string, unknown>) {
  return {
    alertId: "a1", severity: "info", source: "SCANNER", symbol: "EURUSD", timeframe: "M15",
    message: "HOT setup EURUSD M15: BUY (score 83)", reason: "Trend + pullback",
    recommendedAction: "Send EURUSD to AI assist or backtest before any live intent.",
    createdAt: new Date(NOW - 3 * 3600_000).toISOString(), acknowledgedAt: null,
    ...over,
  };
}

function serve(alerts: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ alerts, count: alerts.length, dataSource: "SIMULATOR" }), { status: 200 })));
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Alerts Center truth", () => {
  it("says the list is shared across users, not a personal simulator feed", async () => {
    serve([alert({})]);
    render(<AlertsCenter />);
    await screen.findByTestId("alert-a1");
    const scope = screen.getByTestId("alerts-center-scope").textContent ?? "";
    expect(scope).toMatch(/same list for every user/);
    expect(document.body.textContent).not.toContain("Simulator only");
  });

  it("a HOT setup raised 3h ago is shown with its age and no longer as an open recommendation", async () => {
    serve([alert({})]);
    render(<AlertsCenter />);
    const card = await screen.findByTestId("alert-a1");
    expect(card.textContent).toContain("3h 0m ago");
    expect(card.textContent).not.toContain("Recommended:");
    expect(screen.getByTestId("alert-superseded").textContent).toMatch(/Not re-checked for 3h 0m, longer than one M15 bar/);
  });

  it("an alert raised within its own bar keeps its recommendation, with its age shown", async () => {
    serve([alert({ alertId: "a2", createdAt: new Date(NOW - 4 * 60_000).toISOString() })]);
    render(<AlertsCenter />);
    const card = await screen.findByTestId("alert-a2");
    expect(card.textContent).toContain("Recommended:");
    expect(card.textContent).toContain("4 min ago");
    expect(screen.queryByTestId("alert-superseded")).toBeNull();
  });

  it("an alert with an unreadable time is never treated as current", () => {
    expect(alertAge({ createdAt: "not-a-date", timeframe: "M15" }, NOW)).toEqual({ ageMs: null, superseded: true });
    expect(alertAge({ createdAt: new Date(NOW - 20 * 60_000).toISOString(), timeframe: "H1" }, NOW).superseded).toBe(false);
    expect(alertAge({ createdAt: new Date(NOW - 20 * 60_000).toISOString() }, NOW).superseded).toBe(true);
  });
});
