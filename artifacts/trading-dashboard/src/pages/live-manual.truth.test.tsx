// Manual Trade Ticket (/live-manual) — every row in the ticket summary says
// what was read, from where, or that it could not be checked.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/charts/TradingViewLiveChart", () => ({ default: () => null }));
vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["EURUSD", () => undefined],
  bareSymbol: (s: string) => (s.includes(":") ? s.split(":")[1]! : s),
}));

const { default: LiveManualPage } = await import("./live-manual");

// The real GET /api/system/mt5-deferred-status shape: `simulator` lists what
// the simulator enforces (capabilities, constant true) — it is not a state.
const deferredStatus = {
  deferred: true, systemState: "MT5_DEFERRED_SIMULATOR_MODE", liveExecutionLocked: true,
  simulator: { mutatesLivePositions: false, sendsRealOrders: false, enforcesRiskGovernor: true, enforcesKillSwitch: true },
};

// The real GET /api/permission/status shape: the PermissionVerdict
// (lib/domain safety-permission evaluate.ts) plus explanation and
// testerAccess. It has no killSwitchEngaged field; an engaged safety-core
// kill switch is a reason with code KILL_SWITCH (and a blocker).
const KILL_SWITCH_MSG = "Kill switch is engaged — all trading is paused.";
const permissionVerdict = (killSwitch: boolean) => ({
  status: killSwitch ? "LOCKED" : "LIVE_TRADING_DISABLED",
  riskLevel: killSwitch ? "HIGH" : "LOW",
  canPlaceTrades: false,
  liveTradingDisabled: true,
  activeLockType: null,
  reasons: killSwitch ? [{ code: "KILL_SWITCH", severity: "BLOCK", message: KILL_SWITCH_MSG }] : [],
  blockers: killSwitch ? [KILL_SWITCH_MSG] : [],
  warnings: [],
  activeLocks: [],
  evaluatedAtIso: "2026-10-28T11:00:00.000Z",
  explanation: { headline: "", details: [] },
  testerAccess: {},
});

type Route = { status?: number; body: unknown };
function stubFetch(routes: Record<string, Route>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    const r: Route = key ? routes[key]! : { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }));
}
const baseRoutes = (over: Record<string, Route> = {}): Record<string, Route> => ({
  "/api/permission/status": { body: permissionVerdict(false) },
  "/api/system/mt5-deferred-status": { body: deferredStatus },
  "/api/me/master-bridge/status": { body: { detected: false } },
  "/api/market/quote/": { body: { symbol: "EURUSD", bid: 1.0849, ask: 1.0851, mid: 1.085, spread: 0.0002, volatility: "MEDIUM" } },
  ...over,
});
/** Let every mount-time read answer (they resolve in any order). */
async function renderSettled() {
  render(<LiveManualPage />);
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}
const rowBadge = (label: string) => screen.getByText(label).parentElement!.lastElementChild!;
// The permission verdict's kill switch is the safety-core switch only, so the
// row says so; the other stops have rows of their own.
const killSwitchBadge = () => rowBadge("Safety-core kill switch");

// The real GET /api/system/status halt fields (routes/system.ts
// readStatusHalts): every stop that halts this viewer's broker orders, read by
// the pre-trade Risk Governor's own reader. null = could not be checked.
const systemStatus = (activeHalts: string[] | null, reasons: string[] = []) => ({
  operationalMode: "OBSERVE_ONLY", globalState: "NORMAL", killSwitchEngaged: activeHalts?.includes("safety_core_kill_switch") ?? false,
  activeHalts, activeHaltReasons: reasons, activeHaltsCheckedAt: "2026-11-03T10:00:00.000Z",
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Manual Trade Ticket — kill switch row", () => {
  it("reads 'off' when /api/permission/status says the kill switch is clear, whatever the simulator capability flag says", async () => {
    stubFetch(baseRoutes());
    await renderSettled();
    expect(killSwitchBadge().textContent).toBe("off");
  });

  it("reads ENGAGED only when the permission status says so", async () => {
    stubFetch(baseRoutes({ "/api/permission/status": { body: permissionVerdict(true) } }));
    await renderSettled();
    expect(killSwitchBadge().textContent).toBe("ENGAGED");
  });

  it("a 200 answer without the verdict's reasons list is 'not checked', never 'off'", async () => {
    // A top-level killSwitchEngaged is not part of the verdict; it must not be read.
    stubFetch(baseRoutes({ "/api/permission/status": { body: { killSwitchEngaged: false } } }));
    await renderSettled();
    expect(killSwitchBadge().textContent).toBe("not checked");
  });

  it("says it could not be checked when the permission status fails, never 'off'", async () => {
    stubFetch(baseRoutes({ "/api/permission/status": { status: 500, body: { error: "Failed" } } }));
    await renderSettled();
    expect(killSwitchBadge().textContent).toBe("not checked");
  });
});

