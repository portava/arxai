// Truth fix for the scanner's demo trade modal: the green "Demo trading
// enabled. Live broker execution disabled." banner was a constant. A user with a
// ready bridge but NOT armed for demo execution saw it (plus an enabled
// Review/Send) and then every draft was refused with
// NOT_ARMED_FOR_DEMO_EXECUTION. The server's own dispatch gate already lists
// WRONG_EXECUTION_MODE / NOT_VERIFIED_DEMO in bridge.gateBlockers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { ok: true, isOwnerUnrestricted: false, templateName: null } }),
}));
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({
  useMasterLiveAccess: () => ({ canTrade: false, loaded: true }),
}));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ isLoading: false, isLiveShared: false }) }));
vi.mock("@/hooks/useScannerTruth", () => ({ useScannerTruth: () => ({ truth: null }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/components/live/LiveTradeTicket", () => ({ LiveTradeTicket: () => null }));
vi.mock("@/components/live/LiveSharedTradeTicket", () => ({ LiveSharedTradeTicket: () => null }));
vi.mock("@/components/trading/HistoricalCheckPanel", () => ({ HistoricalCheckPanel: () => null }));
vi.mock("@/components/trading/NewsRiskCheckPanel", () => ({ NewsRiskCheckPanel: () => null }));
vi.mock("./RubySetupReason", () => ({ RubySetupReason: () => null }));

import { ScannerTradeModal } from "./ScannerTradeModal";

const signal = {
  symbol: "EURUSD", timeframe: "15m", bias: "BUY", recommendedAction: "BUY",
  entry: 1.085, stopLoss: 1.08, takeProfit: 1.095, suggestedLot: 0.02, confidenceScore: 70,
} as unknown as Parameters<typeof ScannerTradeModal>[0]["signal"];

function bridge(gateBlockers: string[]) {
  return {
    ok: true, safetyMode: "demo_only", liveExecutionBlocked: true,
    bridge: {
      connectionId: 7, accountLoginMasked: "***123", accountType: "demo", eaVersionReported: "1.27",
      heartbeatAgeSeconds: 3, heartbeatFresh: true, heartbeatFreshStrict: true, eaVersionAtLeast: true,
      bridgeReady: true, bridgeBlockers: [], gateBlockers,
      eaInputs: { readOnlyMode: false, enableDemoExecution: true, reportedAt: null },
    },
  };
}
const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

type Route = (url: string, init?: RequestInit) => Promise<Response> | undefined;
let routes: Route[] = [];
beforeEach(() => {
  routes = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    for (const r of routes) { const res = r(String(url), init); if (res) return res; }
    return json({ ok: false }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function flush() { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); }

describe("ScannerTradeModal — demo execution banner reflects the server's dispatch gate", () => {
  it("does not claim demo trading is enabled for an unarmed user, and blocks Review", async () => {
    routes.push((u) => (u.endsWith("/api/me/demo-bridge-debug") ? json(bridge(["WRONG_EXECUTION_MODE", "NOT_VERIFIED_DEMO", "USER_NOT_CONFIRMED"])) : undefined));
    render(<ScannerTradeModal open onClose={() => {}} signal={signal} defaultSide="BUY" />);
    await flush();
    const banner = screen.getByTestId("scanner-demo-execution-banner");
    expect(banner.textContent).not.toContain("Demo trading enabled");
    expect(banner.textContent).toContain("not armed for demo execution");
    expect(banner.textContent).not.toContain("Live broker execution disabled");
    expect((screen.getByTestId("scanner-trade-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says demo execution is enabled only when the gate's only blocker is the per-order confirmation", async () => {
    routes.push((u) => (u.endsWith("/api/me/demo-bridge-debug") ? json(bridge(["USER_NOT_CONFIRMED"])) : undefined));
    render(<ScannerTradeModal open onClose={() => {}} signal={signal} defaultSide="BUY" />);
    await flush();
    const banner = screen.getByTestId("scanner-demo-execution-banner");
    expect(banner.textContent).toContain("Demo execution enabled");
    expect((screen.getByTestId("scanner-trade-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says the demo execution state is unknown when the bridge check fails", async () => {
    routes.push((u) => (u.endsWith("/api/me/demo-bridge-debug") ? json({}, 500) : undefined));
    render(<ScannerTradeModal open onClose={() => {}} signal={signal} defaultSide="BUY" />);
    await flush();
    const banner = screen.getByTestId("scanner-demo-execution-banner");
    expect(banner.textContent).not.toContain("enabled");
    expect(banner.textContent).toContain("could not be checked");
  });

  it("does not show a green 'enabled' banner when the server could not evaluate the dispatch gate", async () => {
    // The route answered 200 but evaluatePerUserDispatchGate threw: the server
    // sends gateEvaluated:false, bridgeReady:null and the initial empty
    // gateBlockers. An empty list from a gate that never ran is not a pass.
    const unevaluated = {
      ok: true, safetyMode: "demo_only", liveExecutionBlocked: true,
      bridge: {
        connectionId: 1, accountLoginMasked: "***123", accountType: "demo", eaVersionReported: "1.27",
        heartbeatAgeSeconds: 3, heartbeatFresh: true,
        gateEvaluated: false, bridgeReady: null, heartbeatFreshStrict: null, eaVersionAtLeast: null,
        bridgeBlockers: [], gateBlockers: [], armed: null, verifiedDemo: null,
        eaInputs: { readOnlyMode: null, enableDemoExecution: null, reportedAt: null },
      },
    };
    routes.push((u) => (u.endsWith("/api/me/demo-bridge-debug") ? json(unevaluated) : undefined));
    render(<ScannerTradeModal open onClose={() => {}} signal={signal} defaultSide="BUY" />);
    await flush();
    const banner = screen.getByTestId("scanner-demo-execution-banner");
    expect(banner.textContent).not.toContain("enabled");
    expect(banner.textContent).toContain("could not be checked");
    expect(banner.textContent).toContain("could not evaluate");
    expect(banner.className).not.toContain("text-success");
    expect((screen.getByTestId("scanner-trade-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("names DEMO_EXECUTION_NOT_ARMED in plain English, never as the raw code", async () => {
    // The server renames WRONG_EXECUTION_MODE to DEMO_EXECUTION_NOT_ARMED.
    const unarmed = bridge(["DEMO_EXECUTION_NOT_ARMED"]);
    unarmed.bridge.bridgeReady = false;
    routes.push((u) => (u.endsWith("/api/me/demo-bridge-debug") ? json(unarmed) : undefined));
    render(<ScannerTradeModal open onClose={() => {}} signal={signal} defaultSide="BUY" />);
    await flush();
    const banner = screen.getByTestId("scanner-demo-execution-banner");
    expect(banner.textContent).not.toContain("DEMO_EXECUTION_NOT_ARMED");
    expect(banner.textContent).toContain("not armed for demo execution");
    expect(banner.textContent).toContain("MT5 Setup → Demo Execution Control");
  });
});
