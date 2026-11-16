// MT5 Bridge Status card: a heartbeat dated after the server's clock has no
// verifiable age. The server sends heartbeatAgeSeconds null and
// heartbeatFresh false with the heartbeat time; the card says the age cannot
// be verified, not "connected" and not "we haven't heard from MT5".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveEaHeartbeatDebugCard } from "./LiveEaHeartbeatDebugCard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function debugBody(over: Record<string, unknown>) {
  return {
    bridgeKind: "REAL_LIVE",
    counts: { live: 1, demo: 0, mock: 0 },
    bridge: {
      id: 1, mode: "LIVE", bridgeKind: "REAL_LIVE", accountType: "live", accountNumber: "77001234",
      brokerName: "Broker", serverName: "Broker-Live", eaVersion: "1.50", bridgeVersion: null,
      lastHeartbeatAt: "2026-11-03T12:00:30.000Z", heartbeatAgeSeconds: null, heartbeatFresh: false,
      readOnlyMode: false,
      eaInputs: { readOnlyMode: false, enableDemoExecution: true, enableLiveExecution: true,
        terminalConnected: true, algoTradingAllowed: true, maxLiveLot: null, reportedAt: null },
      ...over,
    },
  };
}

function renderWith(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/me/live/bridge-debug")) return new Response(JSON.stringify(body), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><LiveEaHeartbeatDebugCard /></QueryClientProvider>);
}

describe("LiveEaHeartbeatDebugCard future-dated heartbeat", () => {
  it("says the heartbeat age cannot be verified", async () => {
    renderWith(debugBody({}));
    expect(await screen.findByText("MT5 heartbeat age cannot be verified")).toBeTruthy();
    const card = screen.getByTestId("live-ea-heartbeat-debug-card").textContent ?? "";
    expect(card).toContain("dated after the server's clock");
    expect(card).not.toContain("haven't heard from MetaTrader 5");
    expect(card).not.toContain("Bridge connected");
  });

  it("a stale heartbeat with a known age still says MT5 has not been heard from", async () => {
    renderWith(debugBody({ heartbeatAgeSeconds: 40 }));
    expect(await screen.findByText("MT5 connection needs attention")).toBeTruthy();
  });
});
