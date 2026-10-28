// Regression (Prop Firm Mode page):
//  - api() never checked r.ok: a 401/500 status body was read as data and
//    crashed the page on s.config.enabled; a failed save was silent;
//  - typing in a field and clearing it sent 0 (Number("") is 0), which the
//    server rejects, so nothing happened;
//  - "Reset" turned the mode on with the saved values and reset nothing;
//  - the rule card showed "✓ DAILY_DD ✓ TOTAL_DD" while the mode was OFF.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";

const { default: PropFirmMode } = await import("./prop-firm-mode");

function status(over: Record<string, unknown> = {}) {
  return {
    config: { enabled: true, startingBalance: 100_000, profitTarget: 8_000, maxDailyDrawdownUsd: 5_000, maxTotalDrawdownUsd: 10_000, minTradingDays: 5, maxLotSize: 1, maxPositions: 3, newsTradingAllowed: false, weekendHoldingAllowed: false, consistencyRulePctOfTotal: 40 },
    profitUsd: 1000, profitTargetProgress: 12.5, dailyDrawdownRemainingUsd: 5000, totalDrawdownRemainingUsd: 10000,
    passed: ["DAILY_DD", "TOTAL_DD"], failed: [], status: "ACTIVE", rulesEvaluated: true, notEvaluated: [], equityMeasured: true,
    ...over,
  };
}
type Call = { url: string; method: string; body: unknown };
function stubFetch(handler: (c: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const c = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return handler(c);
  }));
  return calls;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Prop Firm Mode — failed requests", () => {
  it("a failed first status read says it could not be loaded instead of crashing", async () => {
    stubFetch(() => json({ error: "unauthorized" }, 401));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByTestId("prop-firm-load-error").textContent).toMatch(/could not be loaded \(unauthorized \(HTTP 401\)\)/));
  });

  it("a failed poll after a good read marks the values as not current", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    stubFetch(() => (++n === 1 ? json(status()) : json({ error: "boom" }, 500)));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByText("Configure")).toBeTruthy());
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    await waitFor(() => expect(screen.getByTestId("prop-firm-stale").textContent).toMatch(/not current/));
  });

  it("a rejected save says it failed, with the server's reason", async () => {
    stubFetch((c) => (c.url.endsWith("/configure") ? json({ error: "invalid" }, 400) : json(status())));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByText("Save & enable")).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText("Save & enable")); });
    await waitFor(() => expect(screen.getByTestId("prop-firm-action-result").textContent).toMatch(/Save & enable failed: invalid \(HTTP 400\)/));
  });

  it("a field typed in and then cleared is not sent as 0", async () => {
    const calls = stubFetch(() => json(status()));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByText("Save & enable")).toBeTruthy());
    const input = screen.getByPlaceholderText(/Max lot size/);
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.change(input, { target: { value: "" } });
    await act(async () => { fireEvent.click(screen.getByText("Save & enable")); });
    const save = calls.find((c) => c.url.endsWith("/configure"));
    expect(save?.body).toEqual({ enabled: true });
  });
});

describe("Prop Firm Mode — labels", () => {
  it("the button that calls /prop-firm/reset says it turns the mode on with saved values, not 'Reset'", async () => {
    const calls = stubFetch(() => json(status({ status: "OFF", config: { ...status().config, enabled: false } })));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByText("Turn on with saved values")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByText("Turn on with saved values")); });
    expect(calls.some((c) => c.url.endsWith("/prop-firm/reset") && c.method === "POST")).toBe(true);
  });

  it("while the mode is OFF no rule shows a tick, even if an older server lists them as passed", async () => {
    stubFetch(() => json(status({ status: "OFF", rulesEvaluated: undefined, config: { ...status().config, enabled: false } })));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByTestId("prop-firm-rules").textContent).toMatch(/not checked while the mode is off/));
    expect(screen.getByTestId("prop-firm-rules").textContent).not.toMatch(/✓/);
  });

  it("rules the server could not check are shown as not checked, and unmeasured profit is not $0", async () => {
    stubFetch(() => json(status({ passed: ["DAILY_DD"], notEvaluated: ["PROFIT_TARGET", "TOTAL_DD"], equityMeasured: false, profitUsd: 0 })));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByTestId("prop-firm-rules").textContent).toMatch(/TOTAL_DD: not checked/));
    expect(screen.getAllByText("Not measured").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText("$0")).toBeNull();
  });
});

// Regression: the page said "Practise a prop-firm challenge on your paper
// account" under a PAPER badge, but saving writes the caps into
// user_risk_settings, which the Risk Governor applies to demo and live broker
// orders too, and they stay after the mode is turned off.
describe("Prop Firm Mode — scope of the saved limits", () => {
  it("says the saved limits apply to every venue, including live, and the PAPER badge covers progress only", async () => {
    stubFetch(() => json(status()));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByText("Configure")).toBeTruthy());
    const scope = screen.getByTestId("prop-firm-scope").textContent ?? "";
    expect(scope).toMatch(/every order you place on every venue, including demo and live/);
    expect(scope).toMatch(/keeps those limits/);
    expect(scope).not.toMatch(/on your paper account\. Saving/);
    expect(screen.queryByText("PAPER")).toBeNull();
    expect(screen.getByText("Progress: PAPER")).toBeTruthy();
    expect(screen.getByText("Limits: ALL VENUES")).toBeTruthy();
  });
});
