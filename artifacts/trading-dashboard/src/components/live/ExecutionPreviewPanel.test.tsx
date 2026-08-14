import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { ExecutionPreview } from "@workspace/domain/execution-preview";
import type { LiveExecutionPreviewResult } from "@/lib/api/liveShared";

// Frontend smoke for the Execution Cost & Survivability panel (Task #196). The
// panel reads ONLY the read-only GET /api/trades/live-shared/execution-preview
// helper, which we mock here so this is a pure render proof:
//
//   1. Loading state renders while the estimate is in flight.
//   2. An error (ok:false) renders the friendly message, no crash.
//   3. A full preview renders the friendly broker-condition verdict label,
//      cost rows, survivability, and the after-cost reward:risk.
//   4. Blockers render as plain-English copy (no internal enum tokens).
//   5. A degraded estimate surfaces its honest data-quality note.
//   6. disabled / zero-lot → renders nothing (no estimate requested).
//
// The no-fabrication + math contracts are proven server-side in
// executionPreviewTest; this test only proves the panel renders what it's given.

const mockGet = vi.fn();

vi.mock("@/lib/api/liveShared", () => ({
  getLiveSharedExecutionPreview: (...args: unknown[]) => mockGet(...args),
}));

// Imported AFTER the mock (vi.mock is hoisted) so the panel binds the stub.
import { ExecutionPreviewPanel } from "./ExecutionPreviewPanel";

function fullPreview(overrides: Partial<ExecutionPreview> = {}): ExecutionPreview {
  return {
    symbol: "EURUSD",
    side: "BUY",
    orderType: "MARKET",
    lots: 0.1,
    referencePrice: 1.1001,
    pointSize: 0.00001,
    pointInferred: false,
    moneyPerPoint: 1,
    spreadCost: { points: 10, money: 10 },
    slippage: {
      source: "VOLATILITY_FALLBACK",
      expectedPoints: 4,
      worstPoints: 12,
      expectedMoney: 4,
      worstMoney: 12,
      note: "No fill history yet — estimated from recent volatility. Real slippage may differ.",
    },
    expectedFillRange: { low: 1.1001, high: 1.10054, expected: 1.10014 },
    startingDrawdown: { points: 14, money: 14 },
    breakEven: { points: 14, money: 14 },
    afterCost: {
      stopLossMoney: -64,
      takeProfitMoney: 86,
      riskRewardRatio: 1.34,
      grossRiskRewardRatio: 2.0,
    },
    survivability: {
      score: 88,
      stopDistanceAtr: 2.5,
      survivesNormalPullback: true,
      survivesStructureInvalidation: true,
      note: "Your stop sits beyond typical market noise — strong room to breathe.",
    },
    accountImpact: {
      marginRequired: 110,
      marginPctOfBalance: 1.1,
      riskMoney: 64,
      riskPctOfBalance: 0.64,
      note: "Risk includes the stop distance plus expected entry cost.",
    },
    orderTypes: [
      { type: "MARKET", fillLikelihood: 99, expectedCostMoney: 14, recommended: true, note: "Fills immediately at the current price; you pay the spread and any slippage." },
      { type: "LIMIT", fillLikelihood: 60, expectedCostMoney: 5, recommended: false, note: "Waits for your price — usually cheaper, but it may never fill if price runs away." },
      { type: "STOP", fillLikelihood: 80, expectedCostMoney: 12, recommended: false, note: "Triggers only if price breaks your level — good for breakouts, with some slippage." },
    ],
    multiEntry: null,
    brokerCondition: { verdict: "OK", reasons: [] },
    dataQuality: { hasBrokerTruth: true, degraded: false, notes: [] },
    blockers: [],
    warnings: [],
    disclaimer: "Estimated execution economics for planning only — real fills can differ. Not financial advice.",
    ...overrides,
  };
}

function okResult(preview: ExecutionPreview): LiveExecutionPreviewResult {
  return { ok: true, preview } as LiveExecutionPreviewResult;
}

