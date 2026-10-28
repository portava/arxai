// Live Trading Control — unread readiness is "unavailable", never "No
// blockers."; the armed banner does not claim real-money risk the page's own
// placement layer cannot create.
//
// Before: when GET /api/live-trading/readiness returned the 403 deny envelope
// (no `readiness` field) the page rendered "Blockers (0)" with a green "No
// blockers." and "Required actions (0) None."; a denied approvals read showed
// "No trade cards."; a failed state read showed the kill switch "OFF" in
// green. With state.armed the banner said "REAL-MONEY RISK ACTIVE" while the
// notice below said an armed card "cannot reach a real broker from here"
// (placeLiveOrderGuarded always rejects BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED).

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const { default: LiveTradingControl } = await import("./live-trading-control");

const deny = { status: 403, body: { system: "live-trading", result: { status: "REJECTED", reason: "role USER lacks live_trading:read" } } };
const state = (over: Record<string, unknown> = {}) => ({
  body: {
    state: {
      mode: "DEMO_ONLY", armed: false, killSwitchActive: false, emergencyStopActive: false, killSwitchReason: null,
      liveTradesToday: 0, liveTradesSession: 0, consecutiveLiveLosses: 0, dailyLossPct: 0, weeklyLossPct: 0, ...over,
    },
  },
});
const readiness = {
  body: {
    readiness: {
      liveTradingEligible: false, currentMode: "DEMO_ONLY", blockers: [], warnings: [], requiredActions: [], safetyScore: 90,
      paperStats: {}, riskStatus: {}, brokerStatus: {}, permissionStatus: {}, hardCodedLimits: {}, ciGuardsAcknowledged: [],
      lastUpdated: new Date().toISOString(),
    },
  },
};

type Route = { status?: number; body: unknown };
function stubFetch(routes: Record<string, Route>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    const r: Route = key ? routes[key]! : { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }));
}
async function renderSettled() {
  render(<LiveTradingControl />);
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Live Trading Control — reads that did not answer", () => {
  it("a denied readiness read shows blockers 'unavailable', never 'No blockers.'", async () => {
    stubFetch({
      "/api/live-trading/readiness": deny, "/api/live-trading/state": state(),
      "/api/live-trading/audit": { body: { events: [] } }, "/api/live-trading/approvals": deny,
    });
    await renderSettled();
    expect(screen.queryByText("No blockers.")).toBeNull();
    expect(screen.getByTestId("ltc-blockers").textContent).toMatch(/unavailable/i);
    expect(screen.getByTestId("ltc-required-actions").textContent).not.toMatch(/None\./);
    expect(screen.queryByText("No trade cards.")).toBeNull();
    expect(screen.getByTestId("ltc-approvals").textContent).toMatch(/could not be read/i);
    expect(screen.getByTestId("ltc-readiness").textContent).toMatch(/UNKNOWN/);
  });

  it("a readiness read that answered with no blockers still says 'No blockers.'", async () => {
    stubFetch({
      "/api/live-trading/readiness": readiness, "/api/live-trading/state": state(),
      "/api/live-trading/audit": { body: { events: [] } }, "/api/live-trading/approvals": { body: { approvals: [] } },
    });
    await renderSettled();
    expect(screen.getByText("No blockers.")).toBeTruthy();
    expect(screen.getByText("No trade cards.")).toBeTruthy();
  });

  it("a failed state read never shows the kill switch OFF", async () => {
    stubFetch({
      "/api/live-trading/readiness": readiness, "/api/live-trading/state": { status: 500, body: "oops" },
      "/api/live-trading/audit": { body: { events: [] } }, "/api/live-trading/approvals": { body: { approvals: [] } },
    });
    await renderSettled();
    expect(screen.getByTestId("ltc-kill-switch").textContent).not.toMatch(/OFF/);
    expect(screen.getByTestId("ltc-kill-switch").textContent).toMatch(/UNKNOWN/);
  });
});

describe("Live Trading Control — armed banner", () => {
  it("does not say REAL-MONEY RISK ACTIVE next to 'cannot reach a real broker'", async () => {
    stubFetch({
      "/api/live-trading/readiness": readiness, "/api/live-trading/state": state({ armed: true, mode: "MICRO_LIVE" }),
      "/api/live-trading/audit": { body: { events: [] } }, "/api/live-trading/approvals": { body: { approvals: [] } },
    });
    await renderSettled();
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/cannot reach a real broker/);
    expect(text).not.toMatch(/REAL-MONEY RISK ACTIVE/);
    expect(text).toMatch(/MICRO-LIVE ARMED/);
  });
});