// Round 3 review: the row read "Kill switch: off" whenever the permission
// verdict had no KILL_SWITCH reason, but that verdict covers only the
// safety-core switch. The platform emergency stop and the trader's own kill
// switch were never read, so "off" was an all-clear nobody checked.
describe("Manual Trade Ticket — every stop has its own row", () => {
  it("no bare 'off' under a generic 'Kill switch' label", async () => {
    stubFetch(baseRoutes({ "/api/system/status": { body: systemStatus([]) } }));
    await renderSettled();
    expect(screen.queryByText("Kill switch")).toBeNull();
    expect(killSwitchBadge().textContent).toBe("off");
    expect(rowBadge("Emergency stop").textContent).toBe("off");
    expect(rowBadge("Your kill switch").textContent).toBe("off");
  });

  it("the trader's own kill switch engaged: its row says ENGAGED while the safety-core row stays 'off'", async () => {
    stubFetch(baseRoutes({
      "/api/system/status": { body: systemStatus(["trader_kill_switch"], ["Your kill switch is engaged. Release it to trade again."]) },
    }));
    await renderSettled();
    expect(rowBadge("Your kill switch").textContent).toBe("ENGAGED");
    expect(rowBadge("Your kill switch").getAttribute("title")).toContain("Your kill switch is engaged");
    expect(killSwitchBadge().textContent).toBe("off");
    expect(rowBadge("Emergency stop").textContent).toBe("off");
  });

  it("the platform emergency stop engaged: its row says ENGAGED", async () => {
    stubFetch(baseRoutes({
      "/api/system/status": { body: systemStatus(["platform_emergency_stop"], ["The platform emergency stop is engaged by an operator."]) },
    }));
    await renderSettled();
    expect(rowBadge("Emergency stop").textContent).toBe("ENGAGED");
    expect(rowBadge("Your kill switch").textContent).toBe("off");
  });

  it("a failed system status read: the other stops are 'not checked', never 'off'", async () => {
    stubFetch(baseRoutes({ "/api/system/status": { status: 500, body: { error: "Failed to load safety core status" } } }));
    await renderSettled();
    expect(rowBadge("Emergency stop").textContent).toBe("not checked");
    expect(rowBadge("Your kill switch").textContent).toBe("not checked");
    expect(killSwitchBadge().textContent).toBe("off");
  });

  it("a system status whose halt read failed (activeHalts null) is 'not checked'", async () => {
    stubFetch(baseRoutes({ "/api/system/status": { body: systemStatus(null) } }));
    await renderSettled();
    expect(rowBadge("Emergency stop").textContent).toBe("not checked");
    expect(rowBadge("Your kill switch").textContent).toBe("not checked");
  });

  it("the client only downgrades: a safety-core switch the halt reader lists as engaged is ENGAGED", async () => {
    stubFetch(baseRoutes({
      "/api/system/status": { body: systemStatus(["safety_core_kill_switch"], ["The safety-core kill switch is engaged."]) },
    }));
    await renderSettled();
    expect(killSwitchBadge().textContent).toBe("ENGAGED");
  });

  it("says the stops are shown for information and are not checked when the intent is captured", async () => {
    stubFetch(baseRoutes({ "/api/system/status": { body: systemStatus([]) } }));
    await renderSettled();
    expect(screen.getByTestId("ticket-stops-note").textContent).toMatch(/not checked when you submit/i);
  });
});

// POST /api/live-intent/submit applies only three tester caps (lot ≤ 0.01,
// stop-loss required, max loss ≤ $5). It never runs the pre-trade Risk
// Governor, never reads the kill switch and never executes anywhere.
describe("Manual Trade Ticket — what the submit path checks", () => {
  it("does not claim the Risk Governor or kill switch run on this capture", async () => {
    stubFetch(baseRoutes());
    await renderSettled();
    const governor = screen.getByText("Risk governor").parentElement!.lastElementChild!;
    expect(governor.textContent).not.toMatch(/active/i);
    expect(governor.textContent).toMatch(/not run/i);
    const env = screen.getByText("Execution environment").parentElement!.lastElementChild!;
    expect(env.textContent).not.toBe("SIMULATOR");
    expect(document.body.textContent).not.toMatch(/kill switch and risk governor always apply/i);
    expect(document.body.textContent).toMatch(/lot ≤ 0\.01/);

    screen.getByTestId("ticket-submit").click();
    const dialog = await screen.findByTestId("ticket-confirm-dialog");
    expect(dialog.textContent).not.toMatch(/goes through the risk governor/i);
  });
});

