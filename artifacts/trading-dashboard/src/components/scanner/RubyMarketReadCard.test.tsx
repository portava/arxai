import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type {
  MeMarketEdgeResp,
  RubyMarketReadExplanation,
  RubyExplanationMode,
} from "@workspace/api-client-react";

// Frontend smoke for the Scanner "Ruby Market Read" card (Task #195). The card
// reads ONLY the read-only GET /api/me/market-edge intelligence endpoint via the
// generated hook, which we mock here so the test is a pure render proof:
//
//   1. Honest loading / error / empty states render without crashing.
//   2. A full read renders the headline, best action, and full reason chain.
//   3. The late warning surfaces only when the signal says the move is late.
//   4. Levels render ONLY when the explanation is actionable — a blind/
//      not-actionable read must NOT show a levels grid (no fabricated prices).
//   5. No-trade intelligence + missing-context honesty states render.
//
// The component renders exactly what the backend explanation engine returns; the
// no-fabrication contract itself is proven server-side in scannerExplanationTest.

const mockUseGetMeMarketEdge = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetMeMarketEdge: (...args: unknown[]) => mockUseGetMeMarketEdge(...args),
  getGetMeMarketEdgeQueryKey: () => ["get-me-market-edge"],
}));

// The card embeds the shared-truth ScannerReadGate (which pulls useScannerTruth →
// useQuery + useTradingMode). This test is a pure render proof of the card's own
// content, so stub the gate to a no-op; its truth-gating is proven in
// ScannerReadGate.test.tsx and the resolver tests (scannerTruth.test.ts).
vi.mock("@/components/scanner/ScannerReadGate", () => ({
  ScannerReadGate: () => null,
}));

// The card also consumes the shared useScannerReadGate hook (which pulls
// useScannerTruth → useQuery + useTradingMode) to content-gate actionable
// output. Default it to a fully-actionable read so these render proofs exercise
// the normal path; downgrade behaviour is proven via the resolver consistency
// tests + ScannerReadGate.test.tsx.
const mockUseScannerReadGate = vi.fn<() => ScannerReadGateState>(() => ({
  truth: null,
  level: "full",
  isFull: true,
  downgraded: false,
  reason: null,
}));
vi.mock("@/hooks/useScannerReadGate", () => ({
  useScannerReadGate: () => mockUseScannerReadGate(),
}));

// Task #515 — the card now reads NEWS + the data-freshness anchor from the ONE
// per-symbol Truth Snapshot (useSymbolTruth). Stub it so this render proof stays
// pure (no QueryClient / network); its truth derivation is proven server-side in
// symbolTruthSnapshot.test.ts. Default return is set in beforeEach.
const mockUseSymbolTruth = vi.fn();
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: (...args: unknown[]) => mockUseSymbolTruth(...args),
}));

// Imported AFTER the mock (vi.mock is hoisted) so the component binds the stub.
import { RubyMarketReadCard } from "./RubyMarketReadCard";
import type { ScannerReadGateState } from "@/hooks/useScannerReadGate";

function mode(label: string): RubyExplanationMode {
  return {
    whatIsHappening: `${label}: price is pressing higher`,
    why: `${label}: trend and momentum agree`,
    whyThisMarket: `${label}: this pair is the cleanest right now`,
    whyThisDirection: `${label}: structure favours buyers`,
    whyNow: `${label}: a pullback just completed`,
    timingState: `${label}: entry window is open`,
    entryZone: `${label}: buy into the marked zone`,
    risk: `${label}: stop below the swing`,
    whatConfirms: `${label}: a higher low holds`,
    whatInvalidates: `${label}: a close back below the zone`,
    whatToDoNext: `${label}: manage to the stop`,
  };
}

