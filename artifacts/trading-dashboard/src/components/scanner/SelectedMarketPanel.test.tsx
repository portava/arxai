import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within, act } from "@testing-library/react";
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
vi.mock("@/hooks/useSelectedMarketSnapshot", () => ({
  useSelectedMarketSnapshot: () => ({ ...mockSnapshotQuery(), queryKey: ["scanner", "selected-market", 1, "EURUSD", "M15"], enabled: true, refresh: vi.fn() }),
}));
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

// ── What the panel states must match what was observed ──────────────────────
// A complete, live-confirmed snapshot (levels present) that individual tests
// degrade one field at a time.
function liveOkSnapshot(over: Record<string, unknown> = {}) {
  return {
    ...degradedOkSnapshot(),
    highlights: {
      bias: "BUY" as const,
      confidenceLabel: "High",
      confidenceScore: 82,
      volatilityLabel: "Normal",
      trendState: "bullish",
      entryZone: { low: 1.103, high: 1.1036 },
      suggestedStop: 1.1,
      suggestedTakeProfit: 1.11,
      riskRewardRatio: 2,
      riskWarnings: [],
    },
    explanation: {
      ...degradedOkSnapshot().explanation,
      hedge: "This looks like a possible buy setup right now.",
    },
    newsRisk: { riskLevel: "none", blockTrading: false, summary: "", calendarChecked: true },
    dataSource: "LIVE_FEED",
    dataSourceLabel: "MT5 broker feed",
    dataState: "LIVE_CONFIRMED" as const,
    dataAsOf: new Date(Date.now() - 60_000).toISOString(),
    levelsWithheld: false,
    levelsWithheldReason: null,
    ...over,
  };
}

describe("SelectedMarketPanel — labels describe what was observed", () => {
  it("a data time stamped in the future never reads as 'Data as of 0s ago'", () => {
    mockSnapshotQuery.mockReturnValue(hookState({
      data: liveOkSnapshot({ dataAsOf: new Date(Date.now() + 3 * 3600_000).toISOString() }),
    }));
    render(<SelectedMarketPanel />);
    const label = screen.getByTestId("text-selected-last-updated").textContent ?? "";
    expect(label).not.toContain("0s ago");
    expect(label).toContain("unconfirmed");
  });

  it("a STALE snapshot never shows BUY, confidence, trend or levels, even if the payload carries them", () => {
    // A stale feed with the pre-fix envelope: BUY / High / bullish + levels.
    mockSnapshotQuery.mockReturnValue(hookState({
      data: liveOkSnapshot({ dataState: "STALE", readWithheldReason: undefined }),
    }));
    render(<SelectedMarketPanel />);
    expect(screen.queryByTestId("badge-selected-bias")).toBeNull();
    expect(screen.getByTestId("badge-read-withheld").textContent).toBe("No directional read");
    expect(screen.queryByTestId("selected-market-levels")).toBeNull();
    expect(screen.getByTestId("selected-market-levels-withheld").textContent).toContain("not confirmed live");
    const panelText = screen.getByTestId("selected-market-panel").textContent ?? "";
    expect(panelText).not.toContain("High confidence");
    expect(panelText).not.toContain("Trend bullish");
  });

  it("a LIVE_CONFIRMED snapshot with levels still shows its read", () => {
    mockSnapshotQuery.mockReturnValue(hookState({ data: liveOkSnapshot({ readWithheldReason: null }) }));
    render(<SelectedMarketPanel />);
    expect(screen.getByTestId("badge-selected-bias").textContent).toBe("BUY");
    expect(screen.getByTestId("selected-market-levels")).toBeTruthy();
  });

  it("an unchecked calendar never reads as a quiet day", () => {
    for (const newsRisk of [
      { riskLevel: "none", blockTrading: false, summary: "", calendarChecked: false,
        calendarNote: "No economic-calendar provider is configured, so scheduled events were not checked." },
      { riskLevel: "none", blockTrading: false, summary: "" },
    ]) {
      mockSnapshotQuery.mockReturnValue(hookState({ data: liveOkSnapshot({ newsRisk, upcomingEvents: [] }) }));
      render(<SelectedMarketPanel />);
      const text = screen.getByTestId("selected-market-panel").textContent ?? "";
      expect(text).not.toContain("No medium/high impact events");
      expect(screen.getByTestId("badge-selected-news-risk").textContent).toContain("unknown");
      expect(screen.getByTestId("text-selected-calendar-note").textContent).toMatch(/not checked|could not be checked/);
      cleanup();
    }
  });

  it("a checked calendar with no events says so", () => {
    mockSnapshotQuery.mockReturnValue(hookState({ data: liveOkSnapshot({ upcomingEvents: [] }) }));
    render(<SelectedMarketPanel />);
    expect(screen.getByTestId("selected-market-panel").textContent).toContain("No medium/high impact events in the next 24h.");
  });

  it("an event countdown is computed from the event time, not a cached minute offset", () => {
    // A cached envelope built ~45 s ago still says minutesUntil 1, but the
    // release started 20 s ago.
    const eventTime = new Date(Date.now() - 20_000).toISOString();
    mockSnapshotQuery.mockReturnValue(hookState({
      data: liveOkSnapshot({
        upcomingEvents: [{ externalId: "e1", title: "US CPI", currency: "USD", impactLevel: "HIGH", eventTime, minutesUntil: 1 }],
      }),
    }));
    render(<SelectedMarketPanel />);
    const countdown = screen.getByTestId("text-selected-event-countdown").textContent ?? "";
    expect(countdown).not.toBe("in 1m");
    expect(countdown).toBe("just now");
  });
});

