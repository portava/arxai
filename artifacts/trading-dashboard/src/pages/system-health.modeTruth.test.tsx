// Regression: System Health printed "(PAPER_ONLY, live trading DISABLED)" in
// its header as a literal, and the "Live trading" / "Mode" cards echoed the
// report's constant liveTradingStatus:"DISABLED" / mode:"PAPER_ONLY"
// (lib/systemHealth/health.ts sets them on every path). The report never
// reads live-trading state; probeSafety even warns
// "safetyCore.operationalMode=LIVE_TRADING" when the safety core is not in a
// paper mode, yet the page still said PAPER_ONLY / DISABLED.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const { default: SystemHealthPage } = await import("./system-health");

function report(warnings: string[]) {
  return {
    health_check_id: "h1", generated_at: "2026-10-28T05:00:00.000Z",
    overallStatus: "DEGRADED", liveTradingStatus: "DISABLED", mode: "PAPER_ONLY",
    subsystemStatus: {},
    databaseStatus: { connected: true, missingTables: [], rowCounts: {} },
    endpointStatus: { totalChecked: 0, passed: 0, failed: 0, degraded: 0, results: [] },
    safetyStatus: { hardBlocks: [], warnings },
    secretSafetyStatus: { secretsDetectedInFrontend: 0, secretsDetectedInLogs: 0, redactionWorking: true },
    performanceStatus: { failedJobs: 0, errorRate: 0, latestNotificationCriticalCount: 0 },
    recommendedAdminActions: [], warnings, errors: [],
  };
}

function stubFetch(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ report: body }) })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("system health mode truth", () => {
  it("does not claim PAPER_ONLY / live trading DISABLED when the safety core reports LIVE_TRADING", async () => {
    stubFetch(report(["safetyCore.operationalMode=LIVE_TRADING"]));
    render(<SystemHealthPage />);
    await waitFor(() => expect(screen.getByTestId("system-health-mode")).toBeTruthy());
    const page = screen.getByTestId("page-system-health").textContent ?? "";
    expect(page).not.toMatch(/live trading DISABLED/i);
    expect(screen.getByTestId("system-health-live-trading").textContent).not.toMatch(/^DISABLED$/);
    expect(screen.getByTestId("system-health-mode").textContent).toMatch(/LIVE_TRADING/);
  });

  it("never states live trading as DISABLED, since the report does not read live state", async () => {
    stubFetch(report([]));
    render(<SystemHealthPage />);
    await waitFor(() => expect(screen.getByTestId("system-health-live-trading")).toBeTruthy());
    expect(screen.getByTestId("system-health-live-trading").textContent).toMatch(/not checked/i);
    expect(screen.getByTestId("page-system-health").textContent).not.toMatch(/live trading DISABLED/i);
  });
});
