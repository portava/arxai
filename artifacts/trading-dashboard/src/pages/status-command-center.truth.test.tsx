/**
 * Status Command Center truth: rows must describe what was actually read.
 *
 * - Emergency Stop: no source on this page reports the platform emergency
 *   stop / kill switch, so the row must not read a measured "off".
 * - A failed /api/mt5/diagnostic-summary read is "unknown", never the
 *   default safe posture (live disabled, demo-only, read-only) with full marks.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within, renderHook, waitFor, act } from "@testing-library/react";
import { collectRuntimeContext } from "@/assistant/runtimeContext";
import type { BridgeDiagnosticSummary, RuntimeContext } from "@/assistant/runtimeContextTypes";
import { buildSetupWizard } from "@/statusCommand/setupWizard";
import { computeReadinessScore } from "@/statusCommand/readinessScore";

const holder: { ctx: RuntimeContext | null } = { ctx: null };

vi.mock("@/assistant/useRuntimeContext", () => ({
  useRuntimeContext: () => holder.ctx,
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ isLoading: true, envelope: null, isLiveShared: false, cleanModeLabel: "", cleanBlockedReason: null, cleanUserMessage: "" }),
}));

import StatusCommandCenter from "./status-command-center";

const connectedBridge: BridgeDiagnosticSummary = {
  bridgeMode: "connected",
  heartbeatPresent: true,
  lastHeartbeatAt: "2026-10-28T10:00:00.000Z",
  heartbeatAgeSeconds: 3,
  brokerExecutionEnabled: false,
  brokerReadOnly: true,
  liveTradingEnabled: false,
  paperOnly: false,
  safestNextStep: "Stay read-only.",
  reason: "Bridge is connected.",
  fetchedAt: "2026-10-28T10:00:03.000Z",
};

afterEach(() => { cleanup(); holder.ctx = null; });

function runtimeRow(label: string): string {
  const card = screen.getByTestId("scc-runtime-card");
  const dt = within(card).getByText(label);
  return (dt.nextElementSibling as HTMLElement).textContent ?? "";
}

describe("Emergency Stop is not a measured 'off'", () => {
  it("runtime context does not claim the emergency stop is off when no source reported it", () => {
    const ctx = collectRuntimeContext({ route: "/status-command-center", bridge: connectedBridge });
    expect(ctx.emergencyStopActive).not.toBe(false);
    expect(ctx.emergencyStopActive).toBeNull();
  });

  it("setup wizard does not say 'Emergency Stop not engaged.' without a reading", () => {
    const ctx = collectRuntimeContext({ route: "/status-command-center", bridge: connectedBridge });
    const step = buildSetupWizard(ctx).find((s) => s.id === "wz-emergency")!;
    expect(step.statusText).not.toMatch(/not engaged/i);
    expect(step.statusText).toMatch(/not read|not checked/i);
  });

  it("Runtime Status row does not read 'off' when the emergency stop was never read", () => {
    holder.ctx = collectRuntimeContext({ route: "/status-command-center", bridge: connectedBridge });
    render(<StatusCommandCenter />);
    const v = runtimeRow("Emergency Stop");
    expect(v).not.toBe("off");
    expect(v).toMatch(/not checked/i);
  });

  it("still renders ENGAGED when a source reports it", () => {
    holder.ctx = { ...collectRuntimeContext({ route: "/status-command-center", bridge: connectedBridge }), emergencyStopActive: true };
    render(<StatusCommandCenter />);
    expect(runtimeRow("Emergency Stop")).toBe("ENGAGED");
    expect(screen.getByTestId("scc-blocker-emergency-stop")).toBeTruthy();
  });
});

describe("failed diagnostic fetch is unknown, not a default safe posture", () => {
  it("runtime context reports unknown posture fields when no bridge summary was read", () => {
    const ctx = collectRuntimeContext({ route: "/status-command-center", bridge: undefined });
    expect(ctx.liveTradingDisabled).toBeNull();
    expect(ctx.brokerExecutionDisabled).toBeNull();
    expect(ctx.brokerReadOnly).toBeNull();
    expect(ctx.paperOnly).toBeNull();
    expect(ctx.simulatorMode).toBeNull();
    expect(ctx.heartbeatPresent).toBeNull();
    expect(ctx.tradingMode).toBe("unknown");
    expect(ctx.activeSafetyLocks).not.toContain("LIVE TRADING DISABLED");
    expect(ctx.bridgeStatus).toBe("unavailable");
  });

  it("readiness score awards no points for unread safety locks, demo mode, heartbeat or broker mode", () => {
    const ctx = collectRuntimeContext({ route: "/status-command-center", bridge: null, bridgeStatus: "unavailable" });
    const score = computeReadinessScore(ctx, []);
    for (const id of ["safety-locks", "paper-simulator", "heartbeat", "broker-mode"] as const) {
      const s = score.sections.find((x) => x.id === id)!;
      expect(s.score, id).toBe(0);
      expect(s.level, id).toBe("unavailable");
    }
    expect(score.liveUnavailableReason).toMatch(/could not be read/i);
  });

  it("Status Command Center shows unknown rows and a fetch-failure disclosure", () => {
    holder.ctx = collectRuntimeContext({ route: "/status-command-center", bridge: null, bridgeStatus: "unavailable" });
    render(<StatusCommandCenter />);
    expect(runtimeRow("Live trading disabled")).toBe("unknown");
    expect(runtimeRow("Demo-only")).toBe("unknown");
    expect(runtimeRow("Broker read-only")).toBe("unknown");
    // heartbeatLine names why the row is unknown: the summary was never read.
    expect(runtimeRow("Heartbeat")).toBe("not checked — bridge summary unavailable");
    expect(runtimeRow("Heartbeat")).not.toMatch(/^(present|absent|none)\b/);
    expect(runtimeRow("Server posture")).toMatch(/could not be read/i);
    expect(screen.getByTestId("scc-blocker-posture-unknown")).toBeTruthy();
    expect(screen.queryByTestId("scc-blocker-live-trading-disabled")).toBeNull();
    // The bridge was never read, so the checklist must not say it is offline.
    expect(screen.queryByText(/Bridge is offline/i)).toBeNull();
  });

  it("useRuntimeContext drops the previous bridge summary when a later fetch fails", async () => {
    vi.doUnmock("@/assistant/useRuntimeContext");
    const { useRuntimeContext } = await vi.importActual<typeof import("@/assistant/useRuntimeContext")>("@/assistant/useRuntimeContext");
    let fail = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (fail) throw new Error("network down");
      const body = String(url).includes("diagnostic-summary") ? connectedBridge : null;
      return new Response(JSON.stringify(body), { status: body ? 200 : 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { result } = renderHook(() => useRuntimeContext());
      await waitFor(() => expect(result.current.bridgeStatus).toBe("loaded"));
      expect(result.current.liveTradingDisabled).toBe(true);
      fail = true;
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      await waitFor(() => expect(result.current.bridgeStatus).toBe("unavailable"));
      expect(result.current.bridge).toBeNull();
      expect(result.current.liveTradingDisabled).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
