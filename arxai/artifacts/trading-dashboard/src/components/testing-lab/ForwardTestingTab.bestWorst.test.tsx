// Forward Testing: best / worst symbol and strategy are not named while no
// outcome was tracked (Tracked 0), even if a stale or older server names one.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return { ShieldAlert: Stub };
});
vi.mock("./ForwardChartPanel", () => ({ ForwardChartPanel: () => null }));

import { ForwardTestingTab } from "./ForwardTestingTab";

function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

const UNTRACKED_RESULTS = {
  totalShadowDecisions: 2, shadowTradesTracked: 0, wins: 0, losses: 0, winRate: 0,
  avgR: 0, maxDrawdownR: 0, confidenceCalibration: "NEEDS_MORE_DATA",
  bestSymbol: "EURUSD", worstSymbol: "XAUUSD", bestStrategy: "flame", weakestStrategy: "range",
};
const STATUS = {
  running: true, startedAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 3_600_000).toISOString(), observedSinceStart: 2, config: {},
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ForwardTestingTab best / worst labels", () => {
  it("does not name a best or worst symbol/strategy when nothing was tracked", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => jsonResponse(200, String(url).includes("/results") ? UNTRACKED_RESULTS : STATUS)));
    render(<ForwardTestingTab />);
    await screen.findByText("Best symbol");
    expect(screen.queryByText("EURUSD")).toBeNull();
    expect(screen.queryByText("XAUUSD")).toBeNull();
    expect(screen.queryByText("flame")).toBeNull();
    // Each ranking states it is unavailable (the merged wording shared with
    // win rate / avg R / drawdown), never a name.
    for (const label of ["Best symbol", "Worst symbol", "Best strategy", "Weakest strategy"]) {
      expect(screen.getByText(label).nextElementSibling?.textContent).toBe("Unavailable — no tracked trades");
    }
  });
});
