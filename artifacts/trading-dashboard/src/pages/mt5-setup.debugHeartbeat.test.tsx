// MT5 Setup "Demo Bridge Debug": the "(fresh)" label follows the shared
// heartbeat policy's fresh band (the same one /mt5/status uses), not the
// server's legacy 60 s presence flag `heartbeatFresh`. A 40 s old heartbeat
// is delayed, not fresh.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { default: MT5SetupWizardPage, describeDebugHeartbeat } = await import("./mt5-setup");

function debugBody(ageSeconds: number | null, heartbeatFresh: boolean) {
  return {
    ok: true,
    bridge: {
      connectionId: 7, accountLoginMasked: "****1234", accountType: "DEMO", eaVersionReported: "1.30",
      lastHeartbeatAt: ageSeconds == null ? null : new Date(Date.now() - ageSeconds * 1000).toISOString(),
      heartbeatAgeSeconds: ageSeconds, heartbeatFresh,
    },
    demoConsumer: {
      eaDemoConsumerActive: false, lastPollAt: null, lastPollAgeSeconds: null, lastPollOutcome: null,
      lastPollServedCount: null, lastDispatchSentAt: null, lastResultAt: null, lastResultOutcome: null, lastResultMessage: null,
    },
    pending: { sentToMt5DemoCount: 0, pickupableByCurrentBridge: 0, orphanedFromPreviousBridge: 0, orphanedCommandIds: [], oldestSentAt: null },
    lastTerminalCommand: null,
    diagnoses: [],
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("describeDebugHeartbeat", () => {
  it("40 s old with the legacy 60 s flag true is delayed, not fresh", () => {
    const v = describeDebugHeartbeat({ heartbeatAgeSeconds: 40, heartbeatFresh: true });
    expect(v.label).not.toBe("fresh");
    expect(v.label).toBe("delayed");
  });
  it("4 s old is fresh", () => {
    expect(describeDebugHeartbeat({ heartbeatAgeSeconds: 4, heartbeatFresh: true }).label).toBe("fresh");
  });
  it("the client only downgrades: server says not fresh at 4 s → not fresh", () => {
    expect(describeDebugHeartbeat({ heartbeatAgeSeconds: 4, heartbeatFresh: false }).label).not.toBe("fresh");
  });
  it("no heartbeat age is not fresh", () => {
    expect(describeDebugHeartbeat({ heartbeatAgeSeconds: null, heartbeatFresh: true }).label).not.toBe("fresh");
  });
});

describe("Demo Bridge Debug card", () => {
  it("shows a 40 s old heartbeat as delayed, not '(fresh)'", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/me/demo-bridge-debug")) {
        return { ok: true, status: 200, json: async () => debugBody(40, true) } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MT5SetupWizardPage /></QueryClientProvider>);
    const hb = await screen.findByTestId("dbg-heartbeat");
    expect(hb.textContent).toContain("40s ago");
    expect(hb.textContent).not.toContain("(fresh)");
    expect(hb.textContent).toContain("(delayed)");
  });
});
