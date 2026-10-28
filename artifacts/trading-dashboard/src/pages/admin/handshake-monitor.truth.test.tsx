// Handshake monitor: an investor-scoped handshake with no investor context
// (every layer SKIPPED) is "Not checked", not "Error", and is not counted as
// an error. Each layer shows what the coordinator observed (detail, age), and
// the card says when it was evaluated.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/components/admin/AdminDiagnosticsGate", () => ({
  AdminDiagnosticsGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { default: AdminHandshakeMonitor } = await import("./handshake-monitor");

const evaluatedAt = "2026-10-28T12:00:05.000Z";
function verdict(o: Record<string, unknown>) {
  return {
    type: "MARKET_DATA", label: "Market Data Readiness", overallStatus: "READY", aggregateStatus: "PASS",
    safeToProceed: true, implemented: true, checks: [], layersChecked: [], blockers: [], warnings: [],
    recommendations: [], permissions: { adminOnly: true, investorScoped: false, executionCritical: false },
    freshness: { evaluatedAt, oldestSignalAgeMs: null, hasStaleSignal: false },
    userFacingMessage: "", adminDetails: "", evaluatedAt, ...o,
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Handshake monitor", () => {
  it("shows Not checked (not Error) and counts it separately from errors", async () => {
    const skipped = [
      { layer: "INVESTOR_FUND_BOOK", status: "SKIPPED", required: true, detail: "no investor context", ageMs: null },
    ];
    const market = [{ layer: "MARKET_DATA", status: "PASS", required: true, detail: "quote fresh", ageMs: 12_000 }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      verdicts: [
        verdict({ checks: market, layersChecked: market }),
        verdict({
          type: "INVESTOR_VALUE", label: "Investor Value Readiness", overallStatus: "NOT_CHECKED",
          aggregateStatus: "UNKNOWN", safeToProceed: false, checks: skipped, layersChecked: skipped,
        }),
      ],
      recent: [],
      summary: { total: 2, implemented: 2, ready: 1, warnings: 0, waiting: 0, blocked: 0, errors: 0, notChecked: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    render(<AdminHandshakeMonitor />);
    await waitFor(() => screen.getByTestId("handshake-overall-INVESTOR_VALUE"));
    expect(screen.getByTestId("handshake-overall-INVESTOR_VALUE").textContent).toBe("Not checked");
    const summary = screen.getByTestId("handshake-summary").textContent ?? "";
    expect(summary).toContain("0 errors");
    expect(summary).toContain("1 not checked");
    const investorCard = screen.getByTestId("handshake-card-INVESTOR_VALUE").textContent ?? "";
    expect(investorCard).toContain("no investor context");
    const marketCard = screen.getByTestId("handshake-card-MARKET_DATA").textContent ?? "";
    expect(marketCard).toContain("quote fresh");
    expect(marketCard).toContain("12s old");
    expect(screen.getByTestId("handshake-evaluated-MARKET_DATA").textContent).toMatch(/Evaluated/);
    expect(screen.getByTestId("handshake-evaluated-MARKET_DATA").textContent).toMatch(/10 s/);
  });
});
