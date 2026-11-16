// ForwardTestingTab.truth.test.tsx — the Forward Testing tab must say what it
// actually knows:
//   * a read that is still in flight or failed is "loading" / "could not be
//     loaded", never the confirmed-empty "No forward-test results yet.";
//   * a later failed poll removes the previous stats and status badge instead
//     of leaving them on screen as if they were current;
//   * the start card never claims the test is bound to the page strategy (the
//     server runs it unfiltered across every shadow strategy);
//   * with zero tracked trades, win rate / avg R / max drawdown / best and
//     worst symbol are "Unavailable", not a measured 0, and the calibration
//     token is shown in plain English.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return { ShieldAlert: Stub };
});

vi.mock("./ForwardChartPanel", () => ({
  ForwardChartPanel: () => null,
}));

import { ForwardTestingTab } from "./ForwardTestingTab";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

const RESULTS = {
  totalShadowDecisions: 37, shadowTradesTracked: 12, wins: 7, losses: 5,
  breakevens: 0, expired: 0, rejected: 0, winRate: 58.3,
  avgR: 0.41, maxDrawdownR: 2.25, confidenceCalibration: "WELL_CALIBRATED",
  bestSymbol: "EURUSD", worstSymbol: "GBPUSD", bestStrategy: "Trend Continuation", weakestStrategy: "Range Fade",
};
const EMPTY_TRACKED = {
  totalShadowDecisions: 4, shadowTradesTracked: 0, wins: 0, losses: 0,
  breakevens: 0, expired: 0, rejected: 0, winRate: 0,
  avgR: 0, maxDrawdownR: 0, confidenceCalibration: "NEEDS_MORE_DATA",
  bestSymbol: "EURUSD", worstSymbol: "USDJPY", bestStrategy: "Trend Continuation", weakestStrategy: "Range Fade",
};
const STATUS_RUNNING = { running: true, startedAt: "2026-10-28T10:00:00.000Z", endsAt: "2026-10-28T11:00:00.000Z", observedSinceStart: 37, config: null };

type Route = (url: string, init?: RequestInit) => Promise<Response>;
let route: Route;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  // STATUS_RUNNING's window is fixed (10:00–11:00 UTC); pin the clock inside
  // it so the RUNNING phase does not depend on the wall-clock time the suite
  // runs at (after 11:00 UTC on 2026-10-28 forwardPhase rightly says ENDED).
  vi.setSystemTime(new Date("2026-10-28T10:30:00.000Z"));
  fetchMock = vi.fn((url: string, init?: RequestInit) => route(String(url), init));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("ForwardTestingTab — results availability", () => {
  it("first read still in flight → 'loading', never the confirmed-empty message", async () => {
    route = () => new Promise<Response>(() => {});
    render(<ForwardTestingTab />);
    await flush();
    expect(screen.queryByText("No forward-test results yet.")).toBeNull();
    expect(screen.getByText(/Loading forward-test results/i)).toBeTruthy();
  });

  it("non-403 failure on the results read → 'could not be loaded', never 'No forward-test results yet.'", async () => {
    route = async (url) => (url.includes("/results") ? jsonResponse(500, { error: "boom" }) : jsonResponse(200, STATUS_RUNNING));
    render(<ForwardTestingTab />);
    await flush();
    expect(screen.queryByText("No forward-test results yet.")).toBeNull();
    expect(screen.getByText(/Forward-test results could not be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/Access denied/i)).toBeNull();
  });

  it("a later failed poll removes the previous stats and status badge", async () => {
    route = async (url) => jsonResponse(200, url.includes("/results") ? RESULTS : STATUS_RUNNING);
    render(<ForwardTestingTab />);
    await flush();
    expect(screen.getByText("37")).toBeTruthy();
    expect(screen.getByText("58.3%")).toBeTruthy();
    expect(screen.getByText("RUNNING")).toBeTruthy();

    route = async () => jsonResponse(500, { error: "boom" });
    await flush(3000);
    expect(screen.queryByText("37")).toBeNull();
    expect(screen.queryByText("58.3%")).toBeNull();
    expect(screen.queryByText("RUNNING")).toBeNull();
    expect(screen.getByText(/Forward-test results could not be loaded/i)).toBeTruthy();
    expect(screen.getByText(/Status unavailable/i)).toBeTruthy();
  });

  it("a network error (fetch rejects) is shown as unavailable, not left as the last stats", async () => {
    route = async (url) => jsonResponse(200, url.includes("/results") ? RESULTS : STATUS_RUNNING);
    render(<ForwardTestingTab />);
    await flush();
    expect(screen.getByText("58.3%")).toBeTruthy();
    route = async () => { throw new TypeError("Failed to fetch"); };
    await flush(3000);
    expect(screen.queryByText("58.3%")).toBeNull();
    expect(screen.getByText(/Forward-test results could not be loaded/i)).toBeTruthy();
  });

  it("a confirmed zero-decision payload still reads 'No forward-test results yet.'", async () => {
    route = async (url) => jsonResponse(200, url.includes("/results")
      ? { ...EMPTY_TRACKED, totalShadowDecisions: 0 }
      : { ...STATUS_RUNNING, running: false });
    render(<ForwardTestingTab />);
    await flush();
    expect(screen.getByText("No forward-test results yet.")).toBeTruthy();
  });
});

describe("ForwardTestingTab — strategy scope copy", () => {
  it("never claims a strategy-bound test when the start request carries no strategy", async () => {
    route = async (url) => jsonResponse(200, url.includes("/results") ? RESULTS : { ...STATUS_RUNNING, running: false });
    render(<ForwardTestingTab strategyId="meanReversion" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Start/ }));
    await flush();
    const startCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/forward-testing/start"));
    expect(startCall).toBeTruthy();
    const body = JSON.parse(String((startCall![1] as RequestInit).body));
    expect(body).not.toHaveProperty("strategy");
    expect(screen.queryByText(/selected strategy: meanReversion/)).toBeNull();
    expect(screen.getByText(/every shadow strategy/i)).toBeTruthy();
    expect(screen.getByText(/meanReversion.*is not applied/i)).toBeTruthy();
  });
});

describe("ForwardTestingTab — unmeasured stats", () => {
  it("zero tracked trades → win rate, avg R, max DD and best/worst symbol are Unavailable; calibration is plain English", async () => {
    route = async (url) => jsonResponse(200, url.includes("/results") ? EMPTY_TRACKED : { ...STATUS_RUNNING, running: false });
    render(<ForwardTestingTab />);
    await flush();
    expect(screen.getByText("Decisions")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.queryByText("NEEDS_MORE_DATA")).toBeNull();
    expect(screen.queryByText("EURUSD")).toBeNull();
    expect(screen.queryByText("USDJPY")).toBeNull();
    expect(screen.getAllByText(/Unavailable/).length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText(/Not enough data/i)).toBeTruthy();
  });

  it("tracked trades → measured values and a humanised calibration label", async () => {
    route = async (url) => jsonResponse(200, url.includes("/results") ? RESULTS : STATUS_RUNNING);
    render(<ForwardTestingTab />);
    await flush();
    expect(screen.getByText("58.3%")).toBeTruthy();
    expect(screen.getByText("0.41")).toBeTruthy();
    expect(screen.getByText("2.25")).toBeTruthy();
    expect(screen.getByText("EURUSD")).toBeTruthy();
    expect(screen.queryByText("WELL_CALIBRATED")).toBeNull();
    expect(screen.getByText("Well calibrated")).toBeTruthy();
  });
});
