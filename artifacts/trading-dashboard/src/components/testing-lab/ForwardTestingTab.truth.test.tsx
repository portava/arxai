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
});
