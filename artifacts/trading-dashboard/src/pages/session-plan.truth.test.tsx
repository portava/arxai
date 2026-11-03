// AI Session Plan truth. A non-admin viewer gets the plan masked
// (maskSimulatorSessionPlan: zeros, empty lists, withheld:true); those are
// withheld values, not zero limits or "none". A failed request is "could
// not be loaded", never a crash. The footer names the scanner sweep the
// plan came from and how old it is.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import SessionPlanPage from "./session-plan";

const PLAN = {
  bestSymbols: ["EURUSD"], symbolsToAvoid: ["GBPJPY"], preferredStrategy: "Trend Continuation",
  maxTrades: 3, maxRiskPerTradeUsd: 20, maxRiskPerSessionUsd: 60,
  marketConditions: "Trending across most pairs.",
  rules: ["Reject any setup with confidence < 60."], warningZones: [], focusAreas: ["Patience"],
  recommendedFirstTest: "Run a paper trade on EURUSD via Trade Command Room.",
  summary: "Today's simulator session favors trend continuation on EURUSD.",
  dataSource: "SIMULATOR", generatedAt: new Date().toISOString(),
};

// The exact shape maskSimulatorSessionPlan returns for a non-admin viewer.
const MASKED = {
  ...PLAN,
  bestSymbols: [], symbolsToAvoid: [],
  preferredStrategy: "Withheld until a verified feed is available",
  maxTrades: 0, maxRiskPerTradeUsd: 0, maxRiskPerSessionUsd: 0,
  marketConditions: "Waiting for a verified feed", rules: [], warningZones: [], focusAreas: [],
  recommendedFirstTest: "Waiting for a verified feed", summary: "Waiting for a verified feed",
  withheld: true,
};

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Session Plan truth", () => {
  it("withheld values are not shown as $0, 0 trades or 'none'", async () => {
    mockFetch(200, MASKED);
    render(<SessionPlanPage />);
    await screen.findByTestId("session-plan-withheld");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\$0\b/);
    expect(text).not.toMatch(/Max trades\s*0/);
    expect(screen.queryAllByText("none")).toHaveLength(0);
    expect(screen.getAllByText("Withheld").length).toBeGreaterThanOrEqual(5);
  });

  it("a failed request says the plan could not be loaded instead of crashing", async () => {
    mockFetch(500, { error: "x" });
    render(<SessionPlanPage />);
    const err = await screen.findByTestId("session-plan-error");
    expect(err.textContent).toMatch(/could not be loaded/i);
    expect(screen.queryByText("Today's plan")).toBeNull();
  });

  it("an {error} body with 200 is also not rendered as a plan", async () => {
    mockFetch(200, { error: "x" });
    render(<SessionPlanPage />);
    expect((await screen.findByTestId("session-plan-error")).textContent).toMatch(/could not be loaded/i);
  });

  it("the footer names the sweep's own time and age, not 'Generated <now>'", async () => {
    mockFetch(200, { ...PLAN, generatedAt: new Date(Date.now() - (3 * 60 + 5) * 60_000).toISOString() });
    render(<SessionPlanPage />);
    const footer = await screen.findByTestId("session-plan-sweep-time");
    expect(footer.textContent).toMatch(/scanner sweep at .+ \(3 h 5 min ago\)/);
    expect(footer.textContent).not.toMatch(/^Generated /);
  });

  it("the plan's caps and rules are labelled as fixed plan text, not the trader's risk settings", async () => {
    mockFetch(200, PLAN);
    render(<SessionPlanPage />);
    await waitFor(() => expect(screen.getByTestId("session-plan-limits-scope")).toBeTruthy());
    expect(screen.getByTestId("session-plan-limits-scope").textContent).toMatch(/not read from your risk settings/);
    expect(screen.getByText(/Fixed plan text, not your risk settings/)).toBeTruthy();
  });
});
