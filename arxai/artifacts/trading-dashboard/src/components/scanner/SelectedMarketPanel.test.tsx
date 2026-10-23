import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { ScannerTruth } from "@/lib/scannerTruth";

// ── SelectedMarketPanel honesty safety-net (follow-up to the Broad Scan locks) ──
//
// The "Pick a market — Ruby explains it" panel is the remaining selected-symbol
// surface that carries explicit BUY / SELL affordances. It updates whenever the
// user selects a symbol (via the chart bus). This suite locks that for a degraded
// / feed-unconfirmed / historical-only selected symbol the panel:
//
//   • still renders safe context for the symbol (it never goes blank),
//   • surfaces the honest, NON-BLOCKING feed warning (derived from the ONE shared
//     scanner-truth via the real resolveTradeAffordance — not a stubbed verdict),
//   • withholds numeric entry/stop/target levels (the "waiting" / "withheld"
//     render branch, never fabricated numbers styled as levels), and
//   • never presents itself as a clean, live-ready, execution-ready opportunity:
//     no "Live-confirmed" / "Execution-ready" / "Ready to trade" / "Clean setup"
//     / "Verified" / "AACI verified" copy anywhere in the panel.
//
// BUY / SELL render whenever a snapshot exists because they open the SEPARATELY
// gated LiveTradeTicket (every server safety gate runs there — HARD BOUNDARY, not
// touched here; the ticket is stubbed). The lock is that the PANEL ITSELF does
// not label or surround those buttons as live-ready / execution-ready — their
// labels stay the bare side ("BUY" / "SELL") and the only copy around them is the
// honest feed warning + the "runs every server safety gate" disclaimer.
//
// Forbidden-token checks are CASE-SENSITIVE on purpose: the honest pending copy
// says "checking whether this market has a clean setup" (lowercase, an explicit
// uncertainty, not a claim) and the waiting copy says "confirmed live feed" — a
// case-insensitive or document-wide scan would false-fail the very wording that
// tells the truth. The forbidden tokens are the affirmative Title-case claims.
//
// TEST-ONLY: asserts existing component behaviour; no component, view-resolver,
// affordance, ticket, or backend change.

const SELECTED_PANEL_FORBIDDEN = [
  "Live-confirmed",
  "Execution-ready",
  "Ready to trade",
  "Clean setup",
  "Verified",
  "AACI verified",
];

// The panel calls useQuery directly twice: the snapshot (queryKey[0]==="scanner")
// and the public Deriv status (queryKey[0]==="deriv-status"). Route by key so each
// test controls the snapshot while the deriv badge stays inert.
const mockSnapshotQuery = vi.fn();
const mockDerivQuery = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey?: unknown[] }) => {
    const k = Array.isArray(opts.queryKey) ? opts.queryKey[0] : undefined;
    if (k === "deriv-status") return mockDerivQuery();
    return mockSnapshotQuery();
  },
}));

// Chart-symbol bus: pin the selected symbol; setChartSymbol is a no-op here.
vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["EURUSD", vi.fn()],
  bareSymbol: (s: string) => (s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
  setChartSymbol: vi.fn(),
}));

// Registry resolves the canonical symbol + the friendly pending-card fields.
// A vi.fn so individual tests can force the "unknown symbol" path (registry
// miss → the destructive unavailable alert branch).
const mockResolveSymbol = vi.fn();
vi.mock("@/lib/symbolRegistry", () => ({
  resolveSymbol: (s: string) => mockResolveSymbol(s),
}));

// The ONE shared scanner-truth — default set in beforeEach to a DEGRADED read.
const mockUseScannerTruth = vi.fn();
vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: (...args: unknown[]) => mockUseScannerTruth(...args),
}));

vi.mock("@/hooks/useScannerTimeframe", () => ({
  useScannerTimeframe: () => ["15m", vi.fn()],
}));
vi.mock("@/lib/chartCandlesQuery", () => ({
  toApiTimeframe: () => "M15",
}));

// Sub-surfaces with their own truth/render proofs — stub to keep this a pure
// render proof of the PANEL's own content.
vi.mock("@/components/scanner/SymbolExplorer", () => ({
  SymbolExplorer: () => null,
}));
vi.mock("@/components/live/TradabilityBadge", () => ({
  TradabilityBadge: () => null,
}));
// HARD BOUNDARY: the live ticket is a separately-gated path. Stub it — render a
// marker only when actually opened (default closed) so we never assert against,
// or depend on, its internals.
vi.mock("@/components/live/LiveTradeTicket", () => ({
  LiveTradeTicket: (p: { open?: boolean }) =>
    p.open ? <div data-testid="live-trade-ticket-stub" /> : null,
}));

