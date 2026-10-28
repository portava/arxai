// Alerts Center: every scanner alert says which feed the scan behind it ran
// on. An alert from a simulated, delayed or awaiting-feed scan is labelled as
// such and does not carry an open recommendation, even within its first bar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AlertsCenter from "./alerts-center";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");

function alert(over: Record<string, unknown>) {
  return {
    alertId: "a1", severity: "info", source: "SCANNER", symbol: "EURUSD", timeframe: "M15",
    message: "HOT setup EURUSD M15: BUY (score 82)", reason: "Trend + pullback",
    recommendedAction: "Send EURUSD to AI assist or backtest before any live intent.",
    createdAt: new Date(NOW - 4 * 60_000).toISOString(), acknowledgedAt: null,
    ...over,
  };
}

function serve(alerts: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ alerts, count: alerts.length }), { status: 200 })));
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Alerts Center scan data source", () => {
  it("an alert from a stale-feed scan says so and carries no recommendation", async () => {
    serve([alert({ dataSource: "STALE_FEED" })]);
    render(<AlertsCenter />);
    const card = await screen.findByTestId("alert-a1");
    expect(screen.getByTestId("alert-data-source").textContent).toMatch(/delayed feed/i);
    expect(card.textContent).not.toContain("Recommended:");
  });

  it("an alert from a simulated scan says it ran on simulated data", async () => {
    serve([alert({ dataSource: "SIMULATOR" })]);
    render(<AlertsCenter />);
    const card = await screen.findByTestId("alert-a1");
    expect(screen.getByTestId("alert-data-source").textContent).toMatch(/simulated data, not a live feed/i);
    expect(card.textContent).not.toContain("Recommended:");
  });

  it("an alert from a live-feed scan says so and keeps its recommendation", async () => {
    serve([alert({ dataSource: "LIVE_FEED" })]);
    render(<AlertsCenter />);
    const card = await screen.findByTestId("alert-a1");
    expect(screen.getByTestId("alert-data-source").textContent).toMatch(/live feed/i);
    expect(card.textContent).toContain("Recommended:");
  });

  it("an alert without a recorded data source says it was not recorded", async () => {
    serve([alert({})]);
    render(<AlertsCenter />);
    await screen.findByTestId("alert-a1");
    expect(screen.getByTestId("alert-data-source").textContent).toMatch(/not recorded/i);
  });
});

describe("Alerts Center scan data source with age", () => {
  it("a superseded alert from a simulated scan shows both the feed and the age caveat", async () => {
    serve([alert({ dataSource: "SIMULATOR", createdAt: new Date(NOW - 3 * 3600_000).toISOString() })]);
    render(<AlertsCenter />);
    const card = await screen.findByTestId("alert-a1");
    expect(screen.getByTestId("alert-data-source").textContent).toMatch(/simulated/i);
    expect(screen.getByTestId("alert-superseded")).toBeTruthy();
    expect(card.textContent).not.toContain("Recommended:");
  });
});
