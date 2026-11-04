// System Health page labels state what was measured (downgrade-only).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import SystemHealthPage, { overallLabel, redactionLabel, subsystemBadgeLabel } from "./system-health";

function report(over: Record<string, unknown> = {}) {
  return {
    health_check_id: "hc_1", generated_at: new Date().toISOString(),
    overallStatus: "DEGRADED", liveTradingStatus: "DISABLED", mode: "PAPER_ONLY",
    subsystemStatus: {
      BB: { status: "OK", checkScope: "REACHABILITY_ONLY", notes: ["/api/post-trade-debriefs answered HTTP 200 (reachability only; service health not checked)"] },
      DD: { status: "OK", checkScope: "IN_PROCESS", notes: ["market data active provider: x (y) — read-only"] },
    },
    databaseStatus: { connected: false, missingTables: [], rowCounts: {} },
    endpointStatus: { totalChecked: 0, passed: 0, failed: 0, degraded: 0, results: [] },
    safetyStatus: { hardBlocks: [], warnings: [] },
    secretSafetyStatus: { secretsDetectedInFrontend: 0, secretsDetectedInLogs: 0, redactionWorking: false, scanChecked: false },
    performanceStatus: { failedJobs: 0, errorRate: 0, latestNotificationCriticalCount: null },
    recommendedAdminActions: [], warnings: [], errors: [],
    ...over,
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("System Health labels", () => {
  it("a reachability-only OK reads 'Reachable'; an in-process OK stays OK", () => {
    expect(subsystemBadgeLabel({ status: "OK", checkScope: "REACHABILITY_ONLY" })).toBe("Reachable");
    expect(subsystemBadgeLabel({ status: "OK", checkScope: "IN_PROCESS" })).toBe("OK");
    expect(subsystemBadgeLabel({ status: "DEGRADED", checkScope: "REACHABILITY_ONLY" })).toBe("DEGRADED");
  });

  it("an unchecked secret scan never reads as working", () => {
    expect(redactionLabel({ secretsDetectedInFrontend: 0, secretsDetectedInLogs: 0, redactionWorking: true })).toMatch(/not checked/);
    expect(redactionLabel({ secretsDetectedInFrontend: 0, secretsDetectedInLogs: 0, redactionWorking: false, scanChecked: false })).toMatch(/not checked/);
    expect(redactionLabel({ secretsDetectedInFrontend: 0, secretsDetectedInLogs: 0, redactionWorking: true, scanChecked: true })).toBe("no secret-shaped strings found");
  });

  it("the page shows 'Reachable', 'not checked' and never 'Working: true' for an unchecked scan", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ report: report() }), { status: 200 })));
    render(<SystemHealthPage />);
    await waitFor(() => expect(screen.getByTestId("subsystem-BB")).toBeTruthy());
    expect(screen.getByTestId("subsystem-BB").textContent).toContain("Reachable");
    expect(screen.getByTestId("subsystem-DD").textContent).toContain("OK");
    expect(screen.getByTestId("text-redaction-status").textContent).toContain("not checked");
    expect(screen.getByTestId("page-system-health").textContent).not.toContain("Working: true");
  });

  it("HEALTHY over reachability-only subsystems is not shown as HEALTHY", async () => {
    const r = report({ overallStatus: "HEALTHY" });
    expect(overallLabel(r as never)).toEqual({
      label: "No problems found",
      note: "1 of 2 subsystems (BB) were only checked for reachability; their service health was not checked.",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ report: r }), { status: 200 })));
    render(<SystemHealthPage />);
    await waitFor(() => expect(screen.getByTestId("system-health-overall")).toBeTruthy());
    const overall = screen.getByTestId("system-health-overall").textContent ?? "";
    expect(overall).not.toContain("HEALTHY");
    expect(overall).toContain("No problems found");
    expect(overall).toContain("service health was not checked");
  });

  it("HEALTHY with every OK measured in process stays HEALTHY; other verdicts pass through", () => {
    const measured = { DD: { status: "OK", checkScope: "IN_PROCESS" as const, notes: [] } };
    expect(overallLabel({ overallStatus: "HEALTHY", subsystemStatus: measured })).toEqual({ label: "HEALTHY", note: null });
    expect(overallLabel({ overallStatus: "DEGRADED", subsystemStatus: measured }).label).toBe("DEGRADED");
  });
});
