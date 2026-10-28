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

type Route = { status?: number; body: unknown };
function stubFetch(routes: Record<string, Route>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    const r: Route = key ? routes[key]! : { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }));
}
const baseRoutes = (over: Record<string, Route> = {}): Record<string, Route> => ({
  "/api/permission/status": { body: { killSwitchEngaged: false } },
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
const killSwitchBadge = () => screen.getByText("Kill switch").parentElement!.lastElementChild!;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Manual Trade Ticket — kill switch row", () => {
  it("reads 'off' when /api/permission/status says the kill switch is clear, whatever the simulator capability flag says", async () => {
    stubFetch(baseRoutes());
    await renderSettled();
    expect(killSwitchBadge().textContent).toBe("off");
  });

  it("reads ENGAGED only when the permission status says so", async () => {
    stubFetch(baseRoutes({ "/api/permission/status": { body: { killSwitchEngaged: true } } }));
    await renderSettled();
    expect(killSwitchBadge().textContent).toBe("ENGAGED");
  });

  it("says it could not be checked when the permission status fails, never 'off'", async () => {
    stubFetch(baseRoutes({ "/api/permission/status": { status: 500, body: { error: "Failed" } } }));
    await renderSettled();
    expect(killSwitchBadge().textContent).toBe("not checked");
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

describe("Manual Trade Ticket — estimated loss / gain", () => {
  it("EURUSD 0.01 lot with a 20-pip stop reads ≈$2.00, not $0.20", async () => {
    stubFetch(baseRoutes());
    await renderSettled();
    await act(async () => {
      fireEvent.change(screen.getByTestId("ticket-sl"), { target: { value: "1.083" } });
      fireEvent.change(screen.getByTestId("ticket-tp"), { target: { value: "1.089" } });
    });
    expect(screen.getByTestId("ticket-est-loss").textContent).toBe("≈$2.00");
    expect(screen.getByTestId("ticket-est-gain").textContent).toBe("≈$4.00");
    expect(screen.getByTestId("ticket-rr").textContent).toBe("2.00");
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
