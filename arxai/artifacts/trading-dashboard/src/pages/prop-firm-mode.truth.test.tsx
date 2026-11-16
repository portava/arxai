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
    // The server now restarts the challenge on /prop-firm/reset (fix-2); the button says so.
    expect(screen.getByText("Turn on with saved values").getAttribute("title")).toMatch(/restarts the challenge/);
    await act(async () => { fireEvent.click(screen.getByText("Turn on with saved values")); });
    expect(calls.some((c) => c.url.endsWith("/prop-firm/reset") && c.method === "POST")).toBe(true);
  });

  // Regression: the title said "It does not reset any value", but
  // /prop-firm/reset calls configurePropFirm({ enabled: true }), which writes
  // the prop daily loss, drawdown, lot and position caps over the trader's
  // current risk limits, replacing any they tightened since.
  it("the 'Turn on with saved values' title says it writes the prop caps over the current risk limits", async () => {
    stubFetch(() => json(status({ status: "OFF", config: { ...status().config, enabled: false } })));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByText("Turn on with saved values")).toBeTruthy());
    const title = screen.getByText("Turn on with saved values").getAttribute("title") ?? "";
    expect(title).not.toMatch(/does not reset any value/);
    expect(title).toMatch(/writes their daily loss, total drawdown, lot size and open-position caps over your current risk limits/);
    expect(title).toMatch(/even a stricter one/);
  });

  it("while the mode is OFF no rule shows a tick, even if an older server lists them as passed", async () => {
    stubFetch(() => json(status({ status: "OFF", rulesEvaluated: undefined, config: { ...status().config, enabled: false } })));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByTestId("prop-firm-rules").textContent).toMatch(/not checked while the mode is off/));
    expect(screen.getByTestId("prop-firm-rules").textContent).not.toMatch(/✓/);
  });

  // With no paper account the day's drawdown is a placeholder too: an older
  // server still listed DAILY_DD as passed and sent "Daily DD left $5000".
  it("rules the server could not check are shown as not checked, and unmeasured profit is not $0", async () => {
    stubFetch(() => json(status({ passed: ["DAILY_DD"], notEvaluated: ["PROFIT_TARGET", "TOTAL_DD"], equityMeasured: false, profitUsd: 0 })));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByTestId("prop-firm-rules").textContent).toMatch(/TOTAL_DD: not checked/));
    const rules = screen.getByTestId("prop-firm-rules").textContent ?? "";
    expect(rules).not.toMatch(/✓/);
    expect(rules).toMatch(/DAILY_DD: not checked/);
    expect(screen.getAllByText("Not measured").length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText("$0")).toBeNull();
    expect(screen.queryByText("$5000")).toBeNull();
  });

  it("with no active paper account every rule says why it was not checked, and the status is not a measured verdict", async () => {
    const why = "there is no active paper account";
    stubFetch(() => json(status({
      passed: [], notEvaluated: ["PROFIT_TARGET", "DAILY_DD", "TOTAL_DD"],
      notEvaluatedReasons: { PROFIT_TARGET: why, DAILY_DD: why, TOTAL_DD: why },
      equityMeasured: false, dailyDrawdownMeasured: false, profitUsd: 0, profitTargetProgress: 0, status: "ACTIVE",
    })));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByTestId("prop-firm-rules").textContent).toMatch(/DAILY_DD: not checked/));
    const rules = screen.getByTestId("prop-firm-rules").textContent ?? "";
    expect(rules).toContain(`TOTAL_DD: not checked (${why})`);
    expect(rules).not.toMatch(/could not be read/);
    expect(screen.getAllByText("NOT MEASURED").length).toBeGreaterThanOrEqual(1);
  });

  it("an older server's PASSED from a placeholder profit is not shown as PASSED", async () => {
    stubFetch(() => json(status({ passed: [], notEvaluated: ["PROFIT_TARGET", "TOTAL_DD"], equityMeasured: false, profitUsd: 0, status: "PASSED",
      config: { ...status().config, profitTarget: 0 } })));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByTestId("prop-firm-rules").textContent).toMatch(/not checked/));
    expect(screen.queryByText("PASSED")).toBeNull();
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

