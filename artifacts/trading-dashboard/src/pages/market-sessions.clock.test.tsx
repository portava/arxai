import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// GET /api/market/session-clock derives sessions from the server's wall clock
// (marketDataLayer.sessionClock) — nothing about it is simulated, yet the page
// printed a literal "SIMULATOR" badge. The same derivation ignores the
// weekday, so on Saturday it still reports London/NewYork OPEN with a
// "heightened volatility" recommendation while FX markets are shut.

const { default: MarketSessionsPage } = await import("./market-sessions");

function clockAt(nowUTC: string, hourActive: string[]) {
  return {
    nowUTC,
    activeSessions: hourActive,
    overlap: hourActive.length >= 2,
    sessionLabel: hourActive.length >= 2 ? "HIGH_VOLATILITY" : "NORMAL",
    recommendation: "Be cautious — heightened volatility around London/NY overlap. Tighten stops.",
    sessions: ["Sydney", "Tokyo", "London", "NewYork"].map((id) => ({
      id, isActive: hourActive.includes(id), nextOpenInHours: 3, nextCloseInHours: 2,
    })),
    dataSource: "SIMULATOR",
  };
}

function stub(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Market Sessions — labels describe the real clock", () => {
  it("never labels the wall-clock session schedule 'SIMULATOR'", async () => {
    // Wednesday 14:00 UTC — London + New York overlap.
    stub(clockAt("2026-10-28T14:00:00.000Z", ["London", "NewYork"]));
    render(<MarketSessionsPage />);
    expect(await screen.findByText("Active right now")).toBeTruthy();
    expect(screen.queryByText("SIMULATOR")).toBeNull();
    expect(screen.getAllByText("OPEN").length).toBe(2);
  });

  it("on Saturday shows the FX market closed, never sessions OPEN", async () => {
    // Saturday 14:00 UTC — the hour-only server derivation says London/NY open.
    stub(clockAt("2026-10-31T14:00:00.000Z", ["London", "NewYork"]));
    render(<MarketSessionsPage />);
    expect((await screen.findAllByText(/closed for the weekend/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText("OPEN")).toBeNull();
    expect(screen.queryByText("OVERLAP")).toBeNull();
    expect(screen.queryByText("HIGH_VOLATILITY")).toBeNull();
    expect(screen.queryByText(/heightened volatility/)).toBeNull();
  });

  it("a failed clock read says so instead of loading forever", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "x" }) })));
    render(<MarketSessionsPage />);
    expect(await screen.findByText(/Could not load the session clock/)).toBeTruthy();
  });
});