// Truth fix — a STALE / SYNCING selected-market envelope whose levels passed the
// stale-level guard used to print BUY + numeric entry/stop/target in Highlights
// while the reasoning block beside it said "WAIT — live feed not confirmed" and
// "withheld until a confirmed live feed".
describe("SelectedMarketPanel — Highlights agree with the reasoning block on a non-live feed", () => {
  function staleLevelsSnapshot(dataState: "STALE" | "SYNCING") {
    const base = degradedOkSnapshot();
    return {
      ...base,
      highlights: {
        ...base.highlights,
        bias: "BUY" as const,
        confidenceLabel: "High",
        entryZone: { low: 1.0841, high: 1.0849 },
        suggestedStop: 1.0821,
        suggestedTakeProfit: 1.0891,
        riskRewardRatio: 2,
      },
      dataSource: "LIVE_FEED",
      dataSourceLabel: "MT5 broker feed",
      dataState,
      dataAsOf: new Date(Date.now() - 120_000).toISOString(),
      levelsWithheld: false,
    };
  }

  it.each(["STALE", "SYNCING"] as const)("%s: no numeric levels and no bare BUY badge", (dataState) => {
    mockSnapshotQuery.mockReturnValue(hookState({ data: staleLevelsSnapshot(dataState) }));
    render(<SelectedMarketPanel />);
    const reasoning = screen.getByTestId("opp-map-reasoning").textContent ?? "";
    expect(reasoning).toMatch(/withheld until a confirmed live feed/);
    expect(screen.queryByTestId("selected-market-levels")).toBeNull();
    // Merged with the withheld-read rule: no bias badge at all on a non-live feed.
    expect(screen.getByTestId("selected-market-levels-withheld")).toBeTruthy();
    expect(screen.queryByTestId("badge-selected-bias")).toBeNull();
    expect(screen.getByTestId("badge-read-withheld").textContent).toBe("No directional read");
  });
});

