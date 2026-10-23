import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type {
  MarketHeatResponse,
  MarketHeatVerdict,
  MarketHeatSource,
  MarketHeatVerdictIntensity,
  MarketHeatNewsRisk,
  MarketHeatNewsRiskLevel,
  MarketHeatNewsHeadline,
} from "@workspace/api-client-react";
import { GlobalMarketHeatCard } from "./GlobalMarketHeatCard";

// Render proof for the Global Market Heat card's world-map view (Task #626).
// The card reads ONLY the read-only GET /api/market-heat hook, which we mock so
// the test is a pure render proof. It proves the honesty-critical map behavior:
//
//   1. The geographic world map is the default view and renders country nodes.
//   2. An `unavailable` region renders in the muted/gray tone — NEVER the green
//      (success / calm) tone — so a missing provider can't look safe/quiet.
//   3. Clicking a country surfaces its reasons + affected symbols, and clicking
//      a symbol drives the chart symbol bus (setChartSymbol).
//   4. A macro region with no map coordinate (e.g. "Global") is surfaced as a
//      chip — never silently dropped.
//   5. The Map/Grid toggle swaps the map for the currency tile grid.

const mockUseGetMarketHeat = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useGetMarketHeat: (...args: unknown[]) => mockUseGetMarketHeat(...args),
  getGetMarketHeatQueryKey: () => ["get-market-heat"],
}));

const mockSetChartSymbol = vi.fn();
vi.mock("@/lib/use-chart-symbol", () => ({
  setChartSymbol: (...args: unknown[]) => mockSetChartSymbol(...args),
}));

function source(connected: boolean): MarketHeatSource {
  return {
    kind: "news",
    name: "Test",
    status: connected ? "connected" : "not_connected",
    configured: connected,
    connected,
    recordCount: 0,
  } as MarketHeatSource;
}

function verdict(
  partial: Partial<MarketHeatVerdict> & {
    id: string;
    key: string;
    displayName: string;
    intensity: MarketHeatVerdictIntensity;
  },
): MarketHeatVerdict {
  return {
    scope: "country",
    heatScore: 50,
    direction: "bullish",
    sourceStatus: "confirmed",
    priceSource: source(true),
    newsSource: source(true),
    calendarSource: source(true),
    confidence: "high",
    reason: "Test reason.",
    affectedSymbols: [],
    warnings: [],
    advisoryOnly: true,
    ...partial,
  } as MarketHeatVerdict;
}

function buildData(): MarketHeatResponse {
  return {
    generatedAt: new Date().toISOString(),
    timeframe: "M15",
    global: verdict({
      id: "global",
      scope: "global",
      key: "global",
      displayName: "Global Markets",
      intensity: "moderate",
    }),
    countries: [
      verdict({
        id: "country:US",
        key: "US",
        displayName: "United States",
        intensity: "high",
        reason: "USD macro is hot.",
        affectedSymbols: ["EURUSD", "XAUUSD"],
      }),
      verdict({
        id: "country:Japan",
        key: "Japan",
        displayName: "Japan",
        intensity: "unavailable",
        direction: "unavailable",
        sourceStatus: "unavailable",
        reason: "News provider not connected.",
      }),
      // No REGION_COORDS entry for "Global" — exercises the unplaced-chip path.
      // Marked unavailable so it does NOT also appear in the "Top hot" strip,
      // keeping its text unique to the map's unplaced chip in this view.
      verdict({
        id: "country:Global",
        key: "Global",
        displayName: "Global",
        intensity: "unavailable",
        direction: "unavailable",
        sourceStatus: "unavailable",
      }),
    ],
    currencies: [
      verdict({
        id: "currency:USD",
        scope: "currency",
        key: "USD",
        displayName: "US Dollar",
        intensity: "high",
      }),
    ],
    synthetics: [],
    providerStatus: {
      price: source(true),
      news: source(false),
      calendar: source(false),
    },
    newsRisk: {
      level: "unavailable",
      connected: false,
      itemCount: 0,
      highImpactCount: 0,
      topHeadlines: [],
      provider: "",
      summary: "News provider not connected.",
    },
    upcomingEvents: [],
    warnings: [],
  };
}

