// Forward-test stats caption truth.
//
// /api/forward-testing/results only counts decisions inside the forward-test
// window (shadowMode.ts forwardWindowDecisions) and returns that window as
// testStartedAt / testEndedAt in the same payload. The caption used to take
// the start time only from /status, so when /status failed it read
// "All recorded shadow decisions (start time unavailable)" — a claim about
// every recorded decision, while the numbers are the window's, and the start
// time was right there in the results.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

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

const RESULTS_BASE = {
  totalShadowDecisions: 3, shadowTradesTracked: 1, wins: 1, losses: 0,
  breakevens: 0, expired: 0, rejected: 0, winRate: 100,
  avgR: 1.2, maxDrawdownR: 0, confidenceCalibration: "NEEDS_MORE_DATA",
  bestSymbol: "EURUSD", worstSymbol: null, bestStrategy: "Trend Continuation", weakestStrategy: null,
};
const STARTED = "2026-10-28T10:00:00.000Z";
const ENDED = "2026-10-28T11:00:00.000Z";

let statusResponse: () => Response;
let resultsBody: unknown;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/api/forward-testing/status")) return statusResponse();
      if (String(url).includes("/api/forward-testing/results")) return jsonResponse(200, resultsBody);
      return jsonResponse(404, {});
    }),
  );
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

describe("ForwardTestingTab — stats caption names the forward-test window", () => {
  it("status read fails → caption uses the results' own testStartedAt, never 'All recorded shadow decisions'", async () => {
    statusResponse = () => jsonResponse(500, { error: "boom" });
    resultsBody = { ...RESULTS_BASE, testStartedAt: STARTED, testEndedAt: null, running: true };
    render(<ForwardTestingTab />);
    await flush();
    const caption = screen.getByTestId("forward-stats-window");
    expect(caption.textContent).not.toMatch(/All recorded shadow decisions/);
    expect(caption.textContent).not.toMatch(/start time unavailable/);
    expect(caption.textContent).toContain(new Date(STARTED).toLocaleString());
  });

  it("an ended test's caption names both ends of the window", async () => {
    statusResponse = () => jsonResponse(500, { error: "boom" });
    resultsBody = { ...RESULTS_BASE, testStartedAt: STARTED, testEndedAt: ENDED, running: false };
    render(<ForwardTestingTab />);
    await flush();
    const caption = screen.getByTestId("forward-stats-window");
    expect(caption.textContent).toContain(new Date(STARTED).toLocaleString());
    expect(caption.textContent).toContain(new Date(ENDED).toLocaleString());
  });

  it("no window reported anywhere → it says the window was not reported, not that these are all decisions", async () => {
    statusResponse = () => jsonResponse(500, { error: "boom" });
    resultsBody = { ...RESULTS_BASE };
    render(<ForwardTestingTab />);
    await flush();
    const caption = screen.getByTestId("forward-stats-window");
    expect(caption.textContent).not.toMatch(/All recorded shadow decisions/);
    expect(caption.textContent).toMatch(/not reported/);
  });

  it("status ok, results without a window → falls back to the status start time", async () => {
    statusResponse = () =>
      jsonResponse(200, { running: true, startedAt: STARTED, endsAt: "2026-10-28T12:00:00.000Z", observedSinceStart: 3, config: null });
    resultsBody = { ...RESULTS_BASE };
    render(<ForwardTestingTab />);
    await flush();
    const caption = screen.getByTestId("forward-stats-window");
    expect(caption.textContent).toContain(new Date(STARTED).toLocaleString());
  });
});
