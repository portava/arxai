// Regression: the page fell back to the latest challenge when none was ACTIVE
// or PAUSED and POSTed /evaluate for it every 8 s, so a PASSED, FAILED or
// CANCELED challenge kept changing with paper trades made after it ended,
// and the "Start a practice challenge" form never came back after a cancel.
// A finished challenge is now shown as the last result (evaluated once, not
// polled, no Re-evaluate), with a line saying it covers trades up to its end,
// and the start form is offered again.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/propChallenges", () => ({
  PropChallengeProgressCard: () => null, PropProfitTargetMeter: () => null, PropDrawdownMeter: () => null,
  PropDailyLossLimitCard: () => null, PropRuleViolationFeed: () => null, PropChallengeCalendar: () => null,
  PropExtendedRulesPanel: () => null,
  PropPassFailBanner: ({ status }: { status: string }) => <div data-testid="banner">{status}</div>,
}));

const { default: PropChallengePage } = await import("./prop-challenge");

function challenge(over: Record<string, unknown>) {
  return {
    id: 9, challengeName: "Practice Challenge", paperAccountId: 1, startingBalance: 10_000, profitTarget: 0.1,
    maxDailyLoss: 0.05, maxTotalDrawdown: 0.1, minTradingDays: 5, maxTradingDays: 30, consistencyRulePercent: 0.4,
    status: "ACTIVE", failureReason: null, startedAt: "2026-09-01T00:00:00Z", completedAt: null, ...over,
  };
}
const evalBody = (final: boolean) => ({
  summary: {
    status: "PASSED", failureReason: null, totalPnl: 1100, totalPct: 0.11, peakBalance: 11_100, maxDrawdownPct: 0,
    worstDayPct: 0, worstDayDate: null, bestDayPnl: 1100, daysWorked: 5, daysSinceStart: 20, consistencyTopShare: 0.3,
    tradeCount: 5, profitTarget: 0.1, maxDailyLoss: 0.05, maxTotalDrawdown: 0.1, minTradingDays: 5, maxTradingDays: 30,
    currentBalance: 11_100, final, evaluatedThrough: "2026-09-21T00:00:00Z",
  },
  days: [], violations: [],
});

function stubFetch(list: unknown[]) {
  const evaluateCalls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/prop-challenges" && (!init || !init.method || init.method === "GET")) {
      return new Response(JSON.stringify({ challenges: list }), { status: 200 });
    }
    if (url.endsWith("/evaluate")) {
      evaluateCalls.push(url);
      const ch = list[0] as { status: string };
      return new Response(JSON.stringify(evalBody(ch.status !== "ACTIVE" && ch.status !== "PAUSED")), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }));
  return evaluateCalls;
}
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PropChallengePage /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Prop Challenge page — finished challenges", () => {
  it("a PASSED challenge is shown as the last result, evaluated once, not polled, and the start form returns", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = stubFetch([challenge({ status: "PASSED", completedAt: "2026-09-21T00:00:00Z" })]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toBe("PASSED"));
    await waitFor(() => expect(calls.length).toBe(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(calls.length).toBe(1);
    expect(screen.getByText("Start a practice challenge")).toBeTruthy();
    expect(screen.getByTestId("prop-finished-note").textContent).toMatch(/covers? only trades closed up to that time/);
    expect(screen.queryByText("Re-evaluate")).toBeNull();
  });

  it("after a cancel the start form is offered again", async () => {
    stubFetch([challenge({ status: "CANCELED", completedAt: "2026-09-10T00:00:00Z" })]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toBe("CANCELED"));
    expect(screen.getByText("Start a practice challenge")).toBeTruthy();
  });

  it("an ACTIVE challenge hides the start form and keeps polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = stubFetch([challenge({ status: "ACTIVE" })]);
    renderPage();
    await waitFor(() => expect(calls.length).toBe(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(8_500); });
    await waitFor(() => expect(calls.length).toBeGreaterThan(1));
    expect(screen.queryByText("Start a practice challenge")).toBeNull();
    expect(screen.queryByTestId("prop-finished-note")).toBeNull();
    expect(screen.getByText("Re-evaluate")).toBeTruthy();
  });
});

// Regression: both prop pages were titled "Prop Firm Challenge Mode".
describe("Prop Challenge page — not confused with Prop Firm Risk Mode", () => {
  it("has its own title and says it is separate from Prop Firm Risk Mode", async () => {
    stubFetch([challenge({ status: "ACTIVE" })]);
    renderPage();
    expect(screen.queryByText("Prop Firm Challenge Mode")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Prop Challenge Practice");
    expect(screen.getByTestId("prop-challenge-separate").textContent).toMatch(/separate from Prop Firm Risk Mode/);
  });
});
