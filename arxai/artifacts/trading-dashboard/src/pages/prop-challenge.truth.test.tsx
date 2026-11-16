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
  PropChallengeProgressCard: ({ summary }: { summary: { status: string; final?: boolean } }) =>
    <div data-testid="progress">{summary.status} final={String(summary.final)}</div>,
  PropProfitTargetMeter: () => null, PropDrawdownMeter: () => null,
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

// Regression: after a Cancel (or an evaluate poll that resolved the challenge
// to PASSED/FAILED) the list showed the challenge as finished and polling
// stopped, but the ["prop-eval", id] key did not change, so the last ACTIVE
// evaluation (final: false, with open-position rules) stayed on screen under
// the note that the results cover only trades closed up to the end.
describe("Prop Challenge page — the final evaluation after a challenge ends", () => {
  function stubLifecycle(firstEvalStatus: "ACTIVE" | "PASSED") {
    const row = challenge({ status: "ACTIVE" });
    const evaluateCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/prop-challenges" && method === "GET") {
        return new Response(JSON.stringify({ challenges: [row] }), { status: 200 });
      }
      if (url === `/api/prop-challenges/${row.id}` && method === "PATCH") {
        const { status } = JSON.parse(String(init!.body)) as { status: string };
        Object.assign(row, { status, completedAt: status === "CANCELED" ? "2026-09-10T00:00:00Z" : null });
        return new Response(JSON.stringify({ challenge: row }), { status: 200 });
      }
      if (url.endsWith("/evaluate")) {
        evaluateCalls.push(url);
        const finished = row.status !== "ACTIVE" && row.status !== "PAUSED";
        const body = evalBody(finished);
        if (!finished && firstEvalStatus === "PASSED") {
          // The server resolves the challenge during this evaluation.
          Object.assign(row, { status: "PASSED", completedAt: "2026-09-21T00:00:00Z" });
          body.summary.status = "PASSED";
        } else {
          body.summary.status = row.status;
        }
        body.violations = finished ? [] : [{ type: "MAX_OPEN_TRADES", severity: "HARD", message: "2 open" }] as never;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }));
    return evaluateCalls;
  }

  it("after Cancel the final evaluation is loaded and the ACTIVE one is not shown under the finished note", async () => {
    const calls = stubLifecycle("ACTIVE");
    renderPage();
    await waitFor(() => expect(screen.getByTestId("progress").textContent).toBe("ACTIVE final=false"));
    await act(async () => { screen.getByText("Cancel").click(); });
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toBe("CANCELED"));
    await waitFor(() => expect(screen.getByTestId("progress").textContent).toBe("CANCELED final=true"));
    expect(calls.length).toBe(2);
    expect(screen.getByTestId("prop-finished-note").textContent).toMatch(/cover only trades closed up to that time/);
  });

  it("an evaluate poll that resolves the challenge is followed by one final evaluation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = stubLifecycle("PASSED");
    renderPage();
    await waitFor(() => expect(calls.length).toBe(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(8_500); });
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toBe("PASSED"));
    await waitFor(() => expect(screen.getByTestId("progress").textContent).toBe("PASSED final=true"));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(calls.length).toBe(2);
  });

  it("the finished note does not say 'results below' over a non-final evaluation", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const row = challenge({ status: "ACTIVE" });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/prop-challenges" && method === "GET") return new Response(JSON.stringify({ challenges: [row] }), { status: 200 });
      if (method === "PATCH") { Object.assign(row, { status: "CANCELED", completedAt: "2026-09-10T00:00:00Z" }); return new Response("{}", { status: 200 }); }
      if (url.endsWith("/evaluate")) {
        if (row.status === "ACTIVE") return new Response(JSON.stringify(evalBody(false)), { status: 200 });
        await new Promise<void>((r) => { gate.release = r; });
        return new Response(JSON.stringify(evalBody(true)), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("progress")).toBeTruthy());
    await act(async () => { screen.getByText("Cancel").click(); });
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toBe("CANCELED"));
    await waitFor(() => expect(gate.release).not.toBeNull());
    expect(screen.queryByTestId("progress")).toBeNull();
    expect(screen.getByTestId("prop-finished-note").textContent).not.toMatch(/results below/);
    expect(screen.getByTestId("prop-final-result-state").textContent).toMatch(/Loading the final result/);
    await act(async () => { gate.release!(); });
    await waitFor(() => expect(screen.getByTestId("progress").textContent).toMatch(/final=true/));
  });
});

// Regression: the list queryFn never checked r.ok, so a 401/500 body was read
// as data with no challenges and the page offered "Start a practice
// challenge" as if none existed; a network failure left the page blank; and a
// finished challenge whose one evaluation failed showed the "results below"
// note over nothing.
describe("Prop Challenge page — failed reads", () => {
  it("a failed challenge-list read says the challenges could not be loaded, not the start form", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("prop-list-error").textContent).toMatch(/could not be loaded/));
    expect(screen.getByTestId("prop-list-error").textContent).toMatch(/Unauthorized \(HTTP 401\)/);
    expect(screen.queryByText("Start a practice challenge")).toBeNull();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("a network failure on the list read says it could not be loaded instead of a blank page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("prop-list-error").textContent).toMatch(/could not be loaded/));
    expect(screen.queryByText("Start a practice challenge")).toBeNull();
  });

  it("a finished challenge whose evaluation fails says the final result could not be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/prop-challenges") {
        return new Response(JSON.stringify({ challenges: [challenge({ status: "CANCELED", completedAt: "2026-09-10T00:00:00Z" })] }), { status: 200 });
      }
      if (url.endsWith("/evaluate")) return new Response(JSON.stringify({ error: "Failed to evaluate" }), { status: 500 });
      return new Response("{}", { status: 404 });
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("prop-eval-error").textContent).toMatch(/final result of this challenge could not be loaded/));
    expect(screen.getByTestId("prop-eval-error").textContent).toMatch(/Failed to evaluate \(HTTP 500\)/);
    expect(screen.getByTestId("prop-finished-note").textContent).not.toMatch(/results below/);
    expect(screen.queryByTestId("prop-final-result-state")).toBeNull();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("a failed list refresh after a good read keeps the current challenge and says the list was not refreshed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let listCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/prop-challenges") {
        listCalls += 1;
        return listCalls === 1
          ? new Response(JSON.stringify({ challenges: [challenge({ status: "ACTIVE" })] }), { status: 200 })
          : new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      if (url.endsWith("/evaluate")) return new Response(JSON.stringify(evalBody(false)), { status: 200 });
      return new Response("{}", { status: 404 });
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toBe("ACTIVE"));
    await act(async () => { await vi.advanceTimersByTimeAsync(8_500); });
    await waitFor(() => expect(screen.getByTestId("prop-list-stale").textContent).toMatch(/could not be refreshed/));
    expect(screen.getByTestId("banner").textContent).toBe("ACTIVE");
    expect(screen.queryByText("Start a practice challenge")).toBeNull();
  });
});