// Regression: the header said the Risk Governor applies the saved daily loss
// cap to every order on every venue, but resolveEffectiveLimits uses the
// trader's maxDailyLossAmount only while blockAfterDailyLossHit is on. With
// "Block after daily loss" off the cap is saved and enforced nowhere.
describe("Prop Firm Mode — the daily loss cap depends on Block after daily loss", () => {
  const withSettings = (settings: Response | (() => Response)) => (c: Call) =>
    c.url === "/api/me/risk-settings" ? (typeof settings === "function" ? settings() : settings) : json(status());

  it("the header says the daily loss cap applies only while Block after daily loss is on", async () => {
    stubFetch(withSettings(json({ blockAfterDailyLossHit: true })));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByText("Configure")).toBeTruthy());
    const scope = screen.getByTestId("prop-firm-scope").textContent ?? "";
    expect(scope).toMatch(/daily loss cap the same way only while "Block after daily loss" is on/);
    expect(scope).not.toMatch(/applies those limits to every order/);
  });

  it("with Block after daily loss off, the page says the daily loss cap is not enforced", async () => {
    stubFetch(withSettings(json({ blockAfterDailyLossHit: false })));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByTestId("prop-firm-daily-loss-enforcement").textContent).toMatch(/is off/));
    const line = screen.getByTestId("prop-firm-daily-loss-enforcement").textContent ?? "";
    expect(line).toMatch(/daily loss cap is not enforced on any order/);
    expect(line).toMatch(/total drawdown, lot size and open-position caps still apply/);
  });

  it("with Block after daily loss on and the prop cap stored, the page says the daily loss cap is enforced", async () => {
    stubFetch(withSettings(json({ blockAfterDailyLossHit: true, maxDailyLossAmount: 5000 })));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByTestId("prop-firm-daily-loss-enforcement").textContent).toMatch(/is enforced as well/));
    const line = screen.getByTestId("prop-firm-daily-loss-enforcement").textContent ?? "";
    expect(line).toMatch(/is on/);
    expect(line).toMatch(/\$5000/);
    expect(line).not.toMatch(/not enforced/);
  });

  it("a failed settings read says whether the cap is enforced could not be checked", async () => {
    stubFetch(withSettings(() => json({ error: "boom" }, 500)));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByTestId("prop-firm-daily-loss-enforcement").textContent).toMatch(/could not be checked \(boom \(HTTP 500\)\)/));
    expect(screen.getByTestId("prop-firm-daily-loss-enforcement").textContent).toMatch(/not known whether the daily loss cap is enforced/);
  });
});

// Round 3 review: "the daily loss cap is enforced as well" was shown whenever
// blockAfterDailyLossHit was true, without checking which daily loss amount
// is stored. The prop cap is only in force while user_risk_settings holds it:
// a mode never enabled, a "Reset to defaults" (maxDailyLossAmount null) or a
// later edit leaves a different cap, or none, in force.
describe("Prop Firm Mode — the enforced daily loss cap is the one stored", () => {
  const withSettings = (settings: unknown, st: Record<string, unknown> = {}) => (c: Call) =>
    c.url === "/api/me/risk-settings" ? json(settings) : json(status(st));
  const line = () => screen.getByTestId("prop-firm-daily-loss-enforcement").textContent ?? "";

  it("mode never enabled, no daily loss amount stored: the prop cap is not called enforced", async () => {
    stubFetch(withSettings({ blockAfterDailyLossHit: true, maxDailyLossAmount: null }, { status: "OFF", config: { ...status().config, enabled: false } }));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByText("Configure")).toBeTruthy());
    await waitFor(() => expect(line()).toMatch(/is on/));
    expect(line()).not.toMatch(/enforced as well/);
    expect(line()).toMatch(/no daily loss amount is set in your risk settings/);
    expect(line()).toMatch(/prop daily loss cap \(\$5000\) is not enforced/);
  });

  it("mode on but the stored amount was reset to none: the prop cap is not called enforced", async () => {
    stubFetch(withSettings({ blockAfterDailyLossHit: true, maxDailyLossAmount: null }));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByText("Configure")).toBeTruthy());
    await waitFor(() => expect(line()).toMatch(/is on/));
    expect(line()).not.toMatch(/enforced as well/);
    expect(line()).toMatch(/is not enforced/);
  });

  it("a different stored amount: says which cap is in force, not the prop value", async () => {
    stubFetch(withSettings({ blockAfterDailyLossHit: true, maxDailyLossAmount: 8000 }));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByText("Configure")).toBeTruthy());
    await waitFor(() => expect(line()).toMatch(/\$8000/));
    expect(line()).not.toMatch(/enforced as well/);
    expect(line()).toMatch(/daily loss cap in your risk settings is \$8000, not the prop value \$5000/);
  });

  it("the stored amount not reported: whether the prop cap is enforced is not known", async () => {
    stubFetch(withSettings({ blockAfterDailyLossHit: true }));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByText("Configure")).toBeTruthy());
    await waitFor(() => expect(line()).toMatch(/is on/));
    expect(line()).not.toMatch(/enforced as well/);
    expect(line()).toMatch(/not known whether the prop daily loss cap is enforced/);
  });
});

