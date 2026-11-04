// Admin Diagnostics Export: a failed /api/export/diagnostics response is an
// error, not a "Package" whose fields are the error body, and it cannot be
// downloaded as a diagnostics package.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/admin/WorkflowHealthCard", () => ({ WorkflowHealthCard: () => null }));
vi.mock("@/components/admin/ChartTruthHealthCard", () => ({ ChartTruthHealthCard: () => null }));
vi.mock("@/components/admin/CandleDepthDiagnosticsCard", () => ({ CandleDepthDiagnosticsCard: () => null }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/lib/perf", () => ({ setPerfTransportEnabled: () => {} }));

const { default: AdminDiagnostics } = await import("./admin-diagnostics");

function stubFetch(diagStatus: number, diagBody: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/export/diagnostics")) {
      return { ok: diagStatus >= 200 && diagStatus < 300, status: diagStatus, json: async () => diagBody };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Admin Diagnostics Export", () => {
  it("a 500 shows an error and no package", async () => {
    stubFetch(500, { error: "x" });
    render(<AdminDiagnostics />);
    await waitFor(() => expect(screen.getByTestId("diag-error")).toBeTruthy());
    expect(screen.getByTestId("diag-error").textContent).toMatch(/HTTP 500/);
    expect(screen.getByTestId("diag-error").textContent).toContain("x");
    expect(screen.queryByText("Package")).toBeNull();
    expect((screen.getByTestId("diag-download") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a 200 still shows the package", async () => {
    stubFetch(200, { version: "1.2.3", stage: "beta" });
    render(<AdminDiagnostics />);
    await screen.findByText("Package");
    expect(screen.queryByTestId("diag-error")).toBeNull();
    expect(screen.getByText("1.2.3")).toBeTruthy();
  });
});