// The only quote on this page is the ARX market simulator's
// (/api/market/quote): a random walk from a fixed base price, not the market.
// A stop set off the real chart, measured from the simulator mid, is a
// meaningless distance, so no dollar figure or reward:risk is priced from it.
describe("Manual Trade Ticket — estimated loss / gain", () => {
  it("does not price a stop or target off the simulator mid (no ≈$ figure, no R:R)", async () => {
    // Simulator EURUSD mid 1.0850; the trader's stop/target are set off a
    // real market near 1.1600. Measured from the simulator, the 20-pip stop
    // would read ≈$75.00 and the R:R 0.97 — both false.
    stubFetch(baseRoutes());
    await renderSettled();
    await act(async () => {
      fireEvent.change(screen.getByTestId("ticket-sl"), { target: { value: "1.158" } });
      fireEvent.change(screen.getByTestId("ticket-tp"), { target: { value: "1.164" } });
    });
    expect(screen.getByTestId("ticket-est-loss").textContent).toBe("Not estimated");
    expect(screen.getByTestId("ticket-est-gain").textContent).toBe("Not estimated");
    expect(screen.getByTestId("ticket-est-loss").getAttribute("title")).toMatch(/simulator's, not the market/);
    expect(screen.getByTestId("ticket-rr").textContent).toBe("—");
    expect(document.body.textContent).not.toMatch(/vs simulator mid/);
    expect(screen.getByTestId("ticket-quote-source").textContent).toBe("ARX simulator quote — not the market");
  });

  it("a market without a known contract size says 'Not estimated' instead of a dollar figure", async () => {
    stubFetch(baseRoutes({ "/api/market/quote/": { body: { symbol: "XAUUSD", bid: 2400, ask: 2400.4, mid: 2400.2, spread: 0.4, volatility: "MEDIUM" } } }));
    await renderSettled();
    await act(async () => {
      fireEvent.change(screen.getByTestId("ticket-symbol"), { target: { value: "XAUUSD" } });
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    await act(async () => { fireEvent.change(screen.getByTestId("ticket-sl"), { target: { value: "2390" } }); });
    expect(screen.getByTestId("ticket-quote").textContent).toContain("2400");
    expect(screen.getByTestId("ticket-est-loss").textContent).toBe("Not estimated");
  });
});

// POST /api/live-intent/submit compares only the Max Loss figure the trader
// types (maxLossUsd) with the $5 cap. It never works out the loss at the stop
// from lot, stop and price, so "max loss ≤ $5" and "Tester caps: passed" must
// not read as a checked bound on the real loss.
describe("Manual Trade Ticket — the max-loss cap is the declared figure only", () => {
  it("names the cap as the Max Loss you enter, and the passed result says the loss at the stop was not computed", async () => {
    stubFetch(baseRoutes({
      "/api/live-intent/submit": { body: {
        accepted: false, riskCheckPassed: true, testerAccess: true, brokerExecution: false,
        status: "PENDING_MT5_CONNECTION", intentId: "intent_x", mt5Connected: false, reason: "Captured.",
      } },
    }));
    await renderSettled();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/max loss ≤ \$5\)/);
    expect(text).toMatch(/the Max Loss you enter ≤ \$5 \(the loss at your stop is not computed\)/);
    expect(screen.getByTestId("ticket-maxloss-hint").textContent).toMatch(/not checked against your stop/);
    await act(async () => { fireEvent.change(screen.getByTestId("ticket-sl"), { target: { value: "1.0450" } }); });
    await act(async () => { screen.getByTestId("ticket-submit").click(); });
    await act(async () => { (await screen.findByTestId("ticket-confirm-submit")).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const caps = screen.getByTestId("ticket-response-caps").textContent ?? "";
    expect(caps).toMatch(/^Tester caps: passed/);
    expect(caps).toMatch(/loss at your stop was not computed/);
  });
});