function explanation(
  overrides: Partial<RubyMarketReadExplanation> = {},
): RubyMarketReadExplanation {
  return {
    headline: "Buyers are in control on EURUSD",
    defaultMode: "SIMPLE",
    simple: mode("simple"),
    advanced: mode("advanced"),
    levels: {
      entryZone: { from: 1.085, to: 1.0855 },
      watchZone: { from: 1.084, to: 1.0845 },
      lateZone: { from: 1.087, to: 1.0875 },
      stopLoss: 1.083,
      invalidation: 1.0825,
      takeProfits: [{ from: 1.088, to: 1.0885 }],
    },
    bestAction: "Consider a buy into the marked zone and manage to the stop.",
    noTrade: { isNoTrade: false, confidence: 0, reason: null },
    hasSufficientData: true,
    actionable: true,
    missingContext: [],
    disclaimer: "Read-only market intelligence. Not financial advice.",
    ...overrides,
  };
}

function signal(over: Record<string, unknown> = {}) {
  return {
    symbol: "EURUSD",
    displayName: "EURUSD",
    timeframe: "M5",
    assetClass: "forex",
    generatedAt: new Date(Date.now() - 5000).toISOString(),
    dataSource: "LIVE_FEED",
    hasSufficientData: true,
    bias: "BULLISH",
    direction: "BUY",
    regime: "TRENDING",
    lifecycleStage: "ENTRY_WINDOW_OPEN",
    lifecycleReasons: [],
    confidenceBand: "STRONG",
    edgeScore: 72,
    scores: {
      direction: 80,
      entry: 64,
      execution: 78,
      risk: 70,
      newsSafety: 90,
      timing: 75,
      survivability: 66,
      overall: 73,
      edge: 72,
    },
    evidence: {
      for: [{ key: "trend", label: "Aligned uptrend on M5", weight: 2 }],
      against: [{ key: "spread", label: "Spread a touch wide", weight: 1 }],
      conflicts: [],
      meetsMinimum: true,
      netScore: 1,
    },
    freshness: "FRESH",
    late: { isLate: false, doNotChase: false, reason: null },
    ...over,
  };
}

function resp(
  over: { signal?: Record<string, unknown>; explanation?: RubyMarketReadExplanation } = {},
): MeMarketEdgeResp {
  return {
    signal: signal(over.signal ?? {}),
    explanation: over.explanation ?? explanation(),
  } as MeMarketEdgeResp;
}

