// Regression: /api/mt5/diagnostic-summary hard-codes liveTradingEnabled=false,
// brokerExecutionEnabled=false and brokerReadOnly=true for every caller, and
// derives paperOnly only from the caller's own EA bridge. It never reads the
// live master switch, live arming or the account mode. The Status Command
// Center showed those constants as a timestamped server reading ("Server
// posture: read from … at 14:05:03", "Live trading disabled: true", a "Live
// Trading Disabled" blocker card, Safety Locks 10/10 "active and working as
// intended") next to an armed LIVE account mode on the same page.
//
// The summary now says executionPostureMeasured=false. The page must not show
// those flags as readings, award points for them, or raise blockers from them.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { collectRuntimeContext } from "@/assistant/runtimeContext";
import { computeReadinessScore } from "@/statusCommand/readinessScore";
import { buildSetupWizard } from "@/statusCommand/setupWizard";
import { explainAppStatus, diagnose } from "@/assistant/appDoctor";
import type { BridgeDiagnosticSummary, RuntimeContext } from "@/assistant/runtimeContextTypes";

const holder: { ctx: RuntimeContext | null } = { ctx: null };
vi.mock("@/assistant/useRuntimeContext", () => ({ useRuntimeContext: () => holder.ctx }));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({
    isLoading: false, isError: false, isLiveShared: true, isLiveArmed: true,
    envelope: { currentAccountMode: "LIVE_SHARED", liveExecutionArmed: true, cleanModeLabel: "LIVE · Shared Master MT5" },
    cleanModeLabel: "LIVE · Shared Master MT5", cleanBlockedReason: null, cleanUserMessage: "Armed for live.",
  }),
}));

import StatusCommandCenter from "./status-command-center";

// The only shape the server can return: fixed flags, flagged as not measured.
const serverSummary: BridgeDiagnosticSummary = {
  bridgeMode: "deferred",
  heartbeatPresent: false,
  heartbeatScope: "no_connection",
  lastHeartbeatAt: null,
  heartbeatAgeSeconds: null,
  brokerExecutionEnabled: false,
  brokerReadOnly: true,
  liveTradingEnabled: false,
  paperOnly: true,
  executionPostureMeasured: false,
  executionPostureNote: "These flags are fixed values in this summary; it does not read the live-trading master switch, live arming or your account mode.",
  safestNextStep: "Continue.",
  reason: "No bridge token.",
  fetchedAt: "2026-10-28T14:05:03.000Z",
};

afterEach(() => { cleanup(); holder.ctx = null; });

function runtimeRow(label: string): string {
  const card = screen.getByTestId("scc-runtime-card");
  const dt = within(card).getByText(label);
  return (dt.nextElementSibling as HTMLElement).textContent ?? "";
}

describe("fixed diagnostic-summary posture is not shown as a reading", () => {
  it("runtime context does not turn the fixed flags into measured locks", () => {
    const ctx = collectRuntimeContext({ route: "/status-command-center", bridge: serverSummary });
    expect(ctx.executionPostureUnmeasured).toBe(true);
    expect(ctx.liveTradingDisabled).toBeNull();
    expect(ctx.brokerExecutionDisabled).toBeNull();
    expect(ctx.brokerReadOnly).toBeNull();
    expect(ctx.paperOnly).toBeNull();
    expect(ctx.simulatorMode).toBeNull();
    expect(ctx.tradingMode).toBe("unknown");
    expect(ctx.activeSafetyLocks).not.toContain("LIVE TRADING DISABLED");
    expect(ctx.activeSafetyLocks).not.toContain("BROKER READ-ONLY");
    expect(ctx.activeSafetyLocks).not.toContain("DEMO ONLY");
    // The bridge itself was read: its own state is still reported.
    expect(ctx.mt5Deferred).toBe(true);
    expect(ctx.heartbeatPresent).toBe(false);
  });

  it("the page does not say live trading is disabled next to an armed LIVE account mode", () => {
    holder.ctx = collectRuntimeContext({ route: "/status-command-center", bridge: serverSummary });
    render(<StatusCommandCenter />);
    expect(within(screen.getByTestId("scc-runtime-card")).getByTestId("scc-runtime-mode").textContent).toMatch(/LIVE/);
    for (const label of ["Live trading disabled", "Broker exec disabled", "Broker read-only", "Demo-only", "Simulator"]) {
      const v = runtimeRow(label);
      expect(v, label).not.toMatch(/^(true|false)$/);
      expect(v, label).toMatch(/not read/i);
    }
    // The posture line names what was read and what was not.
    const src = runtimeRow("Server posture");
    expect(src).toMatch(/does not read/i);
    expect(src).toMatch(/account mode/i);
    expect(screen.queryByTestId("scc-blocker-live-trading-disabled")).toBeNull();
    expect(screen.queryByTestId("scc-blocker-broker-execution-disabled")).toBeNull();
    expect(screen.queryByTestId("scc-blocker-simulator-mode")).toBeNull();
    expect(screen.getByTestId("scc-readiness-section-safety-locks").textContent).not.toMatch(/working as intended/i);
    // No "ARX is in simulator mode" claim from the fix-first block either.
    expect(screen.getByTestId("status-command-center").textContent).not.toMatch(/ARX is in simulator mode/i);
  });

  it("readiness awards no points for flags the summary did not read, and says why", () => {
    const ctx = collectRuntimeContext({ route: "/status-command-center", bridge: serverSummary });
    const score = computeReadinessScore(ctx, []);
    for (const id of ["safety-locks", "paper-simulator", "broker-mode"] as const) {
      const s = score.sections.find((x) => x.id === id)!;
      expect(s.score, id).toBe(0);
      expect(s.level, id).toBe("unavailable");
      expect(s.summary, id).toMatch(/not read/i);
      expect(s.summary, id).not.toMatch(/could not be read from the server/i);
    }
  });

  it("wizard, assistant status and diagnoses do not assert the fixed posture", () => {
    const ctx = collectRuntimeContext({ route: "/status-command-center", bridge: serverSummary });
    const wz = buildSetupWizard(ctx);
    expect(wz.find((s) => s.id === "wz-locks")!.statusText).toMatch(/not read/i);
    expect(wz.find((s) => s.id === "wz-broker-mode")!.statusText).toMatch(/not read/i);
    expect(wz.find((s) => s.id === "wz-demo-sim")!.statusText).toMatch(/not read/i);
    const st = explainAppStatus(ctx);
    expect(st.whyLiveUnavailable).not.toMatch(/all gates appear green/i);
    const ids = diagnose(ctx).map((d) => d.id);
    expect(ids).not.toContain("doc-live-trading-disabled");
    expect(ids).not.toContain("doc-simulator-mode");
    for (const d of diagnose(ctx)) expect(d.explanation).not.toMatch(/ARX is in simulator mode/i);
  });

  it("a summary without the marker keeps its existing reading", () => {
    const { executionPostureMeasured: _m, executionPostureNote: _n, ...legacy } = serverSummary;
    const ctx = collectRuntimeContext({ route: "/status-command-center", bridge: legacy as BridgeDiagnosticSummary });
    expect(ctx.executionPostureUnmeasured).toBe(false);
    expect(ctx.liveTradingDisabled).toBe(true);
    expect(ctx.brokerReadOnly).toBe(true);
  });
});
