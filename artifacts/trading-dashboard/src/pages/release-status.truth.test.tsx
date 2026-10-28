// Release Status truth: an unchecked gate renders NOT CHECKED (never PASS),
// the "MT5 deferred" pill reads NO when the readiness check observed the MT5
// feed connected, and the version time is labelled as the server start time.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import ReleaseStatus from "./release-status";

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Release Status truth", () => {
  it("shows NOT CHECKED for unmeasured gates and downgrades MT5 deferred when MT5 is connected", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/release/version")) {
        return json({
          version: "0.9.0-beta", stage: "BETA_TESTER", fullTesterAccess: true, mt5Deferred: true,
          realBrokerExecutionAvailable: false, lastUpdated: "2026-10-28T00:00:00.000Z", lastUpdatedBasis: "server_start",
        });
      }
      return json({
        releaseReady: false, readinessScore: 70, stage: "BETA_TESTER", mt5Deferred: true, mt5Connected: true,
        evaluatedAt: "2026-10-28T01:00:00.000Z", criticalIssues: [],
        gates: [
          { key: "route_health", label: "Route health", pass: false, measured: false, detail: "Not checked — no check runs behind this gate yet." },
          { key: "oms_pass", label: "OMS pass", pass: true, measured: true },
        ],
      });
    }));
    render(<ReleaseStatus />);
    await waitFor(() => expect(screen.getByTestId("release-gates")).toBeTruthy());
    const gates = screen.getByTestId("release-gates");
    expect(gates.textContent).toContain("NOT CHECKED");
    expect(gates.textContent).toContain("PASS: OK");
    expect(gates.textContent).not.toMatch(/Route health\s*PASS/);
    await waitFor(() => expect(screen.getByText(/MT5 deferred: NO/)).toBeTruthy());
    expect(screen.getByTestId("release-version-time").textContent).toMatch(/^Server started /);
  });
});
