// Forward Testing truth: the phase badge and the end-time line must describe
// what actually happened.
//  - A "running" test whose endsAt has passed is shown as ended (client may
//    only downgrade), never RUNNING with an "ends at" time in the past.
//  - A cleared duration never offers "Start (0 min)".

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return { ShieldAlert: Stub };
});
vi.mock("./ForwardChartPanel", () => ({ ForwardChartPanel: () => null }));

import { ForwardTestingTab, forwardPhase } from "./ForwardTestingTab";

function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

const RESULTS = {
  totalShadowDecisions: 0, shadowTradesTracked: 0, wins: 0, losses: 0, winRate: 0,
  avgR: 0, maxDrawdownR: 0, confidenceCalibration: "NEEDS_MORE_DATA",
  bestSymbol: null, worstSymbol: null, bestStrategy: null, weakestStrategy: null,
};

function stub(status: unknown, results: unknown = RESULTS) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => jsonResponse(200, String(url).includes("/results") ? results : status)));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ForwardTestingTab phase and end time", () => {
  it("a 'running' test whose endsAt has passed is shown as ENDED, not RUNNING", async () => {
    const past = new Date(Date.now() - 10 * 60_000).toISOString();
    stub({ running: true, startedAt: past, endsAt: past, observedSinceStart: 4, config: {} });
    render(<ForwardTestingTab />);
    const badge = await screen.findByTestId("forward-phase");
    expect(badge.textContent).toBe("ENDED");
    expect(screen.queryByText(/ends at/i)).toBeNull();
    expect(screen.getByTestId("forward-ended").textContent).toMatch(/ended at .* \(duration elapsed\)/);
  });

  it("a stopped test reads STOPPED with its end time", async () => {
    const t = new Date(Date.now() - 60_000).toISOString();
    stub({ running: false, startedAt: t, endsAt: new Date(Date.now() + 3_600_000).toISOString(), endedAt: t, endReason: "stopped", observedSinceStart: 2, config: null });
    render(<ForwardTestingTab />);
    expect((await screen.findByTestId("forward-phase")).textContent).toBe("STOPPED");
    expect(screen.getByTestId("forward-ended").textContent).toMatch(/\(stopped\)/);
  });

  it("forwardPhase keeps a live test RUNNING", () => {
    expect(forwardPhase({ running: true, startedAt: null, endsAt: new Date(Date.now() + 60_000).toISOString(), observedSinceStart: 0, config: null })).toBe("RUNNING");
    expect(forwardPhase({ running: false, startedAt: null, endsAt: null, observedSinceStart: 0, config: null })).toBe("IDLE");
  });

  it("a cleared duration never offers 'Start (0 min)'", async () => {
    stub({ running: false, startedAt: null, endsAt: null, observedSinceStart: 0, config: null });
    render(<ForwardTestingTab />);
    await screen.findByTestId("forward-phase");
    const input = screen.getByPlaceholderText("duration min");
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByText(/Start \(0 min\)/)).toBeNull();
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });
});

describe("ForwardTestingTab results scope", () => {
  it("says no forward test has been started when none has", async () => {
    stub({ running: false, startedAt: null, endsAt: null, observedSinceStart: 0, config: null });
    render(<ForwardTestingTab />);
    expect(await screen.findByText(/No forward test has been started yet/i)).toBeTruthy();
  });
});
