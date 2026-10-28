// Owner screenshot 2026-10-27 (V75 1m, Deriv public data): the page header read
// "V75 · 1m · 33,588.01 · Idle · Bullish · Developing" while the only voter
// behind "Bullish" — the market-edge read — had failed its own minimum-evidence
// rule (edge 4/100, "Hold off — there isn't enough confirming evidence yet",
// "NO TRADE"). The server now marks such a verdict biasQualifier "LEAN"; the
// header says "Bullish lean" and does not emphasise it as a confirmed direction.
// An older server (no qualifier) renders unqualified — never a promotion.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ScannerTruth } from "@/lib/scannerTruth";

function makeTruth(): ScannerTruth {
  return {
    strip: {
      data: { verdict: "Live", detail: "Live, confirmed candles." },
      ruby: { detail: "" },
      trading: { verdict: "Blocked", detail: "Trading is restricted on your account." },
    },
    candles: { lastClose: 33588.01, sourceTechnical: "test", count: 200, minRequired: 150, status: "CONFIRMED" },
    consolidated: {
      rubyReadStatus: "LIMITED_READ",
      scannerActionability: "WAIT_FOR_CONFIRMATION",
      userMessage: "",
      internalReasonCode: "",
    },
    dataHealth: { sourceNote: "Deriv public data." },
    readiness: null,
  } as unknown as ScannerTruth;
}

let verdict: Record<string, unknown> | null = null;

vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["V75", () => {}],
  bareSymbol: (s: string) => s,
  setChartSymbol: () => {},
}));
vi.mock("@/hooks/useScannerTimeframe", () => ({
  useScannerTimeframe: () => ["1m", () => {}],
}));
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: () => ({ scannerTruth: makeTruth(), verdict }),
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ shouldShowAdminDiagnostics: false }),
}));
vi.mock("@/components/scanner/rubyReadStore", () => ({
  useRubyReadStore: () => ({ get: () => null, set: () => {} }),
}));

import { ScannerHeaderSummary } from "./ScannerHeaderSummary";

afterEach(() => {
  cleanup();
  verdict = null;
});

describe("ScannerHeaderSummary — a lean is not shown as a confirmed direction", () => {
  it("owner state: LEAN verdict reads 'Bullish lean' without the bullish emphasis", () => {
    verdict = { bias: "BULLISH", stage: "DEVELOPING", biasQualifier: "LEAN" };
    render(<ScannerHeaderSummary running={false} />);
    const bias = screen.getByTestId("scanner-header-bias");
    expect(bias.textContent).toBe("Bullish lean");
    expect(bias.className).not.toContain("text-success");
    // The verdict stage is an engine-agreement count; it is never printed bare.
    expect(document.body.textContent).not.toMatch(/·\s*Developing/);
  });

  it("bearish mirror", () => {
    verdict = { bias: "BEARISH", stage: "DEVELOPING", biasQualifier: "LEAN" };
    render(<ScannerHeaderSummary running={false} />);
    expect(screen.getByTestId("scanner-header-bias").textContent).toBe("Bearish lean");
  });

  it("no qualifier (evidence rule met, or an older server): unchanged label", () => {
    verdict = { bias: "BULLISH", stage: "ALIGNED", biasQualifier: null };
    render(<ScannerHeaderSummary running={false} />);
    const bias = screen.getByTestId("scanner-header-bias");
    expect(bias.textContent).toBe("Bullish");
    expect(bias.className).toContain("text-success");
  });

  it("a LEAN flag on a non-directional bias adds nothing", () => {
    verdict = { bias: "CONFLICT", stage: "CONFLICT", biasQualifier: "LEAN" };
    render(<ScannerHeaderSummary running={false} />);
    expect(screen.getByTestId("scanner-header-bias").textContent).toBe("Mixed signals");
  });
});
