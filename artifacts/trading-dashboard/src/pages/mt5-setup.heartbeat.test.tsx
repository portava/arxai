// MT5 Setup: "Last heartbeat" is the EA's heartbeat time (not the request time
// of /broker/connection-check), and "Connected" means a fresh heartbeat under
// the shared heartbeat policy — a 50 s old heartbeat reads as delayed, the way
// /mt5/status calls it stale.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { default: MT5SetupWizardPage, describeBridgeHeartbeat } = await import("./mt5-setup");
type Conn = NonNullable<Parameters<typeof describeBridgeHeartbeat>[0]>;

const NOW = Date.parse("2026-10-28T09:00:00.000Z");
const BASE: Conn = {
  provider: "mt5", connected: true, environment: "DEMO", accountIdPresent: true, bridgeUrlPresent: true,
  apiKeyPresent: true, readOnlyReady: true, liveOrderReady: false, missingSecrets: [],
  checks: {
    accountReadable: true, equityReadable: true, balanceReadable: true, marginReadable: true,
    symbolsReadable: true, positionsReadable: true, ordersReadable: true,
    symbolCount: 3, positionCount: 0, orderCount: 0,
  },
  errors: [], lastCheckedAt: new Date(NOW).toISOString(),
};

describe("describeBridgeHeartbeat", () => {
  it("a 50 s old heartbeat is not 'Connected' and its time is the heartbeat, not the check", () => {
    const hbAt = new Date(NOW - 50_000).toISOString();
    const v = describeBridgeHeartbeat({ ...BASE, lastHeartbeatAt: hbAt, heartbeatAgeSeconds: 50, heartbeatFreshness: "degraded" }, NOW);
    expect(v.state).toBe("delayed");
    expect(v.label).not.toBe("Connected");
    expect(v.lastHeartbeat).toContain(new Date(hbAt).toLocaleTimeString());
    expect(v.lastHeartbeat).toContain("50s ago");
  });

  it("a server that does not report the heartbeat time never shows the request time as one", () => {
    const v = describeBridgeHeartbeat(BASE, NOW);
    expect(v.label).not.toBe("Connected");
    expect(v.lastHeartbeat).toBe("Not reported");
  });

  it("a fresh heartbeat is Connected", () => {
    const v = describeBridgeHeartbeat({ ...BASE, lastHeartbeatAt: new Date(NOW - 4_000).toISOString(), heartbeatFreshness: "fresh" }, NOW);
    expect(v.state).toBe("connected");
    expect(v.label).toBe("Connected");
  });

  it("the client only downgrades: a 'fresh' claim about a heartbeat now 90 s old is offline", () => {
    const v = describeBridgeHeartbeat({ ...BASE, lastHeartbeatAt: new Date(NOW - 90_000).toISOString(), heartbeatFreshness: "fresh" }, NOW);
    expect(v.state).toBe("offline");
  });
});

describe("MT5 Setup header", () => {
  let conn: Conn;
  beforeEach(() => {
    conn = {
      ...BASE,
      lastCheckedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date(Date.now() - 50_000).toISOString(),
      heartbeatAgeSeconds: 50,
      heartbeatFreshness: "degraded",
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/broker/connection-check")) {
        return { ok: true, status: 200, json: async () => conn } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("shows the EA heartbeat time under 'Last heartbeat' and does not say 'Connected' for a 50 s old heartbeat", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MT5SetupWizardPage /></QueryClientProvider>);
    await vi.waitFor(() => expect(screen.getByTestId("bridge-heartbeat-state").textContent).toMatch(/delayed/i));
    expect(screen.getByTestId("bridge-heartbeat-state").textContent).not.toMatch(/^\s*Connected\s*$/);
    const last = screen.getByTestId("bridge-last-heartbeat").textContent ?? "";
    expect(last).toContain(new Date(conn.lastHeartbeatAt!).toLocaleTimeString());
    expect(last).not.toBe(new Date(conn.lastCheckedAt).toLocaleTimeString());
  });
});
