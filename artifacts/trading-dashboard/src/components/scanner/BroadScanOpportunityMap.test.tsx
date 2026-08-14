import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type {
  MeOpportunityMapResp,
  OpportunityMapResult,
  OpportunityMapRow,
  OpportunityMapRowCategory,
  OpportunitySkippedSymbol,
} from "@workspace/api-client-react";

// Frontend smoke for the Broad Scan "Opportunity Map" (Task #195). The map reads
// ONLY the read-only GET /api/me/opportunity-map endpoint via the generated hook,
// which we mock here so the test is a pure render proof:
//
//   1. Honest loading / error / empty states render without crashing.
//   2. Categorized buckets (incl. TOO_LATE) render with their rows.
//   3. The honest dataNote (no live data) surfaces when present.
//   4. Best-vs-selected surfaces a cleaner alternative and its Switch action
//      calls onPick with the alternative's symbol (no trade is ever placed).
//
// The categorizer's own determinism + no-fabrication is proven in
// scannerExplanationTest; this guards the renderer + its query wiring.

const mockUseGetMeOpportunityMap = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetMeOpportunityMap: (...args: unknown[]) => mockUseGetMeOpportunityMap(...args),
  getGetMeOpportunityMapQueryKey: () => ["get-me-opportunity-map"],
}));

// Task #608. The map self-consumes the SAME selected-symbol feed verdict the
// chart header & Ruby Chart Read use (`useSymbolTruth` at the chart timeframe).
// The whole api-client module is mocked above, so we mock the consuming hooks
// directly. Defaults are inert (no truth, default timeframe) so every existing
// render proof behaves exactly as before; the reconciliation suite below drives
// them to assert the cross-surface cap.
const mockUseSymbolTruth = vi.fn(() => ({ scannerTruth: null }) as Record<string, unknown>);
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: (...args: unknown[]) => mockUseSymbolTruth(...args),
}));
const mockUseScannerTimeframe = vi.fn<[], [string, (tf: string) => void]>(() => [
  "15m",
  () => {},
]);
vi.mock("@/hooks/useScannerTimeframe", () => ({
  useScannerTimeframe: () => mockUseScannerTimeframe(),
  loadScannerTimeframe: () => "15m",
}));

import { BroadScanOpportunityMap } from "./BroadScanOpportunityMap";

function row(over: Partial<OpportunityMapRow> = {}): OpportunityMapRow {
  return {
    symbol: "EURUSD",
    displayName: "EURUSD",
    direction: "BUY",
    recommendedAction: "BUY",
    setupType: "Trend continuation",
    edgeScore: 72,
    entryQuality: 64,
    executionQuality: 80,
    newsRisk: "none",
    hasLiveData: true,
    isLate: false,
    reason: "Clean trend pullback",
    category: "READY_NOW",
    kind: "MOMENTUM",
    bestAction: "Entry is open — consider a buy and manage risk to the stop.",
    stageLabel: "Ready now",
    ...over,
  };
}

function emptyCategories(): Record<OpportunityMapRowCategory, OpportunityMapRow[]> {
  return {
    READY_NOW: [],
    FORMING_SOON: [],
    WATCH_AFTER_NEWS: [],
    TOO_LATE: [],
    AVOID: [],
    NO_CLEAN_SETUP: [],
  };
}

function mapResult(rows: OpportunityMapRow[]): OpportunityMapResult {
  const categories = emptyCategories();
  for (const r of rows) categories[r.category].push(r);
  return {
    rows,
    categories,
    best: {
      bestScalp: rows.find((r) => r.category === "READY_NOW") ?? null,
      bestRetest: null,
      bestMomentum: rows.find((r) => r.kind === "MOMENTUM") ?? null,
      bestReversal: null,
    },
    scannedCount: rows.length,
    liveCount: rows.filter((r) => r.hasLiveData).length,
  };
}

function resp(over: Partial<MeOpportunityMapResp> = {}): MeOpportunityMapResp {
  return {
    universe: "all",
    timeframe: "M5",
    map: mapResult([
      row({}),
      row({ symbol: "USDJPY", displayName: "USDJPY", category: "TOO_LATE", isLate: true, kind: "MOMENTUM" }),
    ]),
    bestVsSelected: {
      hasCleanerAlternative: false,
      selectedSymbol: null,
      selectedEdge: null,
      best: null,
      message: null,
    },
    dataNote: null,
    ...over,
  } as MeOpportunityMapResp;
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
  mockUseGetMeOpportunityMap.mockReset();
  mockUseSymbolTruth.mockReset();
  mockUseSymbolTruth.mockReturnValue({ scannerTruth: null });
  mockUseScannerTimeframe.mockReset();
  mockUseScannerTimeframe.mockReturnValue(["15m", () => {}]);
});
afterEach(() => cleanup());

// A `useSymbolTruth` return whose consolidated verdict is `verdict` — the exact
// shape the chart header & Ruby Chart Read read from. Only the field the map
// consumes (`consolidated.scannerActionability`) needs to be present.
function truthWithVerdict(verdict: string): Record<string, unknown> {
  return { scannerTruth: { consolidated: { scannerActionability: verdict } } };
}