// Truth fix — "Data as of Xs ago" used dataAsOf (the newest provider bar's
// closeTime, a FUTURE scheduled close for a forming bar) with negatives clamped
// to 0, and was computed once per render with no ticking clock.
describe("SelectedMarketPanel — 'Data as of' is an observed, advancing age", () => {
  afterEach(() => { vi.useRealTimers(); });

  function liveSnapshot(dataAsOf: string) {
    return { ...degradedOkSnapshot(), dataSource: "LIVE_FEED", dataState: "LIVE_CONFIRMED" as const, dataAsOf };
  }

  it("never reads 'Data as of 0s ago' for a forming bar's future close", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const now = Date.parse("2026-10-28T10:40:00.000Z"); vi.setSystemTime(now);
    mockSnapshotQuery.mockReturnValue(hookState({ data: liveSnapshot(new Date(now + 10 * 60_000).toISOString()) }));
    render(<SelectedMarketPanel />);
    const label = () => screen.getByTestId("text-selected-last-updated").textContent ?? "";
    expect(label()).not.toContain("0s ago");
    expect(label()).toContain("Data time unconfirmed");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(label()).not.toContain("0s ago");
  });

  it("advances the age between renders", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const now = Date.parse("2026-10-28T10:40:00.000Z"); vi.setSystemTime(now);
    mockSnapshotQuery.mockReturnValue(hookState({ data: liveSnapshot(new Date(now - 4_000).toISOString()) }));
    render(<SelectedMarketPanel />);
    const label = () => screen.getByTestId("text-selected-last-updated").textContent ?? "";
    expect(label()).toBe("Data as of 4s ago");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(label()).toBe("Data as of 1m ago");
  });
});

// Truth audit 2026-10-28 (round 3) — one level is one string in this panel.
// The Highlights box printed the raw number (1.08523, 33588.0069) while the
// Ruby Reasoning S/R row beside it rounded with a fixed magnitude rule
// (1.0852, 33588.01), so one level read at two precisions and the reasoning
// row dropped digits the venue quoted.
describe("SelectedMarketPanel — Highlights and the reasoning block print one level as one string", () => {
  function levels(entryZone: { low: number; high: number }, stop: number, target: number) {
    const base = liveOkSnapshot({ readWithheldReason: null });
    return {
      ...base,
      highlights: { ...base.highlights, entryZone, suggestedStop: stop, suggestedTakeProfit: target },
    };
  }
  function highlightsText(): string {
    return screen.getByTestId("selected-market-levels").textContent ?? "";
  }
  function srText(): string {
    return screen.getByTestId("opp-map-reasoning-evidence-supportResistance").textContent ?? "";
  }

  it("EURUSD 5-digit levels read the same in both boxes", () => {
    mockSnapshotQuery.mockReturnValue(hookState({ data: levels({ low: 1.08523, high: 1.08561 }, 1.08401, 1.08811) }));
    render(<SelectedMarketPanel />);
    expect(highlightsText()).toContain("1.08523 – 1.08561");
    expect(srText()).toContain("Entry 1.08523 – 1.08561");
    expect(srText()).toContain("stop 1.08401");
    expect(srText()).toContain("target 1.08811");
    expect(highlightsText()).toContain("1.08401");
    expect(highlightsText()).toContain("1.08811");
  });

  it("V75 levels keep the venue's 4 decimals in the reasoning row", () => {
    mockSnapshotQuery.mockReturnValue(hookState({ data: levels({ low: 33588.0069, high: 33590.5 }, 33570.25, 33620.125) }));
    render(<SelectedMarketPanel />);
    expect(srText()).toContain("Entry 33588.0069 – 33590.5000");
    expect(highlightsText()).toContain("33588.0069 – 33590.5000");
    expect(srText()).toContain("stop 33570.2500");
    expect(highlightsText()).toContain("33570.2500");
    expect(srText()).not.toContain("33588.01");
  });

  it("the shared scanner truth's precision applies to both boxes", () => {
    mockUseScannerTruth.mockReturnValue({ truth: { ...degradedTruth(), candles: { reason: "", pricePrecision: 5 } } as unknown as ScannerTruth });
    mockSnapshotQuery.mockReturnValue(hookState({ data: levels({ low: 1.103, high: 1.1036 }, 1.1, 1.11) }));
    render(<SelectedMarketPanel />);
    expect(highlightsText()).toContain("1.10300 – 1.10360");
    expect(srText()).toContain("Entry 1.10300 – 1.10360, stop 1.10000, target 1.11000");
  });
});
