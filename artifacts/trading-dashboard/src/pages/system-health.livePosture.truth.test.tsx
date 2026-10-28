// System Health's subtitle said "This report does not read live-trading
// state" and the Live trading card always read "Not checked by this report",
// although the health report now carries livePosture: the platform's
// live-execution switch as read for the report (ON / OFF / UNKNOWN). The
// page now shows that reading and its plain-English sentence, and says the
// health checks cover the paper stack. A failed check request reads "could
// not be loaded", never an empty page.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import SystemHealthPage, { livePostureBadge } from "./system-health";

function report(over: Record<string, unknown> = {}) {
  return {
    health_check_id: "hc_1", generated_at: "2026-10-28T11:40:00.000Z",
    overallStatus: "HEALTHY", liveTradingStatus: "DISABLED", mode: "PAPER_ONLY",
    subsystemStatus: {},
    databaseStatus: { connected: true, missingTables: [], rowCounts: {} },
    endpointStatus: { totalChecked: 0, passed: 0, failed: 0, degraded: 0, results: [] },
    safetyStatus: { hardBlocks: [], warnings: [] },
    secretSafetyStatus: { secretsDetectedInFrontend: 0, secretsDetectedInLogs: 0, redactionWorking: true, scanChecked: true },
    performanceStatus: { failedJobs: 0, errorRate: 0, latestNotificationCriticalCount: 0 },
    recommendedAdminActions: [], warnings: [], errors: [],
    ...over,
  };
}

const ON = {
  state: "ON",
  plainEnglish: "Live broker execution is switched on for the platform (server setting on, operator arm on; checked 11:40 UTC). An account sends live orders only when it is armed and every server check passes.",
  source: "Platform live-execution switch", checkedAt: "2026-10-28T11:40:00.000Z",
};
const UNKNOWN = {
  state: "UNKNOWN",
  plainEnglish: "The platform's live-execution switch could not be read (tried 11:40 UTC), so it is unknown whether live orders can be sent. Order checks treat an unreadable switch as off.",
  source: "Platform live-execution switch", checkedAt: "2026-10-28T11:40:00.000Z",
};

function stub(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("System Health — live posture and subtitle", () => {
  it("shows the platform switch the report read, not 'does not read live-trading state'", async () => {
    stub(200, { report: report({ livePosture: ON }) });
    render(<SystemHealthPage />);
    await waitFor(() => expect(screen.getByTestId("system-health-live-trading")).toBeTruthy());
    expect(screen.getByTestId("system-health-live-trading").textContent).toMatch(/switched on for the platform/i);
    expect(screen.getByTestId("system-health-live-posture").textContent).toContain(ON.plainEnglish);
    const page = screen.getByTestId("page-system-health").textContent ?? "";
    expect(page).not.toMatch(/does not read live-trading state/i);
    expect(page).not.toMatch(/Not checked by this report/);
    expect(screen.getByTestId("system-health-subtitle").textContent).toMatch(/health checks cover the paper stack/);
    expect(screen.getByTestId("system-health-generated-at").textContent).toContain("2026-10-28 11:40:00 UTC");
  });

  it("an unreadable switch reads Unknown, never off", async () => {
    stub(200, { report: report({ livePosture: UNKNOWN }) });
    render(<SystemHealthPage />);
    await waitFor(() => expect(screen.getByTestId("system-health-live-trading")).toBeTruthy());
    expect(screen.getByTestId("system-health-live-trading").textContent).toMatch(/Unknown/);
    expect(screen.getByTestId("system-health-live-trading").textContent).not.toMatch(/off|DISABLED/i);
    expect(screen.getByTestId("system-health-live-posture").textContent).toMatch(/could not be read/);
  });

  it("without livePosture (older server) the card still says the report did not check it", () => {
    expect(livePostureBadge(undefined).label).toBe("Not checked by this report");
  });

  it("a failed check request says 'could not be loaded', not an empty page", async () => {
    stub(500, { error: "health check failed" });
    render(<SystemHealthPage />);
    await waitFor(() => expect(screen.getByTestId("page-system-health").textContent).toMatch(/could not be loaded/));
    expect(screen.getByTestId("page-system-health").textContent).toMatch(/HTTP 500/);
  });
});
