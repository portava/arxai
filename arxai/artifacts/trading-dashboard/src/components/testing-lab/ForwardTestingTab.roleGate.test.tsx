// ForwardTestingTab.roleGate.test.tsx — the Testing Lab is reachable by normal
// users for backtesting, but the Forward Testing tab is backed by admin/OWNER
// -only endpoints (/api/forward-testing/*). Before Task #802 a non-admin saw a
// grid of "undefined" stats. Now a 403/401 renders an explicit access-denied
// card; a 200 renders the real stats.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

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
  totalShadowDecisions: 3, shadowTradesTracked: 2, wins: 1, losses: 1, winRate: 50,
  avgR: 0.2, maxDrawdownR: 1, confidenceCalibration: "NEEDS_MORE_DATA",
  bestSymbol: "EURUSD", worstSymbol: "GBPUSD", bestStrategy: "flame", weakestStrategy: "range",
};
const STATUS = { running: false, startedAt: null, endsAt: null, observedSinceStart: 0, config: null };

let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ForwardTestingTab access handling", () => {
  it("403 → explicit access-denied card, never 'undefined' stats", async () => {
    fetchMock = vi.fn(async () => jsonResponse(403, { error: "Forbidden", requiredRole: "ADMIN" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ForwardTestingTab strategyId="flame" />);

    expect(await screen.findByText(/Access denied — Admin or Owner role required/i)).toBeTruthy();
    expect(screen.queryByText(/undefined/i)).toBeNull();
  });

  it("200 → renders real forward-test stats, no denial", async () => {
    fetchMock = vi.fn(async (url: string) =>
      jsonResponse(200, String(url).includes("/results") ? RESULTS : STATUS),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ForwardTestingTab strategyId="flame" />);

    expect(await screen.findByText("Win rate")).toBeTruthy();
    expect(screen.queryByText(/Access denied/i)).toBeNull();
  });
});
