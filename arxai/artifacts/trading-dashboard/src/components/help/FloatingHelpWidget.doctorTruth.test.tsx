// Regression: the help widget's App Doctor view (on every page) rendered
// explainAppStatus() under fixed labels. /api/mt5/diagnostic-summary says its
// live / execution / read-only flags are fixed values it did not read
// (executionPostureMeasured=false), so the "cannot do" list only fails closed
// on unread flags. The widget still printed "Cannot do: Send real broker
// orders" to an armed LIVE_SHARED trader, put "Why live trading is
// unavailable:" above "cannot say whether live trading is available", and,
// with the user's own EA connected, said "everything is operating in the
// expected safe mode" although it never read the execution gates.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { collectRuntimeContext } from "@/assistant/runtimeContext";
import type { BridgeDiagnosticSummary } from "@/assistant/runtimeContextTypes";
import { DoctorView } from "./FloatingHelpWidget";

const unmeasured: BridgeDiagnosticSummary = {
  bridgeMode: "connected",
  heartbeatPresent: true,
  heartbeatScope: "your_connection",
  lastHeartbeatAt: "2026-10-28T14:05:00.000Z",
  heartbeatAgeSeconds: 3,
  brokerExecutionEnabled: false,
  brokerReadOnly: true,
  liveTradingEnabled: false,
  paperOnly: false,
  executionPostureMeasured: false,
  executionPostureNote: "These flags are fixed values in this summary; it does not read the live-trading master switch, live arming or your account mode.",
  safestNextStep: "Continue.",
  reason: "EA connected.",
  fetchedAt: "2026-10-28T14:05:03.000Z",
};

afterEach(() => cleanup());

function renderDoctor(bridge: BridgeDiagnosticSummary | null, bridgeStatus?: "loading" | "unavailable") {
  const ctx = collectRuntimeContext({ route: "/dashboard", bridge, ...(bridgeStatus ? { bridgeStatus } : {}) });
  render(<DoctorView runtimeCtx={ctx} onBack={() => {}} onNavigate={() => {}} />);
  return screen.getByTestId("doctor-view").textContent ?? "";
}

describe("App Doctor help view does not assert a posture it did not read", () => {
  it("labels the fail-closed list as not confirmed when the summary did not read the gates", () => {
    const text = renderDoctor(unmeasured);
    expect(text).not.toMatch(/Cannot do:/);
    expect(text).toMatch(/Not confirmed by this view \(it does not read the execution gates\):/);
    expect(text).not.toMatch(/Why live trading is unavailable/);
    expect(text).toMatch(/Live trading availability:/);
    expect(text).toMatch(/cannot say whether live trading is available/);
  });

  it("an empty diagnosis does not claim the app is in the expected safe mode", () => {
    const text = renderDoctor(unmeasured);
    expect(screen.queryByTestId("doctor-primary")).toBeNull();
    expect(text).not.toMatch(/expected safe mode/i);
    expect(text).toMatch(/No issues found in what this view reads/);
    expect(text).toMatch(/does not read the execution gates or your account mode/);
  });

  it("an unloaded or failed summary is not shown as 'cannot do'", () => {
    expect(renderDoctor(null, "loading")).toMatch(/Not confirmed yet \(the bridge summary is still loading\):/);
    cleanup();
    const failed = renderDoctor(null, "unavailable");
    expect(failed).not.toMatch(/Cannot do:/);
    expect(failed).toMatch(/Not confirmed by this view \(the bridge summary could not be loaded\):/);
  });

  it("a summary that read the flags keeps 'Cannot do'", () => {
    const { executionPostureMeasured: _m, executionPostureNote: _n, ...legacy } = unmeasured;
    const text = renderDoctor(legacy as BridgeDiagnosticSummary);
    expect(text).toMatch(/Cannot do:.*Send real broker orders/);
  });
});
