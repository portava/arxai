/**
 * Status Command Center truth: rows must describe what was actually read.
 *
 * - Emergency Stop: no source on this page reports the platform emergency
 *   stop / kill switch, so the row must not read a measured "off".
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { collectRuntimeContext } from "@/assistant/runtimeContext";
import type { BridgeDiagnosticSummary, RuntimeContext } from "@/assistant/runtimeContextTypes";
import { buildSetupWizard } from "@/statusCommand/setupWizard";

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