const baseProps = {
  enabled: true,
  symbol: "EURUSD",
  side: "BUY" as const,
  lots: 0.1,
  stopLoss: 1.0951,
  takeProfit: 1.1101,
};

afterEach(() => {
  cleanup();
  mockGet.mockReset();
  vi.useRealTimers();
});

describe("ExecutionPreviewPanel", () => {
  it("renders nothing when disabled", () => {
    mockGet.mockResolvedValue(okResult(fullPreview()));
    const { container } = render(<ExecutionPreviewPanel {...baseProps} enabled={false} />);
    expect(container.firstChild).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("requests no estimate for a zero-lot order", () => {
    mockGet.mockResolvedValue(okResult(fullPreview()));
    render(<ExecutionPreviewPanel {...baseProps} lots={0} />);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("renders a full preview with friendly verdict, costs, and reward:risk", async () => {
    mockGet.mockResolvedValue(okResult(fullPreview()));
    render(<ExecutionPreviewPanel {...baseProps} />);
    await screen.findByTestId("exec-preview-panel");
    // Friendly broker-condition label — never a raw token.
    expect(screen.getByTestId("exec-preview-verdict").textContent).toContain("Good conditions");
    expect(screen.getByText("Spread cost")).toBeTruthy();
    expect(screen.getByText("Slippage (expected)")).toBeTruthy();
    expect(screen.getByText("Reward : risk")).toBeTruthy();
    // After-cost R:R is shown alongside the gross figure.
    expect(screen.getByText(/before cost/)).toBeTruthy();
    // Survivability headline shows the score.
    expect(screen.getByText(/Survivability/).textContent).toContain("88/100");
  });

  it("renders the friendly error message when the estimate fails", async () => {
    mockGet.mockResolvedValue({
      ok: false,
      userMessage: "An execution-cost estimate isn't available right now.",
    } as LiveExecutionPreviewResult);
    render(<ExecutionPreviewPanel {...baseProps} />);
    const err = await screen.findByTestId("exec-preview-error");
    expect(err.textContent).toContain("isn't available right now");
  });

  it("falls back to a safe message when the request throws", async () => {
    mockGet.mockRejectedValue(new Error("network"));
    render(<ExecutionPreviewPanel {...baseProps} />);
    const err = await screen.findByTestId("exec-preview-error");
    expect(err.textContent).toContain("The order is unaffected.");
  });

  it("renders blockers as plain-English copy with no internal enum tokens", async () => {
    mockGet.mockResolvedValue(
      okResult(
        fullPreview({
          brokerCondition: {
            verdict: "BLOCK",
            reasons: ["Your broker isn't allowing new entries on this symbol right now."],
          },
          blockers: ["Your broker isn't allowing new entries on this symbol right now."],
        }),
      ),
    );
    render(<ExecutionPreviewPanel {...baseProps} />);
    const blockers = await screen.findByTestId("exec-preview-blockers");
    expect(blockers.textContent).toContain("isn't allowing new entries");
    expect(screen.getByTestId("exec-preview-verdict").textContent).toContain("Hold off");
    // No UPPER_SNAKE token leaks into rendered copy.
    const panel = screen.getByTestId("exec-preview-panel");
    expect(panel.textContent ?? "").not.toMatch(/\b[A-Z]{2,}_[A-Z][A-Z_]+\b/);
  });

  it("surfaces an honest data-quality note when the estimate is degraded", async () => {
    mockGet.mockResolvedValue(
      okResult(
        fullPreview({
          pointInferred: true,
          dataQuality: {
            hasBrokerTruth: false,
            degraded: true,
            notes: ["Broker tick size not reported yet — point size estimated from price."],
          },
        }),
      ),
    );
    render(<ExecutionPreviewPanel {...baseProps} />);
    await screen.findByTestId("exec-preview-panel");
    expect(screen.getByText(/Broker tick size not reported yet/)).toBeTruthy();
  });
});
