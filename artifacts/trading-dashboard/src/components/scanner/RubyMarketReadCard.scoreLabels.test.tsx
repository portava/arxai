import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type {
  MeMarketEdgeResp,
  RubyMarketReadExplanation,
  RubyExplanationMode,
} from "@workspace/api-client-react";

// Score / no-trade labels on the Eleanor Market Read card (owner screenshot
// 2026-10-27, V75 1m, Deriv public data). Scaffolding mirrors
// RubyMarketReadCard.test.tsx. Original header follows.
//
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
    // Required by the API contract; the card withholds advice past this time.
    validForSeconds: 900,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
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

describe("RubyMarketReadCard — no-trade weight is not a probability", () => {
  const ownerNoTrade = {
    isNoTrade: true,
    confidence: 66,
    basis: "RULE_TIER" as const,
    ruleKey: "BELOW_MIN_EVIDENCE" as const,
    reason:
      "There isn't enough confirming evidence yet to justify the risk: only 1 supporting signal (at least 2 needed) and net supporting evidence 20/100 (at least 25 needed).",
  };

  it("renders the rule's reason and never a '% sure' figure (owner state)", () => {
    mockUseGetMeMarketEdge.mockReturnValue(
      hookState({
        data: resp({
          explanation: explanation({
            actionable: false,
            noTrade: ownerNoTrade,
            missingContext: ["enough confirming evidence"],
          }),
        }),
      }),
    );
    render(<RubyMarketReadCard symbol="R_75" timeframe="M1" />);
    const block = screen.getByTestId("ruby-market-read-no-trade").textContent ?? "";
    expect(block).not.toMatch(/%\s*sure/i);
    expect(block).not.toContain("66");
    expect(block).toContain("only 1 supporting signal (at least 2 needed)");
    // The still-needs list on the same card agrees with the reason.
    expect(screen.getByTestId("ruby-market-read-missing").textContent).toContain(
      "enough confirming evidence",
    );
  });

  it("an older server without a basis still never renders the number as a probability", () => {
    mockUseGetMeMarketEdge.mockReturnValue(
      hookState({
        data: resp({
          explanation: explanation({
            actionable: false,
            noTrade: { isNoTrade: true, confidence: 90, reason: "Not enough live data to read this market." },
          }),
        }),
      }),
    );
    render(<RubyMarketReadCard symbol="R_75" timeframe="M1" />);
    const block = screen.getByTestId("ruby-market-read-no-trade").textContent ?? "";
    expect(block).not.toMatch(/%/);
    expect(block).toContain("Not enough live data");
  });
});

describe("RubyMarketReadCard — trade quality grade needs every score input observed", () => {
  const ownerScores = {
    direction: 27,
    entry: 40,
    execution: 50,
    risk: 25,
    newsSafety: 70,
    timing: 60,
    survivability: 50,
    overall: 42,
    edge: 4,
    unmeasured: ["entry", "execution", "risk", "newsSafety", "timing", "survivability"],
  };

  it("owner state (PARTIAL basis): shows 42/100 and what is unmeasured, never 'Modest'", () => {
    mockUseGetMeMarketEdge.mockReturnValue(
      hookState({
        data: resp({
          signal: {
            confidenceBand: "MODEST",
            confidenceBandBasis: "PARTIAL",
            edgeScore: 4,
            scores: ownerScores,
            lifecycleStage: "SETUP_FORMING",
          },
          explanation: explanation({ actionable: false }),
        }),
      }),
    );
    render(<RubyMarketReadCard symbol="R_75" timeframe="M1" />);
    const tile = screen.getByTestId("ruby-market-read-quality").textContent ?? "";
    expect(tile).not.toContain("Modest");
    expect(tile).toContain("42/100");
    expect(tile).toContain("6 of 7 inputs unmeasured");
    expect(tile).toContain("no reading for entry, execution, reward-to-risk, news, timing, room to target");
  });

  it("an older server without a basis: number only, no grade", () => {
    const { unmeasured: _u, ...noList } = ownerScores;
    mockUseGetMeMarketEdge.mockReturnValue(
      hookState({
        data: resp({ signal: { confidenceBand: "MODEST", scores: noList, edgeScore: 4 } }),
      }),
    );
    render(<RubyMarketReadCard symbol="R_75" timeframe="M1" />);
    const tile = screen.getByTestId("ruby-market-read-quality").textContent ?? "";
    expect(tile).not.toContain("Modest");
    expect(tile).toContain("42/100 · not graded");
  });

  it("FULL basis keeps the server's grade", () => {
    mockUseGetMeMarketEdge.mockReturnValue(
      hookState({
        data: resp({
          signal: {
            confidenceBand: "MODEST",
            confidenceBandBasis: "FULL",
            scores: { ...ownerScores, unmeasured: [] },
          },
        }),
      }),
    );
    render(<RubyMarketReadCard symbol="R_75" timeframe="M1" />);
    expect(screen.getByTestId("ruby-market-read-quality").textContent).toContain("Modest · 42/100");
  });

  it("the headline is the server's explanation verbatim (no client rewrite)", () => {
    const headline = "V75: forming — buy bias, no tradeable edge yet (4/100).";
    mockUseGetMeMarketEdge.mockReturnValue(
      hookState({ data: resp({ explanation: explanation({ headline }) }) }),
    );
    render(<RubyMarketReadCard symbol="R_75" timeframe="M1" />);
    expect(screen.getByTestId("ruby-market-read-headline").textContent).toBe(headline);
  });
});
