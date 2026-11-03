// Prop Challenge page: the evaluator now checks the pass and fail rules with
// each closed trade at the lower of its booked P&L and the paper risk model,
// never passes while a close could not be sized, and says so in the summary
// (passBlockedReason, unsizedClosesNote, ruleBasisNote). The page showed only
// the booked meters, so an ACTIVE challenge whose booked profit was over the
// target read as if it should have passed, with no word why. It now shows the
// three notes when the server sends them.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/propChallenges", () => ({
  PropChallengeProgressCard: ({ summary }: { summary: { status: string } }) => <div data-testid="progress">{summary.status}</div>,
  PropProfitTargetMeter: () => null, PropDrawdownMeter: () => null,
  PropDailyLossLimitCard: () => null, PropRuleViolationFeed: () => null, PropChallengeCalendar: () => null,
  PropExtendedRulesPanel: () => null,
  PropPassFailBanner: ({ status }: { status: string }) => <div data-testid="banner">{status}</div>,
}));

const { default: PropChallengePage } = await import("./prop-challenge");

const challenge = {
  id: 9, challengeName: "Practice Challenge", paperAccountId: 1, startingBalance: 10_000, profitTarget: 0.1,
  maxDailyLoss: 0.05, maxTotalDrawdown: 0.1, minTradingDays: 1, maxTradingDays: 30, consistencyRulePercent: 1,
  status: "ACTIVE", failureReason: null, startedAt: "2026-10-25T00:00:00Z", completedAt: null,
};
const passBlockedReason = "Not passed: 1 closed trade's P&L could not be sized, so the result is not known.";
const unsizedClosesNote = "1 closed paper trade (NAS100) could not be sized for the instrument (no contract size or currency conversion), so its P&L is not known and is left out of the balance, profit, daily loss and drawdown shown here.";
const ruleBasisNote = "The pass and fail rules are checked with each closed trade counted at the lower of its booked P&L and the paper risk model (price move × lots × 100): profit 0.01% (booked 11.00%), drawdown 0.00% (booked 0.00%), worst day 0.00% (booked 0.00%).";
const summary = {
  status: "ACTIVE", failureReason: null, totalPnl: 1100, totalPct: 0.11, peakBalance: 11_100, maxDrawdownPct: 0,
  worstDayPct: 0, worstDayDate: null, bestDayPnl: 1100, daysWorked: 1, daysSinceStart: 9, consistencyTopShare: 1,
  tradeCount: 2, profitTarget: 0.1, maxDailyLoss: 0.05, maxTotalDrawdown: 0.1, minTradingDays: 1, maxTradingDays: 30,
  currentBalance: 11_100, final: false, evaluatedThrough: "2026-11-03T00:00:00Z",
};

function stubFetch(s: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/prop-challenges" && (!init || !init.method || init.method === "GET")) {
      return new Response(JSON.stringify({ challenges: [challenge] }), { status: 200 });
    }
    if (url.endsWith("/evaluate")) return new Response(JSON.stringify({ summary: s, days: [], violations: [] }), { status: 200 });
    return new Response("{}", { status: 404 });
  }));
}
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PropChallengePage /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Prop Challenge page — what the pass and fail rules were checked on", () => {
  it("shows why a challenge over its booked target is not passed, the unsized closes and the rule basis", async () => {
    stubFetch({ ...summary, passBlockedReason, unsizedCloses: 1, unsizedClosesNote, ruleBasisNote });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("progress").textContent).toBe("ACTIVE"));
    expect(screen.getByTestId("prop-pass-blocked-reason").textContent).toBe(passBlockedReason);
    expect(screen.getByTestId("prop-unsized-closes-note").textContent).toBe(unsizedClosesNote);
    expect(screen.getByTestId("prop-rule-basis-note").textContent).toBe(ruleBasisNote);
  });

  it("shows none of them when the server sends none (figures agree, or an older server)", async () => {
    stubFetch({ ...summary, passBlockedReason: null, unsizedCloses: 0, unsizedClosesNote: null, ruleBasisNote: null });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("progress").textContent).toBe("ACTIVE"));
    expect(screen.queryByTestId("prop-pass-blocked-reason")).toBeNull();
    expect(screen.queryByTestId("prop-unsized-closes-note")).toBeNull();
    expect(screen.queryByTestId("prop-rule-basis-note")).toBeNull();
  });
});
