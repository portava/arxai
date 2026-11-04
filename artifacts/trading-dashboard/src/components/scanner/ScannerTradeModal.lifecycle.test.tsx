// Truth fix for the scanner's demo trade modal: the lifecycle line was
// scripted on the client. A confirm that came back ok:false with the row
// already BLOCKED left the badge at USER_CONFIRMATION_REQUIRED with "Waiting for
// EA fill…", each ok step pushed a literal label instead of the returned
// status, and a status poll that kept failing showed "Waiting for EA fill…"
// forever.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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

describe("ScannerTradeModal — lifecycle shows the server's row status", () => {
  async function sendMarket() {
    render(<ScannerTradeModal open onClose={() => {}} signal={signal} defaultSide="BUY" />);
    await flush();
    fireEvent.click(screen.getByTestId("scanner-trade-submit")); // Review
    fireEvent.click(screen.getByTestId("scanner-trade-submit")); // Send
    await flush();
  }

  it("a confirm that returns a BLOCKED row shows BLOCKED immediately, never 'Waiting for EA fill'", async () => {
    routes.push((u) => (u.endsWith("/api/me/demo-bridge-debug") ? json(bridge(["USER_NOT_CONFIRMED"])) : undefined));
    routes.push((u, init) => (u.endsWith("/api/me/demo-commands") && init?.method === "POST"
      ? json({ ok: true, command: { commandId: "cmd-1", status: "USER_CONFIRMATION_REQUIRED", reason: null } }) : undefined));
    routes.push((u) => (u.endsWith("/cmd-1/confirm")
      ? json({ ok: false, reason: "USER_NO_LONGER_ARMED", command: { commandId: "cmd-1", status: "BLOCKED", reason: "USER_NO_LONGER_ARMED" } }) : undefined));
    await sendMarket();
    const result = screen.getByTestId("scanner-trade-result");
    expect(result.textContent).toContain("BLOCKED");
    expect(result.textContent).toContain("USER_NO_LONGER_ARMED");
    expect(result.textContent).not.toContain("Waiting for EA fill");
    expect(screen.getByTestId("scanner-trade-lifecycle").textContent).toContain("BLOCKED");
  });

  it("the lifecycle records the status each step returned, not a scripted label", async () => {
    routes.push((u) => (u.endsWith("/api/me/demo-bridge-debug") ? json(bridge(["USER_NOT_CONFIRMED"])) : undefined));
    routes.push((u, init) => (u.endsWith("/api/me/demo-commands") && init?.method === "POST"
      ? json({ ok: true, command: { commandId: "cmd-2", status: "USER_CONFIRMATION_REQUIRED", reason: null } }) : undefined));
    routes.push((u) => (u.endsWith("/cmd-2/confirm") ? json({ ok: true, command: { commandId: "cmd-2", status: "DEMO_APPROVED", reason: null } }) : undefined));
    routes.push((u) => (u.endsWith("/cmd-2/dispatch") ? json({ ok: true, command: { commandId: "cmd-2", status: "QUEUED_FOR_EA", reason: null } }) : undefined));
    await sendMarket();
    const lifecycle = screen.getByTestId("scanner-trade-lifecycle").textContent ?? "";
    expect(lifecycle).toContain("QUEUED_FOR_EA");
    expect(lifecycle).not.toContain("SENT_TO_MT5_DEMO");
  });

  it("repeated status-poll failures say the status is unavailable instead of 'Waiting for EA fill'", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    routes.push((u) => (u.endsWith("/api/me/demo-bridge-debug") ? json(bridge(["USER_NOT_CONFIRMED"])) : undefined));
    routes.push((u, init) => (u.endsWith("/api/me/demo-commands") && init?.method === "POST"
      ? json({ ok: true, command: { commandId: "cmd-3", status: "USER_CONFIRMATION_REQUIRED", reason: null } }) : undefined));
    routes.push((u) => (u.endsWith("/cmd-3/confirm") ? json({ ok: true, command: { commandId: "cmd-3", status: "DEMO_APPROVED", reason: null } }) : undefined));
    routes.push((u) => (u.endsWith("/cmd-3/dispatch") ? json({ ok: true, command: { commandId: "cmd-3", status: "SENT_TO_MT5_DEMO", reason: null } }) : undefined));
    routes.push((u) => (u.endsWith("/api/me/demo-commands/cmd-3") ? json({ ok: false }, 500) : undefined));
    await sendMarket();
    expect(screen.getByTestId("scanner-trade-result").textContent).toContain("Waiting for EA fill");
    for (let i = 0; i < 3; i++) {
      await act(async () => { vi.advanceTimersByTime(1200); });
      await flush();
    }
    const result = screen.getByTestId("scanner-trade-result").textContent ?? "";
    expect(result).not.toContain("Waiting for EA fill");
    expect(result).toContain("Status unavailable");
  });
});
