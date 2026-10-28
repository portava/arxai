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
import { act } from "@testing-library/react";
import { GlobalMarketHeatCard, freshness, priceStampLabel } from "./GlobalMarketHeatCard";

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

// Owner screenshot 2026-10-27 (/market-scanner heat list): "Global Calm" in
// green from headlines alone, and synthetic rows reading "Price 4m ago · News
// 2m ago · Calendar never" for markets that do not use news at all.
describe("GlobalMarketHeatCard — what each row was actually built from", () => {
  function src(kind: MarketHeatSource["kind"], over: Partial<MarketHeatSource>): MarketHeatSource {
    return { kind, name: kind === "calendar" ? "none" : "Test", status: "live", configured: true, connected: true, updatedAt: null, recordCount: 0, note: null, ...over } as MarketHeatSource;
  }
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  function ownerData(): MarketHeatResponse {
    const data = buildData();
    const calendarMissing = src("calendar", { status: "missing", configured: false, connected: false });
    data.global = verdict({
      id: "global", scope: "global", key: "global", displayName: "Global Markets",
      intensity: "calm", direction: "neutral", sourceStatus: "partial", confidence: "low",
      priceSource: src("price", { status: "unavailable", connected: false }),
      newsSource: src("news", { updatedAt: minsAgo(2) }),
      calendarSource: calendarMissing,
      newsUpdatedAt: minsAgo(2), calendarUpdatedAt: null, priceUpdatedAt: null,
      reason: "Partial heat — from headlines only (no price feed). Calendar unavailable.",
    });
    data.synthetics = [verdict({
      id: "synthetic:V75", scope: "synthetic", key: "V75", displayName: "Volatility 75 Index",
      intensity: "moderate", sourceStatus: "price_only", confidence: "medium",
      priceSource: src("price", { updatedAt: minsAgo(4) }),
      newsSource: src("news", { connected: false, status: "unavailable" }),
      calendarSource: calendarMissing,
      priceUpdatedAt: minsAgo(4), newsUpdatedAt: null, calendarUpdatedAt: null,
      reason: "Synthetic market — not driven by scheduled economic events; the economic calendar is not consulted for this market. Heat here is from price action only; headlines are not used.",
    })];
    return data;
  }
  beforeEach(() => {
    mockUseGetMarketHeat.mockReturnValue({ data: ownerData(), isLoading: false, isFetching: false, isError: false, refetch: vi.fn() });
  });

  it("the collapsed Global row names its sources and the calendar gap, never a plain green calm", () => {
    render(<GlobalMarketHeatCard />);
    const row = screen.getByText("Global Markets").closest("button")!;
    expect(row.textContent).toContain("Calm");
    const status = row.querySelector('[data-testid="heat-verdict-source-status"]')!;
    expect(status.textContent).toBe("Headlines only · price not available · calendar not configured");
    expect(row.textContent).not.toContain("Price only");
    expect(row.innerHTML).not.toContain("text-success");
  });

  it("a synthetic row claims no news/calendar check time", () => {
    render(<GlobalMarketHeatCard />);
    fireEvent.click(screen.getByText("Volatility 75 Index").closest("button")!);
    const checked = screen.getByTestId("heat-verdict-checked").textContent ?? "";
    // Missing price time basis reads as a bar-open stamp (downgrade-only).
    expect(checked).toContain("M15 bar opened 4m ago");
    expect(checked).toContain("news/calendar not used (synthetic market)");
    expect(checked).not.toMatch(/News \d|Calendar/);
  });

  it("the Global row's chips say the calendar is not configured — no chip or status ever says 'never'", () => {
    render(<GlobalMarketHeatCard />);
    fireEvent.click(screen.getByText("Global Markets").closest("button")!);
    const checked = screen.getByTestId("heat-verdict-checked").textContent ?? "";
    expect(checked).toContain("News 2m ago");
    expect(checked).toContain("Calendar not configured");
    expect(checked).toContain("Price not available");
    for (const el of [...screen.getAllByTestId("heat-verdict-checked"), ...screen.getAllByTestId("heat-verdict-source-status")]) {
      expect(el.textContent ?? "").not.toMatch(/\bnever\b/i);
    }
  });
});