function hookState(over: Record<string, unknown>) {
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  mockUseGetMeMarketEdge.mockReset();
  // Default the shared truth-gate back to fully-actionable between tests so a
  // downgraded case can't bleed into the normal render proofs.
  mockUseScannerReadGate.mockReturnValue({
    truth: null,
    level: "full" as const,
    isFull: true,
    downgraded: false,
    reason: null,
  });
  // Default the unified Truth Snapshot to a connected, no-events read with fresh
  // data timestamps so the news line + "updated Ns ago" freshness render.
  mockUseSymbolTruth.mockReset();
  const recentIso = new Date(Date.now() - 4000).toISOString();
  mockUseSymbolTruth.mockReturnValue({
    news: {
      providerConnected: true,
      events: [],
      riskLabel: "No scheduled high-impact events affect this market.",
      highImpactWindowActive: false,
      disclaimer: null,
    },
    data: { lastTickAt: recentIso, lastCandleAt: recentIso },
  });
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("RubyMarketReadCard — honest render states", () => {
  it("renders the loading state without crashing", () => {
    mockUseGetMeMarketEdge.mockReturnValue(hookState({ isLoading: true }));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="M5" />);
    expect(screen.getByTestId("ruby-market-read")).toBeTruthy();
    expect(screen.getByText(/Eleanor is reading EURUSD/i)).toBeTruthy();
  });

  it("renders the error state honestly", () => {
    mockUseGetMeMarketEdge.mockReturnValue(hookState({ isError: true }));
    render(<RubyMarketReadCard symbol="EURUSD" />);
    expect(screen.getByTestId("ruby-market-read-err")).toBeTruthy();
  });

  it("renders headline, best action, and the full reason chain on a live read", () => {
    mockUseGetMeMarketEdge.mockReturnValue(hookState({ data: resp() }));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="M5" />);
    expect(screen.getByTestId("ruby-market-read-headline").textContent).toContain(
      "Buyers are in control",
    );
    expect(screen.getByTestId("ruby-market-read-best-action")).toBeTruthy();
    // Reason chain row present (Simple mode is the default).
    expect(screen.getByTestId("ruby-market-read-what").textContent).toContain("simple:");
    // Required metadata blocks render from the signal.
    expect(screen.getByTestId("ruby-market-read-stage").textContent).toContain("Entry window open");
    expect(screen.getByTestId("ruby-market-read-bias").textContent).toContain("Bullish");
    expect(screen.getByTestId("ruby-market-read-quality").textContent).toContain("Strong");
    expect(screen.getByTestId("ruby-market-read-edge").textContent).toContain("72");
    // Evidence breakdown + news/economic impact placeholder + freshness timer.
    expect(screen.getByTestId("ruby-market-read-evidence").textContent).toContain("Aligned uptrend");
    expect(screen.getByTestId("ruby-market-read-news")).toBeTruthy();
    expect(screen.getByTestId("ruby-market-read-freshness").textContent).toMatch(/updated \d+s ago/);
    // Actionable read → Levels section (collapsed by default) is offered.
    expect(screen.getByText("Levels")).toBeTruthy();
  });

  it("shows the late warning only when the signal flags it", () => {
    mockUseGetMeMarketEdge.mockReturnValue(
      hookState({
        data: resp({
          signal: {
            late: { isLate: true, doNotChase: true, reason: "~80% of the move already done" },
          },
        }),
      }),
    );
    render(<RubyMarketReadCard symbol="EURUSD" />);
    expect(screen.getByTestId("ruby-market-read-late").textContent).toContain(
      "80% of the move already done",
    );
  });

  it("hides the levels grid on a non-actionable (blind/insufficient) read", () => {
    mockUseGetMeMarketEdge.mockReturnValue(
      hookState({
        data: resp({
          explanation: explanation({
            actionable: false,
            hasSufficientData: false,
            missingContext: ["live price for this market"],
            noTrade: { isNoTrade: true, confidence: 70, reason: "No clean edge — sitting out." },
          }),
        }),
      }),
    );
    render(<RubyMarketReadCard symbol="EURUSD" />);
    // No fabricated levels when not actionable — Levels section not offered.
    expect(screen.queryByText("Levels")).toBeNull();
    expect(screen.getByTestId("ruby-market-read-no-trade")).toBeTruthy();
    expect(screen.getByTestId("ruby-market-read-missing")).toBeTruthy();
  });

  it("downgrades actionable content when the shared scanner truth is not full", () => {
    // The signal itself is a confident, actionable live read — but the ONE shared
    // truth says the feed is delayed/limited. The card must NOT present that
    // confidence: suppress the numeric scores, the best action, and the levels.
    mockUseScannerReadGate.mockReturnValue({
      truth: null,
      level: "limited",
      isFull: false,
      downgraded: true,
      reason: "Delayed market data — readable, but slightly behind live.",
    });
    mockUseGetMeMarketEdge.mockReturnValue(hookState({ data: resp() }));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="M5" />);

    // Best action is replaced by the honest "not actionable" line.
    expect(screen.queryByTestId("ruby-market-read-best-action")).toBeNull();
    expect(screen.getByTestId("ruby-market-read-best-action-downgraded").textContent).toMatch(
      /not actionable/i,
    );
    // Numeric confidence is withheld: no "/100" on quality, edge shows "—".
    expect(screen.getByTestId("ruby-market-read-quality").textContent).not.toContain("/100");
    expect(screen.getByTestId("ruby-market-read-edge").textContent).toContain("—");
    expect(screen.getByTestId("ruby-market-read-edge").textContent).not.toContain("72");
    // No actionable levels over an unstable feed.
    expect(screen.queryByText("Levels")).toBeNull();
  });
});