describe("BroadScanOpportunityMap — honest render states", () => {
  it("renders the loading state without crashing", () => {
    mockUseGetMeOpportunityMap.mockReturnValue(hookState({ isLoading: true }));
    render(<BroadScanOpportunityMap marketGroup="all" />);
    expect(screen.getByTestId("opportunity-map")).toBeTruthy();
    expect(screen.getByText(/Scanning the markets/i)).toBeTruthy();
  });

  it("renders the error state honestly", () => {
    mockUseGetMeOpportunityMap.mockReturnValue(hookState({ isError: true }));
    render(<BroadScanOpportunityMap marketGroup="all" />);
    expect(screen.getByTestId("opportunity-map-err")).toBeTruthy();
  });

  it("renders the empty state honestly", () => {
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({ data: resp({ map: mapResult([]) }) }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" />);
    expect(screen.getByTestId("opportunity-map-empty")).toBeTruthy();
  });

  it("renders categorized buckets including TOO_LATE", () => {
    mockUseGetMeOpportunityMap.mockReturnValue(hookState({ data: resp() }));
    render(<BroadScanOpportunityMap marketGroup="all" />);
    expect(screen.getByTestId("opportunity-map-cat-READY_NOW")).toBeTruthy();
    expect(screen.getByTestId("opportunity-map-cat-TOO_LATE")).toBeTruthy();
    expect(screen.getByTestId("opportunity-row-USDJPY")).toBeTruthy();
  });

  it("renders per-row execution quality and reason", () => {
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          map: mapResult([
            row({ executionQuality: 81, reason: "Clean trend pullback into the zone" }),
          ]),
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" />);
    expect(screen.getByTestId("opportunity-row-stats-EURUSD").textContent).toContain("Feed 81");
    expect(screen.getByTestId("opportunity-row-reason-EURUSD").textContent).toContain(
      "Clean trend pullback",
    );
  });

  it("renders the ONE shared action verdict (badge + copy), not the bestAction prose", () => {
    // Task #600: a live READY_NOW row shows the shared verdict badge ("Ready now")
    // and its single guidance line from SCANNER_ACTIONABILITY_UI ("…you can act
    // now."), never the old free-text bestAction prose — so the broad-scan row can
    // never disagree with the cards/header about what to do with this market.
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          map: mapResult([
            row({
              symbol: "EURUSD",
              displayName: "EURUSD",
              category: "READY_NOW",
              hasLiveData: true,
              bestAction: "Entry is open — consider a buy and manage risk to the stop.",
            }),
          ]),
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" />);
    // The shared verdict badge renders with the canonical label…
    expect(screen.getByTestId("opportunity-row-verdict-EURUSD").textContent).toContain(
      "Ready now",
    );
    // …the action line is the shared copy, always rendered…
    expect(screen.getByTestId("opportunity-row-action-EURUSD").textContent ?? "").toMatch(
      /act now/i,
    );
    // …the row's data-actionability reflects the ONE verdict…
    expect(
      screen.getByTestId("opportunity-row-EURUSD").getAttribute("data-actionability"),
    ).toBe("READY_NOW");
    // …and the old per-row bestAction prose no longer appears anywhere.
    expect(screen.queryByText(/Entry is open/i)).toBeNull();
  });

  it("never renders a direction or scores for a row without live data (truth cap)", () => {
    // Simulator-fallback shape: a non-synthetic symbol (TSLA) with no live feed.
    // The scanner computes a direction/edge from the in-memory simulator, but
    // the map must surface ONLY the awaiting-live-data state — the "BUY · Edge 78
    // · no live data" screenshot is unrepresentable.
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          map: mapResult([
            row({
              symbol: "TSLA",
              displayName: "TSLA",
              hasLiveData: false,
              direction: "BUY",
              recommendedAction: "BUY",
              edgeScore: 78,
              entryQuality: 70,
              executionQuality: 0,
              category: "NO_CLEAN_SETUP",
              stageLabel: "No clean setup",
              bestAction: "Awaiting live data before this market can be read.",
              reason: "Simulator read: bullish drift",
            }),
          ]),
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" />);
    // The row exists and shows the awaiting state…
    expect(screen.getByTestId("opportunity-row-TSLA")).toBeTruthy();
    expect(screen.getByTestId("opportunity-row-awaiting-TSLA")).toBeTruthy();
    // …but renders NO direction badge and NO score line.
    expect(screen.queryByTestId("opportunity-row-direction-TSLA")).toBeNull();
    expect(screen.queryByTestId("opportunity-row-stats-TSLA")).toBeNull();
    // No simulator-derived numbers, direction, or read text leak into the row.
    const rowEl = screen.getByTestId("opportunity-row-TSLA");
    expect(rowEl.textContent).not.toContain("Edge 78");
    expect(rowEl.textContent).not.toContain("BUY");
    expect(rowEl.textContent).not.toContain("Simulator");
  });

  it("surfaces the honest no-live-data note when present", () => {
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          map: mapResult([row({ hasLiveData: false, category: "NO_CLEAN_SETUP" })]),
          dataNote: "No live market data right now — connect a live feed to read these markets.",
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" />);
    expect(screen.getByTestId("opportunity-map-data-note")).toBeTruthy();
  });

  it("calls onPick with the cleaner alternative when Switch is pressed", () => {
    const onPick = vi.fn();
    const best = row({ symbol: "GBPUSD", displayName: "GBPUSD", edgeScore: 80 });
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          bestVsSelected: {
            hasCleanerAlternative: true,
            selectedSymbol: "EURUSD",
            selectedEdge: 60,
            best,
            message: "GBPUSD looks cleaner than EURUSD right now (edge 80 vs 60).",
          },
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" selectedSymbol="EURUSD" onPick={onPick} />);
    fireEvent.click(screen.getByTestId("opportunity-map-switch"));
    expect(onPick).toHaveBeenCalledWith("GBPUSD");
  });
});

// ── Task #600 scanner-truth regression — assertions (5) + (8) ────────────────
//
// (5) When 16 of 23 universe symbols are scanned, the 7 dropped symbols are
//     listed with their concrete reasons — "N of M scanned" reconciles to the
//     full universe with NO silent drops.
// (8) Scanner scores are real per-row evidence, not placeholders/defaults: two
//     live rows with different inputs render different Edge/Entry/Exec, and a row
//     without live data renders NO score line at all (no fabricated default).
function skipped(over: Partial<OpportunitySkippedSymbol>): OpportunitySkippedSymbol {
  return { symbol: "X", displayName: "X", reason: "MISSING_FEED", ...over };
}

describe("(5)+(8) Broad Scan reconciles the universe and shows real scores", () => {
  it("(5) 16 of 23 scanned lists all 7 skipped symbols with their reasons", () => {
    const skippedSymbols: OpportunitySkippedSymbol[] = [
      skipped({ symbol: "USDCHF", displayName: "USDCHF", reason: "MISSING_FEED" }),
      skipped({ symbol: "AUDUSD", displayName: "AUDUSD", reason: "LIMITED_HISTORY" }),
      skipped({ symbol: "NZDUSD", displayName: "NZDUSD", reason: "STALE_DATA" }),
      skipped({ symbol: "TSLA", displayName: "TSLA", reason: "UNSUPPORTED_SYMBOL" }),
      skipped({ symbol: "XAUUSD", displayName: "XAUUSD", reason: "PROVIDER_ERROR" }),
      skipped({ symbol: "BTCUSD", displayName: "BTCUSD", reason: "EXCLUDED_BY_FILTER" }),
      skipped({ symbol: "GBPJPY", displayName: "GBPJPY", reason: "MISSING_FEED" }),
    ];
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          map: { ...mapResult([row({})]), scannedCount: 16, liveCount: 16 },
          universeCount: 23,
          skippedSymbols,
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" />);

    // Header reconciles to the full universe.
    expect(screen.getByTestId("opportunity-map-summary").textContent).toContain(
      "16 of 23 scanned",
    );
    expect(screen.getByTestId("opportunity-map-skipped-count").textContent).toContain(
      "7 skipped",
    );

    // The skipped block accounts for the difference, with every symbol listed.
    const block = screen.getByTestId("opportunity-map-skipped");
    expect(block.textContent).toContain("7 of 23 not scanned");
    for (const s of skippedSymbols) {
      expect(screen.getByTestId(`opportunity-map-skipped-${s.symbol}`)).toBeTruthy();
    }
    // Every distinct skipped reason is surfaced as its own human copy — a wrong
    // or collapsed reason label must fail here (not just symbol presence).
    expect(screen.getByTestId("opportunity-map-skipped-USDCHF").textContent).toContain(
      "No live feed", // MISSING_FEED
    );
    expect(screen.getByTestId("opportunity-map-skipped-AUDUSD").textContent).toContain(
      "Limited history", // LIMITED_HISTORY
    );
    expect(screen.getByTestId("opportunity-map-skipped-NZDUSD").textContent).toContain(
      "Stale data", // STALE_DATA
    );
    expect(screen.getByTestId("opportunity-map-skipped-TSLA").textContent).toContain(
      "Not supported", // UNSUPPORTED_SYMBOL
    );
    expect(screen.getByTestId("opportunity-map-skipped-XAUUSD").textContent).toContain(
      "Data error", // PROVIDER_ERROR
    );
    expect(screen.getByTestId("opportunity-map-skipped-BTCUSD").textContent).toContain(
      "Filtered out", // EXCLUDED_BY_FILTER
    );
    expect(screen.getByTestId("opportunity-map-skipped-GBPJPY").textContent).toContain(
      "No live feed", // MISSING_FEED (second occurrence)
    );

    // The invariant: scanned + skipped === universe.
    expect(16 + skippedSymbols.length).toBe(23);
  });

  it("(8) per-row scores are real evidence, never placeholders/defaults", () => {
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          map: mapResult([
            row({ symbol: "EURUSD", displayName: "EURUSD", edgeScore: 72, entryQuality: 64, executionQuality: 80 }),
            row({ symbol: "GBPUSD", displayName: "GBPUSD", edgeScore: 41, entryQuality: 88, executionQuality: 53 }),
            row({
              symbol: "TSLA",
              displayName: "TSLA",
              hasLiveData: false,
              category: "NO_CLEAN_SETUP",
              edgeScore: 99,
              entryQuality: 99,
              executionQuality: 99,
            }),
          ]),
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" />);

    const eur = screen.getByTestId("opportunity-row-stats-EURUSD").textContent ?? "";
    const gbp = screen.getByTestId("opportunity-row-stats-GBPUSD").textContent ?? "";
    // Each row reflects its OWN inputs exactly…
    expect(eur).toContain("Edge 72");
    expect(eur).toContain("Entry 64");
    // "Feed" (not "Exec"): the value is feed-derived execution-readiness, not a
    // fabricated per-symbol execution score — Task #790 honest labelling.
    expect(eur).toContain("Feed 80");
    expect(gbp).toContain("Edge 41");
    expect(gbp).toContain("Entry 88");
    expect(gbp).toContain("Feed 53");
    // …so two rows with different evidence can never render identical scores.
    expect(eur).not.toBe(gbp);
    // A row WITHOUT live data renders no score line at all — no fabricated 99 default.
    expect(screen.queryByTestId("opportunity-row-stats-TSLA")).toBeNull();
    expect(screen.getByTestId("opportunity-row-TSLA").textContent).not.toContain("99");
  });
});

// ── Task #605 — the map reports real scan-existence up to the page ───────────
//
// Bug #2 wired this map's `onScanned` callback into the page's own `scanExists`
// signal, so the legacy results block below can never claim "No scan run yet"
// while a populated opportunity map sits directly above it. This locks that
// callback contract at the source: a real scan (the server stamped a
// `generatedAt`, OR ≥1 symbol was scanned) reports `true`; a genuine no-scan
// payload (and the loading state) reports `false`. A regression that stops
// firing — or fires the wrong value — re-opens the populated-map-vs-"No scan
// run yet" contradiction.
describe("Task #605 — onScanned reports real scan-existence to the page", () => {
  it("fires onScanned(true) when the server stamped a generatedAt (even with zero rows)", () => {
    const onScanned = vi.fn();
    // generatedAt branch in isolation: a stamped scan that returned no rows is
    // still a REAL scan — the page must not call it "never scanned".
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({ data: resp({ generatedAt: "2026-06-08T11:00:00Z", map: mapResult([]) }) }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" onScanned={onScanned} />);
    expect(onScanned).toHaveBeenCalledWith(true);
    expect(onScanned).not.toHaveBeenCalledWith(false);
  });

  it("fires onScanned(true) when ≥1 symbol was scanned (no generatedAt stamp)", () => {
    const onScanned = vi.fn();
    // scannedCount branch in isolation: generatedAt intentionally absent, so the
    // scanned-count alone must report a real scan.
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({ data: resp({ map: mapResult([row({})]) }) }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" onScanned={onScanned} />);
    expect(onScanned).toHaveBeenCalledWith(true);
    expect(onScanned).not.toHaveBeenCalledWith(false);
  });

  it("fires onScanned(false) for a genuine no-scan payload (no generatedAt, zero scanned)", () => {
    const onScanned = vi.fn();
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({ data: resp({ map: mapResult([]) }) }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" onScanned={onScanned} />);
    expect(onScanned).toHaveBeenCalledWith(false);
    expect(onScanned).not.toHaveBeenCalledWith(true);
  });

  it("fires onScanned(false) while the map is still loading (no data yet)", () => {
    const onScanned = vi.fn();
    mockUseGetMeOpportunityMap.mockReturnValue(hookState({ isLoading: true }));
    render(<BroadScanOpportunityMap marketGroup="all" onScanned={onScanned} />);
    expect(onScanned).toHaveBeenCalledWith(false);
    expect(onScanned).not.toHaveBeenCalledWith(true);
  });
});

// ── A degraded-feed opportunity row never reads as live-confirmed / actionable ─
//
// The remaining Scanner honesty contradiction (after "the map suppresses No-scan
// run yet", the RubyChartRead trust chip, and the honest empty state): a VISIBLE
// Broad Scan opportunity row that renders with real setup structure while the
// feed is historical-only / unconfirmed / stale / not live. Such a row may carry
// context, but it must NEVER label the opportunity as a live feed, verified,
// live-confirmed, execution-ready, or ready-to-trade.
//
// `OpportunityRowCard` caps display off `row.hasLiveData`: a non-live row routes
// through `rowActionability` (all-UNAVAILABLE data + UNKNOWN setup) → the
// FEED_LIMITED verdict, hides the direction badge / Edge·Entry·Exec stats /
// reason, and shows the "No live data" badge. These proofs lock both that honest
// degrade AND the absence of any affirmative live/ready claim from the row —
// including when the backend itself bucketed the row READY_NOW.
//
// Scope note: the forbidden-claim checks are CASE-SENSITIVE and scoped to the
// ROW element. The honest FEED_LIMITED copy itself contains the lowercase
// substring "live feed" ("The live feed isn't fully confirmed …"), so a
// case-insensitive or document-wide check would false-fail on the very copy that
// tells the truth — the affirmative claim we forbid is the Title-case badge form.
// The READY_NOW group-header blurb ("…with live data — act-ready") and the
// page-level dataNote both live OUTSIDE the row, so scoping to the row is what
// makes the negative assertion meaningful.
//
// TEST-ONLY: asserts existing component behaviour; no component, contract,
// resolver, or backend change.
const FORBIDDEN_LIVE_READY_CLAIMS = [
  "Live feed",
  "Verified",
  "AACI verified",
  "Live-confirmed",
  "Execution-ready",
  "Ready to trade",
  "Trade now",
];

describe("BroadScanOpportunityMap — a degraded-feed row never reads as live-confirmed / actionable", () => {
  it("a row with full setup structure but a non-live (historical-only) feed degrades to the honest 'Feed limited' verdict with no live-ready claim", () => {
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          map: mapResult([
            row({
              symbol: "GBPUSD",
              displayName: "GBPUSD",
              // Feed is historical-only / not live-confirmed…
              hasLiveData: false,
              // …yet the row carries enough structure to render a card.
              direction: "BUY",
              recommendedAction: "BUY",
              edgeScore: 80,
              entryQuality: 75,
              executionQuality: 90,
              category: "NO_CLEAN_SETUP",
              stageLabel: "No clean setup",
              reason: "Historical-only read: clean pullback into the zone",
              bestAction: "Awaiting a live feed before this market can be read.",
            }),
          ]),
          dataNote: "Historical-only data — the feed isn't live-confirmed right now.",
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" />);

    // The row renders (it is not dropped) and shows the honest degraded wording…
    const rowEl = screen.getByTestId("opportunity-row-GBPUSD");
    expect(rowEl).toBeTruthy();
    expect(screen.getByTestId("opportunity-row-awaiting-GBPUSD").textContent).toContain(
      "No live data",
    );
    expect(screen.getByTestId("opportunity-row-verdict-GBPUSD").textContent).toContain(
      "Feed limited",
    );
    expect(rowEl.getAttribute("data-actionability")).toBe("FEED_LIMITED");
    expect(screen.getByTestId("opportunity-row-action-GBPUSD").textContent ?? "").toMatch(
      /not a live entry/i,
    );
    // …and the honest page-level note names the degraded feed.
    expect(screen.getByTestId("opportunity-map-data-note").textContent ?? "").toMatch(
      /historical-only/i,
    );

    // No live affordances (direction badge / score line) leak into the row…
    expect(screen.queryByTestId("opportunity-row-direction-GBPUSD")).toBeNull();
    expect(screen.queryByTestId("opportunity-row-stats-GBPUSD")).toBeNull();
    expect(rowEl.textContent).not.toContain("Edge 80");
    // …and NO affirmative live/verified/execution-ready claim appears in the row.
    const rowText = rowEl.textContent ?? "";
    for (const claim of FORBIDDEN_LIVE_READY_CLAIMS) {
      expect(rowText).not.toContain(claim);
    }
  });

  it("a degraded-feed row the backend bucketed READY_NOW still degrades — the card never inherits a live-ready verdict from the category", () => {
    // Contradiction fixture: the server placed this row in READY_NOW, but the
    // feed is not live. The card must override the category and degrade — a
    // "Ready now / act now" verdict on an unconfirmed feed is the exact false
    // live-ready claim this lock forbids.
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          map: mapResult([
            row({
              symbol: "USDJPY",
              displayName: "USDJPY",
              hasLiveData: false,
              direction: "SELL",
              recommendedAction: "SELL",
              edgeScore: 88,
              entryQuality: 82,
              executionQuality: 91,
              category: "READY_NOW",
              stageLabel: "Ready now",
              reason: "Historical-only read: momentum continuation",
              bestAction: "Entry is open — consider a sell.",
            }),
          ]),
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" />);

    const rowEl = screen.getByTestId("opportunity-row-USDJPY");
    // The card overrides the READY_NOW bucket: the row's own verdict is the
    // feed-limited cap, never a live-ready one…
    expect(rowEl.getAttribute("data-actionability")).toBe("FEED_LIMITED");
    expect(screen.getByTestId("opportunity-row-verdict-USDJPY").textContent).toContain(
      "Feed limited",
    );
    const actionText = screen.getByTestId("opportunity-row-action-USDJPY").textContent ?? "";
    expect(actionText).toMatch(/not a live entry/i);
    // …the affirmative READY_NOW verdict + its "act now" copy never reach the row…
    expect(rowEl.textContent).not.toContain("Ready now");
    expect(actionText).not.toMatch(/act now/i);
    // …no direction / score affordances leak…
    expect(screen.queryByTestId("opportunity-row-direction-USDJPY")).toBeNull();
    expect(screen.queryByTestId("opportunity-row-stats-USDJPY")).toBeNull();
    // …and NO affirmative live/verified/execution-ready claim appears in the row.
    const rowText = rowEl.textContent ?? "";
    for (const claim of FORBIDDEN_LIVE_READY_CLAIMS) {
      expect(rowText).not.toContain(claim);
    }
  });
});

// ── A degraded-feed opportunity row exposes no execution-implying action ───────
//
// The companion lock to the wording proofs above. Even once the row's COPY is
// honest (degraded → "Feed limited", no live-ready claim), a second risk remains:
// the row could still wire up an action/CTA that implies the opportunity is
// executable ("Trade now", "Execute", "Place trade", "Open ticket", "One-click",
// "Buy"/"Sell", "Ready", "Live trade"). On a non-live / historical-only feed the
// row may carry context and offer SAFE non-execution actions (select/inspect the
// chart), but it must NOT present any execution control.
//
// `OpportunityRowCard` renders the whole card as ONE `<button>` wired only to
// `onPick(symbol)` — a select/inspect action that drives the chart, never a
// trade. There is no nested execution control. These proofs lock that: the row's
// interactive controls carry no execution CTA text, the card nests no execution
// button, and activating it routes to the safe symbol-select handler.
//
// Scope note: as with the wording block, the CTA check is CASE-SENSITIVE and
// scoped to the ROW's controls. The honest FEED_LIMITED copy contains lowercase
// "live feed", and a READY_NOW-bucketed row's group-header label ("Ready now",
// "…act-ready") lives OUTSIDE the row — so a document-wide or case-insensitive
// check would false-fail on truthful copy. The Title-case forms below are the
// execution-implying CTA labels we forbid.
//
// TEST-ONLY: asserts existing component behaviour; no component, contract,
// resolver, or backend change.
const FORBIDDEN_EXECUTION_CTAS = [
  "Trade now",
  "Execute",
  "Place trade",
  "Open ticket",
  "One-click",
  "Buy",
  "Sell",
  "Ready",
  "Live trade",
];

// Every interactive control reachable inside the row: the card element itself
// (when it is a button) plus any nested button / link / role=button. A future
// regression that drops an execution control into the card lands in this set.
function interactiveControls(rowEl: HTMLElement): HTMLElement[] {
  const nested = Array.from(
    rowEl.querySelectorAll<HTMLElement>("button, a[href], [role='button']"),
  );
  const self = rowEl.tagName.toLowerCase() === "button" ? [rowEl] : [];
  return [...self, ...nested];
}

describe("BroadScanOpportunityMap — a degraded-feed row exposes no execution-implying CTA", () => {
  it("exposes NO execution-implying CTA on any control in the row — even when the backend bucketed it READY_NOW", () => {
    const onPick = vi.fn();
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          map: mapResult([
            row({
              symbol: "GBPUSD",
              displayName: "GBPUSD",
              // Feed is historical-only / not live-confirmed…
              hasLiveData: false,
              // …yet it carries full structure and the server bucketed it READY_NOW.
              direction: "BUY",
              recommendedAction: "BUY",
              edgeScore: 80,
              entryQuality: 75,
              executionQuality: 90,
              category: "READY_NOW",
              stageLabel: "Ready now",
              reason: "Historical-only read: clean pullback into the zone",
              bestAction: "Entry is open — consider a buy.",
            }),
          ]),
          dataNote: "Historical-only data — the feed isn't live-confirmed right now.",
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" onPick={onPick} />);

    const rowEl = screen.getByTestId("opportunity-row-GBPUSD");
    // The row still renders as readable, honestly-degraded context…
    expect(rowEl).toBeTruthy();
    expect(rowEl.textContent ?? "").toContain("GBPUSD");
    expect(screen.getByTestId("opportunity-row-verdict-GBPUSD").textContent).toContain(
      "Feed limited",
    );

    // …and NONE of its interactive controls carries execution-implying CTA text.
    const controls = interactiveControls(rowEl);
    expect(controls.length).toBeGreaterThan(0); // the card itself is selectable
    for (const ctl of controls) {
      const text = ctl.textContent ?? "";
      for (const cta of FORBIDDEN_EXECUTION_CTAS) {
        expect(text).not.toContain(cta);
      }
    }
  });

  it("its only wired action is the safe select/inspect (onPick) — there is no nested execution control", () => {
    const onPick = vi.fn();
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          map: mapResult([
            row({
              symbol: "USDJPY",
              displayName: "USDJPY",
              hasLiveData: false,
              direction: "SELL",
              recommendedAction: "SELL",
              edgeScore: 88,
              entryQuality: 82,
              executionQuality: 91,
              category: "NO_CLEAN_SETUP",
              stageLabel: "No clean setup",
              reason: "Historical-only read: momentum continuation",
              bestAction: "Awaiting a live feed before this market can be read.",
            }),
          ]),
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" onPick={onPick} />);

    const rowEl = screen.getByTestId("opportunity-row-USDJPY");
    // The card itself is the single interactive control — a SELECT/inspect
    // affordance, not a trade control — and it nests no execution button.
    expect(rowEl.tagName.toLowerCase()).toBe("button");
    expect(rowEl.querySelectorAll("button").length).toBe(0);

    // Activating it routes to the safe non-execution handler (pick the symbol to
    // inspect on the chart), never an execution path.
    fireEvent.click(rowEl);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("USDJPY");
  });
});

// ── A group/header never claims readiness when ALL its rows are degraded ───────
//
// The parent-level companion to the row + CTA honesty locks above. The rows now
// degrade honestly and expose no execution CTA, but the GROUP header still
// rendered the backend bucket's category label verbatim — so a READY_NOW section
// whose every row is feed-unconfirmed / historical-only / hasLiveData=false read
// "Ready now · Clean setups with live data — act-ready" over rows that each say
// "Feed limited". That parent claim is the remaining contradiction.
//
// The component caps the group header the same way it caps a row: when EVERY row
// in a group lacks live data, the header shows honest degraded wording
// (DEGRADED_GROUP_META) instead of the affirmative category label. A group with
// at least one live row keeps its real category header (so the cap only
// downgrades, never over-suppresses a genuinely-live bucket).
//
// Scope note: these checks are scoped to the group HEADER element
// (`opportunity-map-cat-header-*`), not the whole group div (which also contains
// the rows). The forbidden affirmative phrases are checked case-sensitively
// against the header text; the honest degraded header copy ("Feed limited",
// "Needs live confirmation — context only…") contains none of them.
const FORBIDDEN_GROUP_READY_CLAIMS = [
  "Ready now",
  "act-ready",
  "Act-ready",
  "live data",
  "Live opportunities",
  "Trade-ready",
  "Execution-ready",
];

describe("BroadScanOpportunityMap — an all-degraded group never claims readiness in its header", () => {
  it("a READY_NOW group whose every row is degraded shows an honest degraded header, not 'Ready now / act-ready'", () => {
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          map: mapResult([
            row({
              symbol: "GBPUSD",
              displayName: "GBPUSD",
              hasLiveData: false,
              category: "READY_NOW",
              stageLabel: "Ready now",
              reason: "Historical-only read: clean pullback",
              bestAction: "Awaiting a live feed before this market can be read.",
            }),
            row({
              symbol: "USDJPY",
              displayName: "USDJPY",
              hasLiveData: false,
              category: "READY_NOW",
              kind: "REVERSAL",
              stageLabel: "Ready now",
              reason: "Historical-only read: momentum fade",
              bestAction: "Awaiting a live feed before this market can be read.",
            }),
          ]),
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" />);

    // The group still renders (its rows are not dropped) and is flagged degraded…
    const group = screen.getByTestId("opportunity-map-cat-READY_NOW");
    expect(group.getAttribute("data-group-degraded")).toBe("true");

    // …and its HEADER carries NO affirmative readiness/live claim…
    const header = screen.getByTestId("opportunity-map-cat-header-READY_NOW");
    const headerText = header.textContent ?? "";
    for (const claim of FORBIDDEN_GROUP_READY_CLAIMS) {
      expect(headerText).not.toContain(claim);
    }
    // …it shows honest downgraded group wording instead.
    expect(headerText).toMatch(/feed limited|needs live confirmation|context only/i);
  });

  it("a READY_NOW group with at least one LIVE row keeps its real category header (the cap only downgrades all-degraded groups)", () => {
    // Mixed group: one live ready row + one degraded row. The live row makes the
    // bucket's "Ready now" header truthful, so the header is NOT downgraded; the
    // degraded row still degrades to its own "Feed limited" verdict inside.
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          map: mapResult([
            row({
              symbol: "EURUSD",
              displayName: "EURUSD",
              hasLiveData: true,
              category: "READY_NOW",
              stageLabel: "Ready now",
            }),
            row({
              symbol: "GBPUSD",
              displayName: "GBPUSD",
              hasLiveData: false,
              category: "READY_NOW",
              kind: "REVERSAL",
              stageLabel: "Ready now",
            }),
          ]),
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" />);

    // The group is not flagged degraded (it has a live row)…
    const group = screen.getByTestId("opportunity-map-cat-READY_NOW");
    expect(group.getAttribute("data-group-degraded")).toBe("false");

    // …so the genuine category header is preserved.
    const header = screen.getByTestId("opportunity-map-cat-header-READY_NOW");
    expect(header.textContent ?? "").toContain("Ready now");

    // The degraded row inside still degrades individually (no inherited readiness).
    expect(screen.getByTestId("opportunity-row-verdict-GBPUSD").textContent).toContain(
      "Feed limited",
    );
  });
});

// ── A degraded child row never inherits a MIXED group's readiness ──────────────
//
// The previous block proved an ALL-degraded group downgrades its header, and a
// mixed group keeps its header. This block locks the inverse hazard inside that
// allowed-to-stay-strong mixed group: when a READY_NOW group legitimately keeps
// its "Ready now" header because at least one row is live-confirmed, the
// DEGRADED sibling row sitting in the same group must STILL be capped
// individually — it must not inherit the group's (or the live row's) readiness
// wording or action state.
//
// Fixture: a READY_NOW group with EURUSD (hasLiveData=true, live-confirmed) and
// GBPUSD (hasLiveData=false, historical-only). The header stays "Ready now"; the
// live row keeps its normal ready/live affordances; the degraded row degrades to
// the honest "Feed limited" cap with no live affordances and no execution CTA.
//
// Scope note: assertions about the degraded row are scoped to the GBPUSD row
// element — NEVER document-wide — because the live EURUSD row legitimately
// renders a direction badge / "Ready now" verdict and the group header
// legitimately reads "Ready now". A document-wide check would false-fail on that
// truthful sibling/header copy. The forbidden tokens below are checked
// CASE-SENSITIVE against the degraded row only.
//
// TEST-ONLY: asserts existing component behaviour; no component, contract,
// resolver, or backend change.
const MIXED_GROUP_FORBIDDEN_ON_DEGRADED_ROW = [
  "Trade now",
  "Execution-ready",
  "Live-confirmed",
  "Ready to trade",
  "Buy",
  "Sell",
  "One-click",
];

describe("BroadScanOpportunityMap — a degraded row in a MIXED group stays individually capped", () => {
  function mixedReadyNowState(onPick?: (s: string) => void) {
    void onPick;
    return hookState({
      data: resp({
        map: mapResult([
          // Live-confirmed ready row — makes the group header legitimately strong.
          row({
            symbol: "EURUSD",
            displayName: "EURUSD",
            hasLiveData: true,
            category: "READY_NOW",
            stageLabel: "Ready now",
          }),
          // Degraded sibling in the SAME group — must not inherit that strength.
          row({
            symbol: "GBPUSD",
            displayName: "GBPUSD",
            hasLiveData: false,
            direction: "BUY",
            recommendedAction: "BUY",
            edgeScore: 80,
            entryQuality: 75,
            executionQuality: 90,
            category: "READY_NOW",
            kind: "REVERSAL",
            stageLabel: "Ready now",
            reason: "Historical-only read: clean pullback into the zone",
            bestAction: "Awaiting a live feed before this market can be read.",
          }),
        ]),
        dataNote: "Historical-only data — the feed isn't live-confirmed right now.",
      }),
    });
  }

  it("keeps the group header strong AND the live row ready, while the degraded sibling degrades with no live affordance or execution CTA", () => {
    mockUseGetMeOpportunityMap.mockReturnValue(mixedReadyNowState());
    render(<BroadScanOpportunityMap marketGroup="all" />);

    // The group is mixed (has a live row), so the header legitimately stays strong…
    const group = screen.getByTestId("opportunity-map-cat-READY_NOW");
    expect(group.getAttribute("data-group-degraded")).toBe("false");
    expect(
      screen.getByTestId("opportunity-map-cat-header-READY_NOW").textContent ?? "",
    ).toContain("Ready now");

    // …the LIVE row keeps its normal ready/live affordances (direction + verdict)…
    expect(screen.getByTestId("opportunity-row-direction-EURUSD")).toBeTruthy();
    expect(screen.getByTestId("opportunity-row-verdict-EURUSD").textContent).toContain(
      "Ready now",
    );

    // …but the DEGRADED sibling, in the SAME group, stays capped individually:
    const degraded = screen.getByTestId("opportunity-row-GBPUSD");
    expect(degraded.getAttribute("data-actionability")).toBe("FEED_LIMITED");
    expect(screen.getByTestId("opportunity-row-verdict-GBPUSD").textContent).toContain(
      "Feed limited",
    );
    expect(screen.getByTestId("opportunity-row-action-GBPUSD").textContent ?? "").toMatch(
      /not a live entry/i,
    );

    // No live affordance leaks into the degraded row (no direction badge / scores)…
    expect(screen.queryByTestId("opportunity-row-direction-GBPUSD")).toBeNull();
    expect(screen.queryByTestId("opportunity-row-stats-GBPUSD")).toBeNull();

    // …no execution-implying CTA on any of the degraded row's controls…
    const controls = interactiveControls(degraded);
    expect(controls.length).toBeGreaterThan(0);
    for (const ctl of controls) {
      const text = ctl.textContent ?? "";
      for (const cta of MIXED_GROUP_FORBIDDEN_ON_DEGRADED_ROW) {
        expect(text).not.toContain(cta);
      }
    }

    // …and no execution/ready claim anywhere in the degraded row's own text.
    const degradedText = degraded.textContent ?? "";
    for (const cta of MIXED_GROUP_FORBIDDEN_ON_DEGRADED_ROW) {
      expect(degradedText).not.toContain(cta);
    }
    // The degraded row must not inherit the group/live verdict wording either.
    expect(degradedText).not.toContain("Ready now");
  });

  it("clicking the degraded sibling routes only to the safe select/inspect handler — never an execution path", () => {
    const onPick = vi.fn();
    mockUseGetMeOpportunityMap.mockReturnValue(mixedReadyNowState());
    render(<BroadScanOpportunityMap marketGroup="all" onPick={onPick} />);

    const degraded = screen.getByTestId("opportunity-row-GBPUSD");
    // The degraded card is itself the single interactive control and nests no
    // execution button.
    expect(degraded.tagName.toLowerCase()).toBe("button");
    expect(degraded.querySelectorAll("button").length).toBe(0);

    // Activating it picks the symbol to inspect on the chart — never executes.
    fireEvent.click(degraded);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("GBPUSD");
  });
});

// ── A SELECTED degraded opportunity stays context-only (selected-detail honesty) ─
//
// After a user CLICKS/selects a row, the map re-queries with `selectedSymbol`
// and the server returns a `bestVsSelected` inspector that compares the selected
// symbol to the cleanest live alternative. The risk this block locks: when the
// SELECTED symbol is degraded (hasLiveData=false / feed-limited), NO selected-
// context surface in this component may present it as live-ready or executable —
//   • its own row must stay individually capped (FEED_LIMITED verdict, no
//     direction badge / Edge·Entry·Exec stats, no live-ready claim),
//   • it must never surface as a clean "best pick" — the hasLiveData truth-cap
//     holds even when the degraded row IS the selected symbol AND was forced into
//     a best slot,
//   • the inspector's only actionable affordance must STEER AWAY — a "Switch to"
//     the LIVE alternative (onPick(liveSymbol)), never an action on the degraded
//     selected symbol itself,
//   • and when there is NO cleaner alternative, the inspector stays context-only:
//     no action affordance at all, no live-ready claim.
//
// Why test-only: the page's post-selection inspector cards (ScannerReadGate /
// RubyMarketReadCard / TimingIntelligenceCard) re-derive the ONE shared
// scanner-truth per symbol+tf — they do NOT inherit the scanner row's READY_NOW
// category — and are locked in their own suites; SelectedMarketPanel's manual
// BUY/SELL ticket is a separately-gated path (it already shows a feed warning and
// withholds levels). This block locks the map's OWN selected-context inspector.
//
// Scope note: forbidden-token checks are CASE-SENSITIVE and scoped to the
// degraded selected ROW / the inspector block — never document-wide. The live
// alternative row and the best-picks strip legitimately carry a direction badge
// and "Ready now"; honest degraded copy uses lowercase "live feed"/"live read",
// so a document-wide or case-insensitive check would false-fail on the very copy
// that tells the truth. The forbidden tokens are the affirmative Title-case forms.
//
// TEST-ONLY: asserts existing component behaviour; no component, contract,
// resolver, or backend change.
const SELECTED_DEGRADED_FORBIDDEN = [
  "Ready now",
  "Trade now",
  "Live-confirmed",
  "Execution-ready",
  "Ready to trade",
  "Buy",
  "Sell",
  "One-click",
  "Open ticket",
];

describe("BroadScanOpportunityMap — a SELECTED degraded opportunity stays context-only", () => {
  const liveAlt = () =>
    row({
      symbol: "EURUSD",
      displayName: "EURUSD",
      hasLiveData: true,
      category: "READY_NOW",
      kind: "MOMENTUM",
      edgeScore: 82,
      stageLabel: "Ready now",
    });

  const degradedSelected = () =>
    row({
      symbol: "GBPUSD",
      displayName: "GBPUSD",
      hasLiveData: false,
      direction: "BUY",
      recommendedAction: "BUY",
      edgeScore: 80,
      entryQuality: 75,
      executionQuality: 90,
      category: "FORMING_SOON",
      kind: "REVERSAL",
      stageLabel: "Forming soon",
      reason: "Historical-only read: clean pullback into the zone",
      bestAction: "Awaiting a live feed before this market can be read.",
    });

  it("never presents the degraded selected symbol as live-ready; the inspector steers to the live alternative and the truth-cap holds in best picks", () => {
    const onPick = vi.fn();
    const live = liveAlt();
    const degraded = degradedSelected();
    const base = mapResult([live, degraded]);
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          // Force the degraded SELECTED symbol into a "best" slot to prove the
          // hasLiveData truth-cap filters it out even when it is the selection.
          map: { ...base, best: { ...base.best, bestReversal: degraded } },
          bestVsSelected: {
            hasCleanerAlternative: true,
            selectedSymbol: "GBPUSD",
            selectedEdge: 80,
            best: live,
            message:
              "GBPUSD isn't on a live-confirmed feed right now — EURUSD has the cleaner live read.",
          },
        }),
      }),
    );
    render(
      <BroadScanOpportunityMap marketGroup="all" selectedSymbol="GBPUSD" onPick={onPick} />,
    );

    // The selected degraded row stays individually capped.
    const degradedEl = screen.getByTestId("opportunity-row-GBPUSD");
    expect(degradedEl.getAttribute("data-actionability")).toBe("FEED_LIMITED");
    expect(screen.getByTestId("opportunity-row-verdict-GBPUSD").textContent).toContain(
      "Feed limited",
    );
    expect(screen.queryByTestId("opportunity-row-direction-GBPUSD")).toBeNull();
    expect(screen.queryByTestId("opportunity-row-stats-GBPUSD")).toBeNull();
    const degradedText = degradedEl.textContent ?? "";
    for (const claim of SELECTED_DEGRADED_FORBIDDEN) {
      expect(degradedText).not.toContain(claim);
    }

    // The degraded selected symbol must NOT surface as a clean best pick, even
    // though it was forced into the bestReversal slot above. The best-picks strip
    // IS rendered (the live alternative qualifies), so the container must exist —
    // asserting its presence first stops this lock from silently no-op'ing if
    // best-picks rendering ever disappears.
    const bestPicks = screen.getByTestId("opportunity-map-best-picks");
    const bestPicksText = bestPicks.textContent ?? "";
    expect(bestPicksText).toContain("EURUSD"); // the live alternative is shown…
    expect(bestPicksText).not.toContain("GBPUSD"); // …the degraded selection is not.

    // The selected-context inspector renders, carries no live-ready/execution
    // claim, and its ONLY actionable affordance steers to the LIVE alternative.
    const inspector = screen.getByTestId("opportunity-map-best-vs-selected");
    const inspectorText = inspector.textContent ?? "";
    for (const claim of SELECTED_DEGRADED_FORBIDDEN) {
      expect(inspectorText).not.toContain(claim);
    }
    const switchBtn = screen.getByTestId("opportunity-map-switch");
    expect(switchBtn.textContent ?? "").toContain("EURUSD");
    fireEvent.click(switchBtn);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("EURUSD");
    expect(onPick).not.toHaveBeenCalledWith("GBPUSD");
  });

  it("when the degraded selected symbol has NO cleaner alternative, the inspector stays context-only — no action affordance, no live-ready claim", () => {
    const onPick = vi.fn();
    const degraded = degradedSelected();
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          map: mapResult([degraded]),
          bestVsSelected: {
            hasCleanerAlternative: false,
            selectedSymbol: "GBPUSD",
            selectedEdge: 80,
            best: null,
            message:
              "GBPUSD is the only read right now and its feed isn't live-confirmed — historical context only.",
          },
        }),
      }),
    );
    render(
      <BroadScanOpportunityMap marketGroup="all" selectedSymbol="GBPUSD" onPick={onPick} />,
    );

    // The inspector renders as honest context, with NO action affordance…
    const inspector = screen.getByTestId("opportunity-map-best-vs-selected");
    expect(screen.queryByTestId("opportunity-map-switch")).toBeNull();
    const inspectorText = inspector.textContent ?? "";
    for (const claim of SELECTED_DEGRADED_FORBIDDEN) {
      expect(inspectorText).not.toContain(claim);
    }

    // …and the selected degraded row itself stays capped.
    const degradedEl = screen.getByTestId("opportunity-row-GBPUSD");
    expect(degradedEl.getAttribute("data-actionability")).toBe("FEED_LIMITED");
    expect(screen.queryByTestId("opportunity-row-direction-GBPUSD")).toBeNull();
    expect(screen.queryByTestId("opportunity-row-stats-GBPUSD")).toBeNull();
    const degradedText = degradedEl.textContent ?? "";
    for (const claim of SELECTED_DEGRADED_FORBIDDEN) {
      expect(degradedText).not.toContain(claim);
    }

    // No execution path was wired anywhere in the inspector.
    expect(onPick).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task #608 — cross-surface feed-verdict reconciliation.