// Regression: /prop-firm-mode and /prop-challenge were both titled "Prop Firm
// Challenge Mode" while running different stores, engines, defaults and
// statuses (ACTIVE on one, FAILED on the other at the same time).
describe("Prop Firm Mode — not confused with Prop Challenge", () => {
  it("has its own title and says it is separate from Prop Challenge Practice", async () => {
    stubFetch(() => json(status()));
    render(<PropFirmMode />);
    await waitFor(() => expect(screen.getByText("Configure")).toBeTruthy());
    expect(screen.queryByText("Prop Firm Challenge Mode")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Prop Firm Risk Mode");
    expect(screen.getByTestId("prop-firm-separate").textContent).toMatch(/separate from Prop Challenge Practice/);
  });
});

// Prop Firm Mode used to show "Profit USD $0", "✓ DAILY_DD ✓ TOTAL_DD" and
// ACTIVE when the server had no paper equity to measure. The server now says
// so (measured:false, null money figures, notChecked); the page must show
// "not measured" and must not present any rule as passed.

const CONFIG = {
  enabled: true, startingBalance: 100000, profitTarget: 8000, maxDailyDrawdownUsd: 5000, maxTotalDrawdownUsd: 10000,
  minTradingDays: 5, maxLotSize: 1, maxPositions: 3, newsTradingAllowed: false, weekendHoldingAllowed: false, consistencyRulePctOfTotal: 40,
};

function stubStatus(body: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
}

describe("Prop Firm Mode — unmeasured equity", () => {
  it("shows not measured, no passed rule, and lists the rules as not checked", async () => {
    const reason = "No active paper account, so paper equity could not be read.";
    stubStatus({
      config: CONFIG, measured: false, notMeasuredReason: reason,
      profitUsd: null, profitTargetProgress: null, dailyDrawdownRemainingUsd: null, totalDrawdownRemainingUsd: null,
      passed: [], failed: [], status: "NOT_MEASURED", equitySource: "paper_ledger",
      notChecked: ["PROFIT_TARGET", "DAILY_DD", "TOTAL_DD"].map((rule) => ({ rule, reason })),
    });
    render(<PropFirmMode />);
    const banner = await screen.findByTestId("prop-not-measured");
    expect(banner.textContent).toMatch(/No active paper account/);
    expect(screen.getByTestId("prop-status-badge").textContent).toBe("NOT MEASURED");
    expect(screen.queryByText(/ACTIVE/)).toBeNull();
    expect(screen.queryByText(/✓/)).toBeNull();
    expect(screen.queryByText("$0")).toBeNull();
    expect(screen.queryByText("$null")).toBeNull();
    // Merged with the page's other "Not measured" cells (one casing for every unmeasured figure).
    expect(screen.getAllByText("Not measured").length).toBeGreaterThanOrEqual(4);
    for (const rule of ["PROFIT_TARGET", "DAILY_DD", "TOTAL_DD"]) {
      expect(screen.getByTestId(`prop-rule-not-checked-${rule}`).textContent).toMatch(/not checked/);
    }
  });
});

describe("Prop Firm Mode — measured from the challenge start", () => {
  it("says which paper account, which equity mark and which start the figures come from, and shows the size note", async () => {
    const note = "The challenge size is $100000, but your paper account started the challenge with $10000 equity. Profit, target and drawdown are measured in dollars from $10000 and are not scaled.";
    stubStatus({
      config: CONFIG, measured: true, notMeasuredReason: null,
      profitUsd: 0, profitTargetProgress: 0, dailyDrawdownRemainingUsd: 5000, totalDrawdownRemainingUsd: 10000,
      passed: ["DAILY_DD", "TOTAL_DD"], failed: [], notChecked: [], status: "ACTIVE", equitySource: "paper_ledger",
      paperAccountId: 3, equityUsd: 10000, equityAsOf: "2026-10-28T11:59:00.000Z",
      challengeStartedAt: "2026-10-27T09:00:00.000Z", startEquityUsd: 10000, dailyDrawdownSince: "2026-10-28T00:00:00.000Z",
      notes: [note],
    });
    render(<PropFirmMode />);
    const from = await screen.findByTestId("prop-measured-from");
    expect(from.textContent).toMatch(/paper account #3/);
    expect(from.textContent).toMatch(/last stored mark/);
    expect(from.textContent).toMatch(/when the challenge started/);
    expect(screen.getByTestId("prop-note").textContent).toBe(note);
    expect(screen.queryByText("$-90000")).toBeNull();
  });
});

describe("Prop Firm Mode — target reached with unchecked rules", () => {
  it("says the target is reached but not a confirmed pass, and lists each unchecked rule with its reason", async () => {
    const notChecked = [
      { rule: "MIN_TRADING_DAYS", reason: "Trading days are not counted, so the minimum of 5 days is not checked." },
      { rule: "CONSISTENCY", reason: "The 40% consistency rule (best day against total profit) is not checked." },
      { rule: "MAX_LOT_SIZE", reason: "Your trades are not checked against the 1-lot cap. The Risk Governor refuses new orders above 1 lots (your limit in force)." },
    ];
    stubStatus({
      config: CONFIG, measured: true, notMeasuredReason: null,
      profitUsd: 900, profitTargetProgress: 112.5, dailyDrawdownRemainingUsd: 5000, totalDrawdownRemainingUsd: 10000,
      passed: ["PROFIT_TARGET", "DAILY_DD", "TOTAL_DD"], failed: [], notChecked, status: "TARGET_REACHED", equitySource: "paper_ledger",
      paperAccountId: 3, equityUsd: 10900, equityAsOf: "2026-10-28T11:59:00.000Z",
      challengeStartedAt: "2026-10-28T08:00:00.000Z", startEquityUsd: 10000, dailyDrawdownSince: "2026-10-28T08:00:00.000Z", notes: [],
    });
    render(<PropFirmMode />);
    const banner = await screen.findByTestId("prop-target-reached");
    expect(banner.textContent).toMatch(/3 challenge rules are not checked, so this is not a confirmed pass/);
    expect(screen.getByTestId("prop-status-badge").textContent).toBe("TARGET REACHED");
    expect(screen.queryByText("PASSED")).toBeNull();
    const reasons = screen.getByTestId("prop-not-checked-reasons");
    for (const n of notChecked) expect(reasons.textContent).toContain(n.reason);
  });
});

// A challenge that spans earlier days: the server scores only today's loss
// (DAILY_DD_TODAY) and current equity (TOTAL_DD_CURRENT). The page counts those
// as passed checks, never as passed challenge rules.
describe("Prop Firm Mode — partly measured drawdown rules", () => {
  it("counts the measured parts as passed checks and never ticks DAILY_DD or TOTAL_DD", async () => {
    const notChecked = [
      { rule: "DAILY_DD_EARLIER_DAYS", reason: "Only today's loss is checked (DAILY_DD_TODAY). Daily losses on earlier days of the challenge are not, so DAILY_DD is not confirmed." },
      { rule: "TOTAL_DD_LOWEST_EQUITY", reason: "Only current equity is checked (TOTAL_DD_CURRENT). A deeper dip earlier in the challenge is not recorded, so TOTAL_DD is not confirmed." },
    ];
    stubStatus({
      config: CONFIG, measured: true, notMeasuredReason: null,
      profitUsd: 0, profitTargetProgress: 0, dailyDrawdownRemainingUsd: 5000, totalDrawdownRemainingUsd: 10000,
      passed: ["DAILY_DD_TODAY", "TOTAL_DD_CURRENT"], failed: [], notChecked, status: "ACTIVE", equitySource: "paper_ledger",
      paperAccountId: 3, equityUsd: 100000, equityAsOf: "2026-10-30T11:59:00.000Z",
      challengeStartedAt: "2026-10-27T09:00:00.000Z", startEquityUsd: 100000, dailyDrawdownSince: "2026-10-30T00:00:00.000Z", notes: [],
    });
    render(<PropFirmMode />);
    const rules = await screen.findByTestId("prop-firm-rules");
    expect(rules.textContent).toContain("✓ DAILY_DD_TODAY");
    expect(rules.textContent).toContain("✓ TOTAL_DD_CURRENT");
    expect(rules.textContent).not.toMatch(/✓ DAILY_DD(?!_TODAY)/);
    expect(rules.textContent).not.toMatch(/✓ TOTAL_DD(?!_CURRENT)/);
    expect(screen.queryByText("Passed rules")).toBeNull();
    expect(screen.getByText("Passed checks")).toBeTruthy();
    expect(screen.getByTestId("prop-not-checked-reasons").textContent).toMatch(/DAILY_DD is not confirmed/);
  });
});

// On the day a challenge starts, the server measures today's drawdown from the
// start, so a floating loss already open at the start (Reset with a losing
// position) is not counted. The page said every day that it counts "the
// current floating loss", which is not what is measured on the start day.
describe("Prop Firm Mode — drawdown basis on the start day", () => {
  const base = {
    config: CONFIG, measured: true, notMeasuredReason: null,
    profitUsd: 0, profitTargetProgress: 0, dailyDrawdownRemainingUsd: 5000, totalDrawdownRemainingUsd: 10000,
    passed: ["DAILY_DD", "TOTAL_DD_CURRENT"], failed: [], notChecked: [], status: "ACTIVE", equitySource: "paper_ledger",
    paperAccountId: 3, equityUsd: 96000, equityAsOf: "2026-10-28T11:59:00.000Z", startEquityUsd: 96000, notes: [],
  };
  it("on the start day it says a floating loss already open at the start is not counted", async () => {
    stubStatus({ ...base, challengeStartedAt: "2026-10-28T08:00:00.000Z", dailyDrawdownSince: "2026-10-28T08:00:00.000Z" });
    render(<PropFirmMode />);
    const from = await screen.findByTestId("prop-measured-from");
    expect(from.textContent).toMatch(/loss since the challenge started; a floating loss already open at the start is not counted/);
    expect(from.textContent).not.toMatch(/plus the current floating loss/);
  });
  it("on later days it says the current floating loss counts", async () => {
    stubStatus({ ...base, challengeStartedAt: "2026-10-25T08:00:00.000Z", dailyDrawdownSince: "2026-10-28T00:00:00.000Z" });
    render(<PropFirmMode />);
    const from = await screen.findByTestId("prop-measured-from");
    expect(from.textContent).toMatch(/plus the current floating loss/);
  });
});

// Round-3 safety review (s3-views): on a start day with positions open at the
// start, today's drawdown on the paper risk count is only bounded. A newer
// server passes DAILY_DD when that bound is under the cap (both bases pass)
// and reports the least room left (dailyDrawdownRemainingAtLeastUsd). The
// page hid the pass and showed "Daily DD left: Not measured" whenever the
// drawdown was not measured exactly.
describe("Prop Firm Mode — a bounded daily drawdown under the cap", () => {
  const base = {
    config: CONFIG, measured: true, notMeasuredReason: null,
    profitUsd: 0, profitTargetProgress: 0, dailyDrawdownRemainingUsd: null, totalDrawdownRemainingUsd: 10000,
    failed: [], notChecked: [], status: "ACTIVE", equitySource: "paper_ledger", equityMeasured: true,
    paperAccountId: 3, equityUsd: 100100, equityAsOf: "2026-10-28T11:59:00.000Z", startEquityUsd: 100100,
    challengeStartedAt: "2026-10-28T08:00:00.000Z", dailyDrawdownSince: "2026-10-28T08:00:00.000Z",
    notes: ["... it is at most $99.90 there, and $0.00 on the paper account's booked figures, against the $5,000.00 cap. Both are under the cap, so DAILY_DD passes."],
    dailyDrawdownMeasured: false, dailyDrawdownUsd: null,
  };
  const dailyLeft = () => screen.getByText("Daily DD left").parentElement!.textContent;
  it("ticks DAILY_DD and shows the room left as a lower bound", async () => {
    stubStatus({ ...base, passed: ["DAILY_DD", "TOTAL_DD_CURRENT"], notEvaluated: [], notEvaluatedReasons: {}, dailyDrawdownRemainingAtLeastUsd: 4900.1 });
    render(<PropFirmMode />);
    const rules = await screen.findByTestId("prop-firm-rules");
    expect(rules.textContent).toMatch(/✓ DAILY_DD(?!_)/);
    expect(rules.textContent).not.toMatch(/DAILY_DD: not checked/);
    expect(dailyLeft()).toContain("at least $4900.1");
    expect(dailyLeft()).not.toContain("Not measured");
  });
  it("without the lower bound (an older server, or a bound at the cap) it still shows not measured and no tick", async () => {
    stubStatus({ ...base, passed: ["DAILY_DD", "TOTAL_DD_CURRENT"], notEvaluated: [] });
    render(<PropFirmMode />);
    const rules = await screen.findByTestId("prop-firm-rules");
    expect(rules.textContent).not.toMatch(/✓ DAILY_DD(?!_)/);
    expect(dailyLeft()).toContain("Not measured");
  });
});
