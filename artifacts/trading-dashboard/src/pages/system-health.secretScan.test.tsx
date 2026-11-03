// Regression: when a secret-scan count query failed, the report coerced its
// count to 0 and the page showed "Frontend leaks: 0 / Log leaks: 0" beside
// "Scan: not checked". A count is shown only for a half that was checked.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import SystemHealthPage, { leakCountLabel } from "./system-health";

function report(secretSafetyStatus: Record<string, unknown>) {
  return {
    health_check_id: "hc_1", generated_at: new Date().toISOString(),
    overallStatus: "DEGRADED", liveTradingStatus: "DISABLED", mode: "PAPER_ONLY",
    subsystemStatus: {},
    databaseStatus: { connected: true, missingTables: [], rowCounts: {} },
    endpointStatus: { totalChecked: 0, passed: 0, failed: 0, degraded: 0, results: [] },
    safetyStatus: { hardBlocks: [], warnings: [] },
    secretSafetyStatus,
    performanceStatus: { failedJobs: 0, errorRate: 0, latestNotificationCriticalCount: null },
    recommendedAdminActions: [], warnings: [], errors: [],
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function show(secretSafetyStatus: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ report: report(secretSafetyStatus) }), { status: 200 })));
  render(<SystemHealthPage />);
  await waitFor(() => expect(screen.getByTestId("text-redaction-status")).toBeTruthy());
  return {
    frontend: screen.getByTestId("text-leaks-frontend").textContent ?? "",
    logs: screen.getByTestId("text-leaks-logs").textContent ?? "",
  };
}

describe("secret-scan counts are shown only for a half that ran", () => {
  it("a scan that did not run shows no 0 counts", async () => {
    const r = await show({ secretsDetectedInFrontend: 0, secretsDetectedInLogs: 0, redactionWorking: false, scanChecked: false });
    expect(r.frontend).not.toMatch(/: 0$/);
    expect(r.frontend).toMatch(/not checked/);
    expect(r.logs).toMatch(/not checked/);
  });

  it("one half failed: the other half's real count is shown, the failed half is not checked", async () => {
    const r = await show({ secretsDetectedInFrontend: 0, secretsDetectedInLogs: 0, redactionWorking: false, scanChecked: false, frontendScanChecked: true, logScanChecked: false });
    expect(r.frontend).toMatch(/Frontend leaks: 0$/);
    expect(r.logs).toMatch(/not checked/);
  });

  it("a fully checked scan shows both counts", async () => {
    const r = await show({ secretsDetectedInFrontend: 0, secretsDetectedInLogs: 3, redactionWorking: false, scanChecked: true, frontendScanChecked: true, logScanChecked: true });
    expect(r.frontend).toMatch(/Frontend leaks: 0$/);
    expect(r.logs).toMatch(/Log leaks: 3$/);
  });

  it("an older report without per-half flags falls back to the summary flag", () => {
    expect(leakCountLabel({ secretsDetectedInFrontend: 0, secretsDetectedInLogs: 0, redactionWorking: true, scanChecked: true }, "frontend")).toBe("0");
    expect(leakCountLabel({ secretsDetectedInFrontend: 0, secretsDetectedInLogs: 0, redactionWorking: false }, "logs")).toMatch(/not checked/);
  });
});