//
// The real bug: the Broad Scan Opportunity Map ran at its OWN scan timeframe and
// computed a row's readiness purely from `row.hasLiveData` + category, so it could
// render the SELECTED symbol (e.g. V75) as "Ready now / live data confirmed /
// act-ready" while the SAME symbol's chart header & Ruby Chart Read — which derive
// the feed verdict from `useSymbolTruth` at the chart timeframe — said "historical
// only / feed limited / analysis only". Two surfaces, one symbol, contradictory
// readiness.
//
// The fix makes the map self-consume the SAME selected-symbol feed verdict the
// chart header uses (`resolveSelectedSymbolActionability(lifted, dataOnly)` over
// `useSymbolTruth`). When that verdict is feed-degraded, the selected row is pulled
// DOWN to match — never up (DOWNGRADE-ONLY, DISPLAY-ONLY). Symbol matching is alias
// canonical, so `selectedSymbol="V75"` reconciles a row keyed "Volatility 75 Index".
// And when the scan timeframe differs from the chart timeframe, the row says so.
//
// TEST-ONLY: asserts the reconciliation wiring; no contract / resolver / backend
// change. Forbidden-token checks are CASE-SENSITIVE and scoped to the reconciled
// row, matching the conventions of the SELECTED-degraded suite above.
describe("BroadScanOpportunityMap — Task #608: a degraded selected chart caps the same symbol's broad-scan row", () => {
  // A V75 row the broad scan considers fully act-ready on its OWN timeframe.
  const actReadyV75 = () =>
    row({
      symbol: "Volatility 75 Index", // alias of canonical "V75" → proves alias match
      displayName: "Volatility 75 Index",
      hasLiveData: true,
      direction: "BUY",
      recommendedAction: "BUY",
      edgeScore: 88,
      entryQuality: 84,
      executionQuality: 91,
      category: "READY_NOW",
      kind: "SCALP",
      stageLabel: "Ready now",
      reason: "Clean momentum continuation off the demand zone",
    });

  // A genuinely live alternative that is NOT the selection — the control proving
  // the cap is scoped to the selected symbol, not applied map-wide.
  const liveControl = () =>
    row({
      symbol: "EURUSD",
      displayName: "EURUSD",
      hasLiveData: true,
      direction: "BUY",
      category: "READY_NOW",
      kind: "MOMENTUM",
      edgeScore: 80,
      stageLabel: "Ready now",
    });

  it("downgrades the V75 row (alias-matched) to the chart's ANALYSIS_ONLY verdict, surfaces the timeframe gap, and leaves other live rows untouched", () => {
    // Chart is on 15m; selected V75 chart feed verdict is ANALYSIS_ONLY.
    mockUseScannerTimeframe.mockReturnValue(["15m", () => {}]);
    mockUseSymbolTruth.mockReturnValue(truthWithVerdict("ANALYSIS_ONLY"));

    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          timeframe: "M5", // broad scan ran on M5, NOT the chart's 15m
          map: mapResult([actReadyV75(), liveControl()]),
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" selectedSymbol="V75" onPick={vi.fn()} />);

    // The hook was consulted at the BARE selected symbol + the chart timeframe —
    // i.e. the same coordinates the chart header reads.
    expect(mockUseSymbolTruth).toHaveBeenCalledWith("V75", "15m", expect.anything());

    // The selected V75 row (keyed by its alias) is pulled DOWN to the chart's
    // feed-degraded verdict despite the broad scan considering it act-ready.
    const v75 = screen.getByTestId("opportunity-row-Volatility 75 Index");
    expect(v75.getAttribute("data-actionability")).toBe("ANALYSIS_ONLY");
    expect(
      screen.getByTestId("opportunity-row-verdict-Volatility 75 Index").textContent,
    ).toContain("Analysis only");

    // No direction badge, no Edge/Entry/Exec stats — it can't read as act-ready.
    expect(screen.queryByTestId("opportunity-row-direction-Volatility 75 Index")).toBeNull();
    expect(screen.queryByTestId("opportunity-row-stats-Volatility 75 Index")).toBeNull();

    // The awaiting badge tells the honest cross-surface truth (feed not live-confirmed),
    // not "No live data" (the row DOES carry scan data).
    expect(
      screen.getByTestId("opportunity-row-awaiting-Volatility 75 Index").textContent,
    ).toContain("Feed not live-confirmed");

    // The timeframe gap is surfaced: scanned on M5, chart on M15.
    const tfNote = screen.getByTestId("opportunity-row-tf-note-Volatility 75 Index");
    expect(tfNote.textContent).toContain("M5");
    expect(tfNote.textContent).toContain("M15");

    // No live-ready / direction claim anywhere on the reconciled row.
    const v75Text = v75.textContent ?? "";
    for (const claim of SELECTED_DEGRADED_FORBIDDEN) {
      expect(v75Text).not.toContain(claim);
    }

    // CONTROL: the non-selected live EURUSD row is NOT downgraded — the cap is
    // scoped to the selected symbol only.
    const eur = screen.getByTestId("opportunity-row-EURUSD");
    expect(eur.getAttribute("data-actionability")).toBe("READY_NOW");
    expect(screen.getByTestId("opportunity-row-direction-EURUSD")).toBeTruthy();
    // …and EURUSD carries no spurious timeframe note (only the selected row does).
    expect(screen.queryByTestId("opportunity-row-tf-note-EURUSD")).toBeNull();
  });

  it("never UPGRADES: a live-confirmed selected chart leaves an already-act-ready row act-ready", () => {
    mockUseScannerTimeframe.mockReturnValue(["15m", () => {}]);
    // Chart feed verdict is fully READY_NOW (live-confirmed) — not a degraded cap.
    mockUseSymbolTruth.mockReturnValue(truthWithVerdict("READY_NOW"));

    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: resp({
          timeframe: "M5",
          map: mapResult([actReadyV75()]),
        }),
      }),
    );
    render(<BroadScanOpportunityMap marketGroup="all" selectedSymbol="V75" onPick={vi.fn()} />);

    // The row keeps its own act-ready verdict (no degraded cap to apply).
    const v75 = screen.getByTestId("opportunity-row-Volatility 75 Index");
    expect(v75.getAttribute("data-actionability")).toBe("READY_NOW");
    expect(screen.getByTestId("opportunity-row-direction-Volatility 75 Index")).toBeTruthy();
  });
});