beforeEach(() => {
  mockUseGetMarketHeat.mockReturnValue({
    data: buildData(),
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Each map country is an <svg><g><title>Name — Label</title>…</g>. Testing
// Library's getByTitle only matches `svg > title` (direct children), so we
// resolve the clickable <g> by its nested <title> text instead.
function findCountryNode(displayNamePrefix: string): SVGGElement {
  const groups = Array.from(document.querySelectorAll("svg g"));
  for (const g of groups) {
    const title = g.querySelector("title");
    if (title?.textContent?.startsWith(displayNamePrefix)) {
      return g as unknown as SVGGElement;
    }
  }
  throw new Error(`map node not found for "${displayNamePrefix}"`);
}

describe("GlobalMarketHeatCard world-map view", () => {
  it("renders the geographic map by default with country nodes", () => {
    render(<GlobalMarketHeatCard />);
    expect(screen.getByRole("img", { name: "World market-heat map" })).toBeTruthy();
    expect(findCountryNode("United States")).toBeTruthy();
    expect(findCountryNode("Japan")).toBeTruthy();
  });

  it("renders an unavailable region in gray, never green/calm", () => {
    render(<GlobalMarketHeatCard />);
    const node = findCountryNode("Japan");
    const cls = node.getAttribute("class") ?? "";
    expect(cls).toContain("text-txt-muted");
    expect(cls).not.toContain("text-success");
  });

  it("click-through shows reasons + affected symbols and drives the chart bus", () => {
    render(<GlobalMarketHeatCard />);
    const us = findCountryNode("United States");
    fireEvent.click(us);
    expect(screen.getByText("USD macro is hot.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "EURUSD" }));
    expect(mockSetChartSymbol).toHaveBeenCalledWith("EURUSD");
  });

  it("renders a STALE country in gray, never green, even with a calm intensity", () => {
    // A stale/delayed reading carries a REAL intensity from the backend
    // (computeHeatVerdict). "calm"/"low" map to the green success tone, so a
    // stale country could falsely look quiet/safe. Honesty: any degraded source
    // status forces the muted gray tone regardless of intensity.
    const data = buildData();
    data.countries = [
      verdict({
        id: "country:US",
        key: "US",
        displayName: "United States",
        intensity: "calm",
        sourceStatus: "stale",
        reason: "Data is stale — confidence capped to low.",
      }),
    ];
    mockUseGetMarketHeat.mockReturnValue({
      data,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<GlobalMarketHeatCard />);
    const us = findCountryNode("United States");
    const cls = us.getAttribute("class") ?? "";
    expect(cls).toContain("text-txt-muted");
    expect(cls).not.toContain("text-success");
  });

  it("surfaces a region without a map coordinate as a chip (never dropped)", () => {
    render(<GlobalMarketHeatCard />);
    // "Global" country has no REGION_COORDS entry — must still be visible as a
    // chip below the map (and is unavailable, so it is the only "Global" text).
    expect(screen.getByText("Global")).toBeTruthy();
  });

  it("the Map/Grid toggle swaps the map for the currency tile grid", () => {
    render(<GlobalMarketHeatCard />);
    expect(screen.getByRole("img", { name: "World market-heat map" })).toBeTruthy();
    // In map view only the "Top hot" strip carries the currency name.
    expect(screen.getAllByText("US Dollar")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Grid/ }));
    // Map gone; the grid now adds the currency tile (2nd "US Dollar").
    expect(screen.queryByRole("img", { name: "World market-heat map" })).toBeNull();
    expect(screen.getAllByText("US Dollar").length).toBeGreaterThan(1);
  });
});

// ── Driving-headlines list surfacing rule (Task #636) ────────────────────────
// NewsRiskSection surfaces the "Driving headlines" list ONLY when the news
// provider is connected AND the risk level is elevated/high AND there is at
// least one headline. These render proofs lock that rule against regressions:
// an elevated/high reading shows each headline with its severity badge, source
// and age (plus the high-impact count), while a low / unavailable / disconnected
// / empty reading keeps the list hidden — a quiet or missing feed can never
// fabricate "driving headlines".

const HEADLINE_TEXT = "Fed signals surprise rate hike";
const SECOND_HEADLINE_TEXT = "ECB warns on sticky inflation";

function headline(partial: Partial<MarketHeatNewsHeadline> = {}): MarketHeatNewsHeadline {
  return {
    headline: HEADLINE_TEXT,
    source: "Reuters",
    // A fixed recent publish time so freshness() renders a deterministic "…ago".
    publishedAt: new Date(Date.now() - 45_000).toISOString(),
    severity: "high",
    ...partial,
  };
}

function buildNewsRisk(partial: Partial<MarketHeatNewsRisk> = {}): MarketHeatNewsRisk {
  return {
    level: "elevated" as MarketHeatNewsRiskLevel,
    connected: true,
    itemCount: 5,
    highImpactCount: 2,
    topHeadlines: [
      headline(),
      headline({ headline: SECOND_HEADLINE_TEXT, severity: "medium", source: "Bloomberg" }),
    ],
    provider: "Test News",
    summary: "Elevated headline flow.",
    ...partial,
  };
}

function renderWithNewsRisk(risk: MarketHeatNewsRisk) {
  const data = buildData();
  data.newsRisk = risk;
  mockUseGetMarketHeat.mockReturnValue({
    data,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  });
  render(<GlobalMarketHeatCard />);
}

// The HeadlineRow renders the headline text inside nested <span>s; the nearest
// <div> ancestor is the row root, whose textContent holds severity + source +
// age. Resolve it from the headline text.
function headlineRowFor(text: string): HTMLElement {
  const el = screen.getByText(text);
  const row = el.closest("div");
  if (!row) throw new Error(`headline row not found for "${text}"`);
  return row as HTMLElement;
}

describe("GlobalMarketHeatCard driving headlines", () => {
  it("shows the driving-headlines list with severity, source and age when risk is elevated", () => {
    renderWithNewsRisk(buildNewsRisk({ level: "elevated" }));

    expect(screen.getByText("Driving headlines")).toBeTruthy();
    expect(screen.getByText(HEADLINE_TEXT)).toBeTruthy();
    expect(screen.getByText(SECOND_HEADLINE_TEXT)).toBeTruthy();

    // The high-impact badge surfaces alongside the list.
    expect(screen.getByText(/2 high-impact/)).toBeTruthy();

    // Each row carries its severity badge, source, and a freshness/age stamp.
    const row = headlineRowFor(HEADLINE_TEXT);
    expect(row.textContent).toContain("high"); // severity badge
    expect(row.textContent).toContain("Reuters"); // source
    expect(row.textContent).toMatch(/ago/); // age
  });

  it("shows the driving-headlines list when risk is high", () => {
    renderWithNewsRisk(buildNewsRisk({ level: "high" }));
    expect(screen.getByText("Driving headlines")).toBeTruthy();
    expect(screen.getByText(HEADLINE_TEXT)).toBeTruthy();
  });

  it("hides the driving-headlines list when risk is low (even with headlines present)", () => {
    renderWithNewsRisk(buildNewsRisk({ level: "low" }));
    expect(screen.queryByText("Driving headlines")).toBeNull();
    expect(screen.queryByText(HEADLINE_TEXT)).toBeNull();
  });

  it("hides the driving-headlines list when risk is unavailable", () => {
    renderWithNewsRisk(
      buildNewsRisk({ level: "unavailable", connected: false, provider: "" }),
    );
    expect(screen.queryByText("Driving headlines")).toBeNull();
    expect(screen.queryByText(HEADLINE_TEXT)).toBeNull();
  });

  it("hides the list when the provider is disconnected even at an elevated level", () => {
    // Honesty: a disconnected feed can never surface "driving headlines",
    // regardless of a stale/elevated level value.
    renderWithNewsRisk(buildNewsRisk({ level: "elevated", connected: false }));
    expect(screen.queryByText("Driving headlines")).toBeNull();
    expect(screen.queryByText(HEADLINE_TEXT)).toBeNull();
  });

  it("hides the list when connected and elevated but there are no headlines", () => {
    renderWithNewsRisk(buildNewsRisk({ level: "elevated", topHeadlines: [] }));
    expect(screen.queryByText("Driving headlines")).toBeNull();
  });
});