// Heat price stamp (owner screenshot [G], 2026-10-27 16:04Z): the V75 row said
// "Price 4m ago" — the OPEN time of the forming M15 bar, not when the price
// was observed. The row now names its basis, and the label ticks.
describe("GlobalMarketHeatCard — price stamp names its basis and keeps time", () => {
  const NOW = Date.parse("2026-10-27T16:04:00Z");

  function renderSynthetic(partial: Partial<MarketHeatVerdict>) {
    const data = buildData();
    data.synthetics = [
      verdict({
        id: "synthetic:V75", scope: "synthetic", key: "V75", displayName: "Volatility 75 Index",
        intensity: "moderate", sourceStatus: "price_only", affectedSymbols: ["V75"],
        reason: "Synthetic market — driven by price action only (immune to real-world news/economic events).",
        newsUpdatedAt: null, calendarUpdatedAt: null,
        ...partial,
      }),
    ];
    mockUseGetMarketHeat.mockReturnValue({ data, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() });
    render(<GlobalMarketHeatCard />);
    fireEvent.click(screen.getByRole("button", { name: /Volatility 75 Index/ }));
    return screen.getByTestId("heat-price-stamp");
  }

  afterEach(() => vi.useRealTimers());

  it("a bar-open stamp (or a missing basis) reads 'M15 bar opened 4m ago', never 'Price 4m ago'", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const stamp = renderSynthetic({ priceUpdatedAt: "2026-10-27T16:00:00.000Z" });
    expect(stamp.textContent).toBe("M15 bar opened 4m ago");
    expect(stamp.textContent).not.toContain("Price 4m ago");
    cleanup();
    const explicit = renderSynthetic({ priceUpdatedAt: "2026-10-27T16:00:00.000Z", priceTimeBasis: "bar_open" });
    expect(explicit.textContent).toBe("M15 bar opened 4m ago");
  });

  it("a tick stamp reads 'Price Ns ago'", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const stamp = renderSynthetic({ priceUpdatedAt: "2026-10-27T16:03:57.000Z", priceTimeBasis: "tick" });
    expect(stamp.textContent).toBe("Price 3s ago");
  });

  it("the label advances with the wall clock without a refetch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const stamp = renderSynthetic({ priceUpdatedAt: "2026-10-27T16:00:00.000Z" });
    expect(stamp.textContent).toBe("M15 bar opened 4m ago");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId("heat-price-stamp").textContent).toBe("M15 bar opened 5m ago");
    expect(mockUseGetMarketHeat.mock.results.every((r) => (r.value as { refetch: ReturnType<typeof vi.fn> }).refetch.mock.calls.length === 0)).toBe(true);
  });

  it("ages floor (3m31s is 3m, not 4m) and tolerate small clock skew", () => {
    expect(freshness("2026-10-27T16:00:29.000Z", NOW)).toBe("3m ago");
    expect(freshness("2026-10-27T16:04:03.000Z", NOW)).toBe("0s ago");
    expect(freshness("2026-10-27T16:04:30.000Z", NOW)).toBe("—");
    expect(freshness(null, NOW)).toBe("never");
    expect(priceStampLabel({ priceUpdatedAt: null, priceTimeBasis: null }, "M15", NOW)).toBe("Price never");
  });
});

describe("provider row chips (price)", () => {
  function withPrice(price: Partial<MarketHeatSource>) {
    const data = buildData();
    data.providerStatus = {
      ...data.providerStatus,
      price: { kind: "price", name: "MT5 broker", status: "live", configured: true, connected: true, recordCount: 50, ...price } as MarketHeatSource,
    };
    mockUseGetMarketHeat.mockReturnValue({ data, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() });
  }

  it("a stale price source is named stale and never styled as a healthy connection", () => {
    withPrice({ status: "stale", connected: true });
    render(<GlobalMarketHeatCard />);
    const chip = screen.getByTestId("heat-provider-chip-price");
    expect(chip.textContent).toBe("MT5 broker: stale");
    expect(chip.className).not.toContain("text-success");
  });

  it("a stale source the server marked not connected still says stale, not 'not connected'", () => {
    withPrice({ status: "stale", connected: false });
    render(<GlobalMarketHeatCard />);
    expect(screen.getByTestId("heat-provider-chip-price").textContent).toBe("MT5 broker: stale");
  });

  it("a live connected price source keeps the success tone", () => {
    withPrice({ status: "live", connected: true });
    render(<GlobalMarketHeatCard />);
    expect(screen.getByTestId("heat-provider-chip-price").className).toContain("text-success");
  });
});