// ── Task #609 — survives a truthy-but-partial (half-loaded) payload ──────────
//
// Sibling hardening to SelectedMarketPanel (Task #608): a response whose `map`
// is present (truthy) but only partly populated — missing its `rows`,
// `categories`, or `best` block (a half-streamed or older cached payload), or
// carrying a non-array `skippedSymbols` — must NOT throw the panel into the
// route error boundary. The panel treats an incomplete map as "no usable map"
// and falls through to the honest empty state. Pure render proofs (the data hook
// is mocked); no displayed value changes for a well-formed map (covered above).
describe("Task #609 — BroadScanOpportunityMap survives a half-loaded payload", () => {
  it("falls back to the empty state for a map missing rows/categories/best, without crashing", () => {
    const partialMap = { scannedCount: 3, liveCount: 2 } as unknown as OpportunityMapResult;
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({ data: resp({ map: partialMap }) }),
    );
    expect(() => render(<BroadScanOpportunityMap marketGroup="all" />)).not.toThrow();
    // No usable map ⇒ honest empty state, no crash, no best-picks block.
    expect(screen.getByTestId("opportunity-map")).toBeTruthy();
    expect(screen.getByTestId("opportunity-map-empty")).toBeTruthy();
    expect(screen.queryByTestId("opportunity-map-best-picks")).toBeNull();
  });

  it("does not crash when `map.best` is absent but rows/categories are present", () => {
    const noBest = { ...mapResult([row({})]) } as Record<string, unknown>;
    delete noBest.best;
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({ data: resp({ map: noBest as unknown as OpportunityMapResult }) }),
    );
    expect(() => render(<BroadScanOpportunityMap marketGroup="all" />)).not.toThrow();
    // An incomplete map (no `best`) degrades to the empty state rather than
    // throwing inside BestPicks.
    expect(screen.getByTestId("opportunity-map-empty")).toBeTruthy();
  });

  it("tolerates a non-array skippedSymbols field", () => {
    mockUseGetMeOpportunityMap.mockReturnValue(
      hookState({
        data: { ...resp(), skippedSymbols: "oops" } as unknown as MeOpportunityMapResp,
      }),
    );
    expect(() => render(<BroadScanOpportunityMap marketGroup="all" />)).not.toThrow();
    expect(screen.getByTestId("opportunity-map")).toBeTruthy();
  });

  it("renders the loading and error states without crashing", () => {
    mockUseGetMeOpportunityMap.mockReturnValue(hookState({ isLoading: true }));
    const { rerender } = render(<BroadScanOpportunityMap marketGroup="all" />);
    expect(screen.getByTestId("opportunity-map")).toBeTruthy();

    mockUseGetMeOpportunityMap.mockReturnValue(hookState({ isError: true }));
    rerender(<BroadScanOpportunityMap marketGroup="all" />);
    expect(screen.getByTestId("opportunity-map-err")).toBeTruthy();
  });
});