// Imported AFTER the mocks (vi.mock is hoisted) so the component binds the stubs.
import { SelectedMarketPanel } from "./SelectedMarketPanel";

// A degraded shared truth: a read exists but is NOT actionable (feed not live-
// confirmed). resolveTradeAffordance runs for REAL over this, so the feed warning
// is genuinely derived, not asserted into existence.
function degradedTruth(): ScannerTruth {
  return {
    actionable: false,
    dataHealth: {
      headline: "Feed not live-confirmed",
      sourceNote: "Showing historical bars, not a confirmed live feed.",
    },
    candles: { reason: "No confirmed live candles for this market yet." },
    // The ONE shared trade-health / readiness DISPLAY verdict is a REQUIRED field
    // of ScannerTruth (always populated in production). resolveTradeAffordance
    // reads truth.readiness, so the degraded fixture must carry a consistent,
    // feed-not-confirmed / historical-only verdict (every affordance ceiling off).
    readiness: {
      status: "partial",
      isApprovedMarket: true,
      readLayer: "STRUCTURAL_ONLY",
      feedVerdict: "AWAITING",
      dataFreshness: "HISTORICAL_ONLY",
      structureConfidence: "MEDIUM",
      setupHealth: "UNKNOWN",
      executionBlockedReason: "FEED_NOT_LIVE_CONFIRMED",
      displayLabel: "Historical read only",
      userFacingTrustLine: "Showing historical bars, not a confirmed live feed.",
      mayDescribeSetup: false,
      mayShowTradeButton: false,
      mayShowOneClickButton: false,
      mayOfferLiveExecutionRequest: false,
    },
  } as unknown as ScannerTruth;
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

// A snapshot that the backend CAN build but that is feed-degraded: no confirmed
// live feed (dataState UNAVAILABLE) and levels withheld, so the panel must render
// the honest "waiting" branch instead of numeric levels.
function degradedOkSnapshot() {
  return {
    ok: true as const,
    symbolRaw: "EURUSD",
    symbol: "EURUSD",
    timeframe: "M15",
    highlights: {
      bias: "WAIT" as const,
      confidenceLabel: "Low",
      confidenceScore: 18,
      volatilityLabel: "Normal",
      trendState: "Ranging",
      entryZone: null,
      suggestedStop: null,
      suggestedTakeProfit: null,
      riskRewardRatio: 0,
      riskWarnings: [],
    },
    explanation: {
      hedge: "Sitting out for now — nothing clean here.",
      why: "Momentum and structure disagree on this timeframe.",
      whyItMatters: "Mixed signals usually mean chop, not a trend.",
      risk: "A stop here would sit inside the noise.",
      invalidation: "A decisive close out of the range changes the read.",
      cautions: [],
      disclaimer: "Read-only market intelligence. Not financial advice.",
    },
    upcomingEvents: [],
    newsRisk: { riskLevel: "LOW", blockTrading: false, summary: "" },
    dataSource: "HISTORICAL",
    dataSourceLabel: "Historical",
    dataState: "UNAVAILABLE" as const,
    dataAsOf: null,
    levelsWithheld: true,
    levelsWithheldReason: null,
    generatedAt: new Date().toISOString(),
    cacheHit: false,
  };
}

beforeEach(() => {
  mockSnapshotQuery.mockReset();
  mockDerivQuery.mockReset();
  mockUseScannerTruth.mockReset();
  mockResolveSymbol.mockReset();
  // Default: registry resolves any non-empty symbol to a friendly record.
  mockResolveSymbol.mockImplementation((s: string) =>
    s
      ? { canonicalSymbol: s.toUpperCase(), displayName: s.toUpperCase(), marketType: "forex" }
      : null,
  );
  // Deriv status: configured but not connected — inert for these proofs.
  mockDerivQuery.mockReturnValue(
    hookState({ data: { configured: true, connected: false } }),
  );
  // Default the shared truth to the degraded read.
  mockUseScannerTruth.mockReturnValue({ truth: degradedTruth() });
});
afterEach(() => cleanup());

describe("SelectedMarketPanel — a degraded selected symbol never reads as live-ready", () => {
  it("renders safe context + the honest feed warning, withholds levels, and never claims live/execution readiness", () => {
    mockSnapshotQuery.mockReturnValue(hookState({ data: degradedOkSnapshot() }));
    render(<SelectedMarketPanel />);

    const panel = screen.getByTestId("selected-market-panel");
    expect(panel).toBeTruthy();
    // Safe context still renders for the symbol.
    expect(screen.getByTestId("badge-active-symbol").textContent).toContain("EURUSD");

    // The honest, non-blocking feed warning is GENUINELY derived (real
    // resolveTradeAffordance over the degraded truth).
    const warn = screen.getByTestId("selected-market-feed-warning");
    expect(warn.textContent).toContain("Feed not live-confirmed");
    expect(warn.textContent).toContain("No confirmed live candles");

    // Numeric levels are WITHHELD — the waiting branch renders, never numbers.
    expect(screen.queryByTestId("selected-market-levels")).toBeNull();
    expect(screen.getByTestId("selected-market-levels-waiting")).toBeTruthy();

    // BUY / SELL render (they open the separately-gated ticket) but the panel
    // labels them as the bare side only — never decorated as live/execution-ready.
    const buy = screen.getByTestId("btn-open-ticket-buy");
    const sell = screen.getByTestId("btn-open-ticket-sell");
    expect((buy.textContent ?? "").trim()).toBe("BUY");
    expect((sell.textContent ?? "").trim()).toBe("SELL");

    // The ticket stays closed until the user acts (no live ticket internals here).
    expect(screen.queryByTestId("live-trade-ticket-stub")).toBeNull();

    // The action region around the buttons carries only the honest feed warning +
    // the safety-gate disclaimer, no live-ready claim.
    const actionRegion = buy.closest("div.space-y-2") as HTMLElement;
    expect(actionRegion).toBeTruthy();
    const actionText = within(actionRegion).getByText(/runs every server safety gate/i);
    expect(actionText).toBeTruthy();
    for (const claim of SELECTED_PANEL_FORBIDDEN) {
      expect(actionRegion.textContent ?? "").not.toContain(claim);
    }

    // And no affirmative live-ready / execution-ready claim anywhere in the panel.
    const panelText = panel.textContent ?? "";
    for (const claim of SELECTED_PANEL_FORBIDDEN) {
      expect(panelText).not.toContain(claim);
    }
  });

  it("when no snapshot can be built, the panel stays context-only — no BUY/SELL, no levels, no live-ready claim", () => {
    mockSnapshotQuery.mockReturnValue(
      hookState({
        data: {
          ok: false as const,
          symbol: "EURUSD",
          reason: "FEED_NOT_CONFIGURED",
          message: "Live feed for this market isn't configured yet.",
        },
      }),
    );
    render(<SelectedMarketPanel />);

    const panel = screen.getByTestId("selected-market-panel");
    // Friendly registry-sourced context card (never a destructive "unavailable").
    expect(screen.getByTestId("selected-market-snapshot-pending")).toBeTruthy();

    // No execution affordance at all on a snapshot the backend couldn't build.
    expect(screen.queryByTestId("btn-open-ticket-buy")).toBeNull();
    expect(screen.queryByTestId("btn-open-ticket-sell")).toBeNull();
    expect(screen.queryByTestId("selected-market-levels")).toBeNull();
    expect(screen.queryByTestId("live-trade-ticket-stub")).toBeNull();

    // No affirmative live-ready / execution-ready claim (case-sensitive — the
    // honest lowercase "a clean setup" uncertainty copy must NOT trip this).
    const panelText = panel.textContent ?? "";
    for (const claim of SELECTED_PANEL_FORBIDDEN) {
      expect(panelText).not.toContain(claim);
    }
  });
});

// ── Defensive load-state proofs: the panel always loads without crashing ──
//
// Beyond the degraded-but-complete snapshot above, the panel has loading,
// hard-error, and truthy-but-partial payload branches. Truthy-but-partial
// payloads have historically thrown into the route error boundary elsewhere in
// this app (a payload says ok:true but omits highlights/explanation, and the ok
// render path reads them unguarded). These proofs lock that every one of those
// branches renders an honest fallback and NEVER throws — a thrown render would
// propagate here and fail the test outright.

describe("SelectedMarketPanel — every load state renders without crashing", () => {
  it("shows the loading skeleton while the snapshot query is in flight (no affordances, no crash)", () => {
    mockSnapshotQuery.mockReturnValue(hookState({ data: undefined, isLoading: true }));
    render(<SelectedMarketPanel />);

    expect(screen.getByTestId("selected-market-panel")).toBeTruthy();
    expect(screen.getByText(/Loading market/i)).toBeTruthy();

    // Nothing else has resolved yet — no ok view, no fallback card, no ticket.
    expect(screen.queryByTestId("btn-open-ticket-buy")).toBeNull();
    expect(screen.queryByTestId("selected-market-levels")).toBeNull();
    expect(screen.queryByTestId("selected-market-snapshot-pending")).toBeNull();
    expect(screen.queryByTestId("selected-market-unavailable")).toBeNull();
    expect(screen.queryByTestId("live-trade-ticket-stub")).toBeNull();
  });

  it("renders an honest unavailable alert (never crashes) when the snapshot fails for an unknown symbol", () => {
    // Registry miss → the destructive-but-honest unavailable alert branch.
    mockResolveSymbol.mockReturnValue(null);
    mockSnapshotQuery.mockReturnValue(
      hookState({
        data: {
          ok: false as const,
          symbol: "WAT123",
          reason: "ANALYSIS_FAILED",
          message: "Couldn't analyze this market right now.",
        },
      }),
    );
    render(<SelectedMarketPanel />);

    expect(screen.getByTestId("selected-market-panel")).toBeTruthy();
    const alert = screen.getByTestId("selected-market-unavailable");
    expect(alert.textContent).toContain("Couldn't analyze this market right now.");

    // A failed snapshot never offers an execution affordance.
    expect(screen.queryByTestId("btn-open-ticket-buy")).toBeNull();
    expect(screen.queryByTestId("selected-market-levels")).toBeNull();
    expect(screen.queryByTestId("live-trade-ticket-stub")).toBeNull();
  });

  it("falls back to context (no throw) when ok:true but highlights are missing", () => {
    // Truthy-but-partial: backend said ok:true but omitted highlights. The ok
    // render path reads ok.highlights.* — this must degrade, not crash.
    mockSnapshotQuery.mockReturnValue(
      hookState({
        data: {
          ok: true as const,
          symbolRaw: "EURUSD",
          symbol: "EURUSD",
          timeframe: "M15",
          explanation: {
            hedge: "—",
            why: "—",
            whyItMatters: "—",
            risk: "—",
            invalidation: "—",
            cautions: [],
            disclaimer: "Read-only market intelligence.",
          },
          upcomingEvents: [],
          newsRisk: { riskLevel: "LOW", blockTrading: false, summary: "" },
          generatedAt: new Date().toISOString(),
          cacheHit: false,
        },
      }),
    );
    render(<SelectedMarketPanel />);

    // Friendly registry context card, NOT the ok render path.
    expect(screen.getByTestId("selected-market-snapshot-pending")).toBeTruthy();
    expect(screen.queryByTestId("btn-open-ticket-buy")).toBeNull();
    expect(screen.queryByTestId("selected-market-levels")).toBeNull();
    expect(screen.queryByTestId("live-trade-ticket-stub")).toBeNull();
  });

  it("falls back to context (no throw) when ok:true but explanation is missing", () => {
    // The mirror partial: highlights present, explanation omitted. rubyNote and
    // the "Ruby's read" block read ok.explanation.* — must degrade, not crash.
    mockSnapshotQuery.mockReturnValue(
      hookState({
        data: {
          ok: true as const,
          symbolRaw: "EURUSD",
          symbol: "EURUSD",
          timeframe: "M15",
          highlights: {
            bias: "WAIT" as const,
            confidenceLabel: "Low",
            confidenceScore: 10,
            volatilityLabel: "Normal",
            trendState: "Ranging",
            entryZone: null,
            suggestedStop: null,
            suggestedTakeProfit: null,
            riskRewardRatio: 0,
            riskWarnings: [],
          },
          upcomingEvents: [],
          newsRisk: { riskLevel: "LOW", blockTrading: false, summary: "" },
          generatedAt: new Date().toISOString(),
          cacheHit: false,
        },
      }),
    );
    render(<SelectedMarketPanel />);

    expect(screen.getByTestId("selected-market-snapshot-pending")).toBeTruthy();
    expect(screen.queryByTestId("btn-open-ticket-buy")).toBeNull();
    expect(screen.queryByTestId("selected-market-levels")).toBeNull();
    expect(screen.queryByTestId("live-trade-ticket-stub")).toBeNull();
  });
});
