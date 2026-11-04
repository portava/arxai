// Truth regressions on the legacy scanner result card (Results tab of the
// market scanner page). The real page renders; only data hooks, heavy child
// surfaces and UI primitives are stubbed.
//  - A live row the server's fused final read calls NO_TRADE kept the green
//    border, the "ELITE 87" grade and the "Hot setup" badge beside a
//    "No trade" chip.
//  - The Live Intent button always alerted "(PENDING_MT5_CONNECTION)",
//    ignoring the server's verdict, and a failed request alerted nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

const mapGroups: string[] = [];
const pickCallbacks: Array<(symbol: string) => void> = [];
const fetchMock = vi.fn<typeof fetch>();
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const universes = [
  { id: "all", label: "Core Markets", symbols: ["EURUSD", "BTCUSD", "XAUUSD"], available: true },
  { id: "crypto", label: "Crypto", symbols: ["BTCUSD"], available: true },
  { id: "metals", label: "Metals", symbols: ["XAUUSD"], available: true },
  { id: "indices", label: "Indices", symbols: ["US30"], available: true },
];
// A live, fresh, tradeable row whose fused final read is overridden per test.
let rowOverrides: Record<string, unknown> = {};
const row = (symbol: string) => ({
  symbol, timeframe: "M15", dataStatus: "live", tradeable: true, generatedAt: new Date(Date.now()).toISOString(),
  bias: "bullish", recommendedAction: "BUY", setupType: "Breakout", confidenceScore: 82, riskScore: 30,
  entrySniperScore: 70, riskRewardRatio: 2, reasonForTrade: "Clean breakout", reasonToAvoid: "",
  rulesPassed: [], rulesFailed: [], statusBadge: "HOT_SETUP", opportunity: { score: 87, label: "ELITE" },
  entry: 1.1, stopLoss: 1.09, takeProfit: 1.12, finalRead: { label: "NO_TRADE" },
  ...rowOverrides,
});
function envelope(universe = "all", symbols = ["EURUSD"], time = Date.now()) {
  return { universe, universeSymbols: symbols, opportunities: symbols.map(row), generatedAt: new Date(time).toISOString() };
}
function response(body: unknown): Response { return { ok: true, json: async () => body } as Response; }
let globalFeed = envelope();
let pendingRead: ReturnType<typeof deferred<unknown>> | null = null;
const safeJsonMock = vi.fn(async (url: string, _init?: RequestInit): Promise<any> => {
  if (url.includes("/universes")) return { ok: true, data: { universes } };
  if (url.includes("/status")) return { ok: true, data: { running: false, opportunityCount: 0, lastScanAt: null } };
  if (pendingRead) { const read = pendingRead; pendingRead = null; return read.promise; }
  return { ok: true, data: globalFeed };
});
vi.mock("@/lib/api/safeJson", () => ({ safeJson: (...args: [string, RequestInit?]) => safeJsonMock(...args) }));
// ---- Stub the data hooks / libs the page pulls in --------------------------
vi.mock("@/lib/perf", () => ({
  markActionStart: () => "act",
  markUiFeedback: () => {},
  markActionEnd: () => {},
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetAaciCohesion: () => ({ data: undefined }),
  getGetAaciCohesionQueryKey: () => ["aaci-cohesion"],
  useGetMarketHeat: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: () => {},
  }),
  getGetMarketHeatQueryKey: () => ["market-heat"],
}));
vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["EURUSD", () => {}],
  bareSymbol: (s: string) => s,
  setChartSymbol: () => {},
}));
vi.mock("@/lib/symbolRegistry", () => ({
  resolveSymbol: (s: string) => ({ canonicalSymbol: s }),
}));
// Admin flag is mutable so the admin universe-switch path (which fires the
// rate-limited scan POST) can be exercised separately from the default
// non-admin tests. Reset to false in beforeEach.
let mockRealIsAdmin = false;
vi.mock("@/hooks/useViewMode", () => ({ useViewMode: () => ({ realIsAdmin: mockRealIsAdmin }) }));
vi.mock("wouter", () => ({ Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a> }));

// Enumerated lucide icons used by the page.
vi.mock("lucide-react", () => {
  const Stub = () => null;
  return {
    Radar: Stub, Play: Stub, Square: Stub, RefreshCw: Stub, Send: Stub,
    TrendingUp: Stub, TrendingDown: Stub, Sliders: Stub, Target: Stub,
    Layers: Stub, Wand2: Stub,
    AlertTriangle: Stub, Info: Stub, CheckCircle2: Stub, AlertCircle: Stub, ChevronDown: Stub,
    Flame: Stub, Loader2: Stub, Globe: Stub, Activity: Stub, Newspaper: Stub,
    CalendarClock: Stub, Map: Stub, LayoutGrid: Stub,
  };
});

// ---- Layout / container stubs that must render their children --------------
type Kids = { children?: React.ReactNode };
vi.mock("@/components/layout/SectionErrorBoundary", () => ({
  SectionErrorBoundary: ({ children }: Kids) => <>{children}</>,
}));
vi.mock("@/components/ui/CollapsibleSection", () => ({
  CollapsibleSection: ({ children }: Kids) => <>{children}</>,
}));
type Tab = { id: string; content: React.ReactNode };
vi.mock("@/components/ui/PageTabs", () => ({
  // Render EVERY tab's content so the Scan button (Broad Scan card, Advanced
  // tab) is always mounted regardless of the default tab.
  PageTabs: ({ tabs }: { tabs: Tab[] }) => (
    <div data-testid="page-tabs">{tabs.map((t) => <div key={t.id}>{t.content}</div>)}</div>
  ),
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...rest }: Kids & { "data-testid"?: string }) => <div data-testid={rest["data-testid"]}>{children}</div>,
  CardContent: ({ children }: Kids) => <div>{children}</div>,
  CardHeader: ({ children }: Kids) => <div>{children}</div>,
  CardTitle: ({ children }: Kids) => <div>{children}</div>,
  CardDescription: ({ children }: Kids) => <div>{children}</div>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, ...rest }: Kids & {
    onClick?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} data-testid={rest["data-testid"]}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/badge", () => ({ Badge: ({ children, ...rest }: Kids & { "data-testid"?: string }) => <span data-testid={rest["data-testid"]}>{children}</span> }));
vi.mock("@/components/ui/CompactAlert", () => ({
  // The scanner surfaces `err` via the `description` prop, so render it.
  CompactAlert: ({ children, description }: Kids & { description?: React.ReactNode }) => (
    <div>{description}{children}</div>
  ),
}));
vi.mock("@/components/ui/select", () => ({
  // Expose onValueChange via a button so a test can drive `changeUniverse`
  // (the universe switcher) without the real radix Select.
  Select: ({ children, onValueChange }: Kids & { onValueChange?: (v: string) => void }) => (
    <div>
      {["all", "crypto", "metals", "indices"].map((value) => <button key={value} data-testid={`universe-${value}`} onClick={() => onValueChange?.(value)}>{value}</button>)}
      {children}
    </div>
  ),
  SelectContent: ({ children }: Kids) => <div>{children}</div>,
  SelectItem: ({ children }: Kids) => <div>{children}</div>,
  SelectTrigger: ({ children }: Kids) => <div>{children}</div>,
  SelectValue: () => null,
}));

// ---- Heavy scanner / live child surfaces → inert stubs ---------------------
vi.mock("@/components/trading/SetupQualityBadge", () => ({ SetupQualityBadge: () => null }));
// Records the signal each card hands Ruby's Setup Reason, so a test can see
// what the panel would be asked to explain.
const rubySignals: Array<Record<string, unknown>> = [];
vi.mock("@/components/scanner/RubySetupReason", () => ({
  RubySetupReason: ({ signal }: { signal: Record<string, unknown> }) => { rubySignals.push(signal); return null; },
}));
vi.mock("@/components/scanner/ScannerTimingBadges", () => ({ ScannerTimingBadges: () => null }));
// Records the props the Trade Setup / BUY / SELL buttons open the ticket with.
const modalProps: Array<Record<string, unknown>> = [];
vi.mock("@/components/scanner/ScannerTradeModal", () => ({
  ScannerTradeModal: (props: Record<string, unknown>) => { modalProps.push(props); return null; },
}));
vi.mock("@/components/scanner/RecentScannerTrades", () => ({ RecentScannerTrades: () => null }));
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({ MasterLiveAccessBanner: () => null }));
vi.mock("@/components/scanner/SelectedMarketPanel", () => ({ SelectedMarketPanel: () => null }));
vi.mock("@/components/scanner/ScannerDataHealthPanel", () => ({ ScannerDataHealthPanel: () => null }));
vi.mock("@/components/news/HighImpactEventBanner", () => ({ HighImpactEventBanner: () => null }));
vi.mock("@/components/scanner/SymbolExplorer", () => ({ SymbolExplorer: () => null }));
vi.mock("@/components/scanner/ScannerChartPanel", () => ({ ScannerChartPanel: () => null }));
vi.mock("@/components/live/TradeHealthPanel", () => ({ TradeHealthPanel: () => null }));
vi.mock("@/components/scanner/ScannerHeaderSummary", () => ({ ScannerHeaderSummary: () => null }));
vi.mock("@/components/scanner/RubyScalpFocusCard", () => ({ RubyScalpFocusCard: () => null }));
vi.mock("@/components/scanner/RubyScalpRanking", () => ({ RubyScalpRanking: () => null }));
vi.mock("@/components/scanner/RubyMarketReadCard", () => ({ RubyMarketReadCard: () => null }));
vi.mock("@/components/scanner/TimingIntelligenceCard", () => ({ TimingIntelligenceCard: () => null }));
vi.mock("@/components/scanner/ScannerReadGate", () => ({ ScannerReadGate: () => null }));
vi.mock("@/components/scanner/BroadScanOpportunityMap", () => ({ BroadScanOpportunityMap: ({ onPick, marketGroup }: { onPick: (symbol: string) => void; marketGroup: string }) => { pickCallbacks.push(onPick); mapGroups.push(marketGroup); return null; } }));
vi.mock("@/components/scanner/RubyScalpBuilder", () => ({ RubyScalpBuilder: () => null }));
vi.mock("@/components/scanner/RubyScalpBasketPanel", () => ({ RubyScalpBasketPanel: () => null }));
vi.mock("@/components/scanner/RubyScalpReviewPanel", () => ({ RubyScalpReviewPanel: () => null }));


import MarketScanner from "./market-scanner";

async function settle(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T16:00:00Z"));
  rowOverrides = {};
  globalFeed = envelope("all", ["EURUSD"]);
  pendingRead = null;
  mockRealIsAdmin = false;
  fetchMock.mockReset(); safeJsonMock.mockClear(); pickCallbacks.length = 0; mapGroups.length = 0; rubySignals.length = 0; modalProps.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("legacy scanner result card — final read NO_TRADE", () => {
  it("does not show 'Hot setup' or the ELITE grade beside 'No trade'", async () => {
    render(<MarketScanner />); await settle();
    expect(screen.getByTestId("scanner-action-EURUSD").textContent).toBe("No trade");
    expect(screen.queryByText("Hot setup")).toBeNull();
    expect(screen.queryByText(/ELITE/)).toBeNull();
    expect(screen.getByTestId("scanner-grade-withheld-EURUSD").textContent).toMatch(/87/);
  });

  it("does not ask Ruby to explain a buy setup under 'No trade'; shows the final read's reasons", async () => {
    rowOverrides = { finalRead: { label: "NO_TRADE", headline: "No trade", reasons: ["Major event nearby. Volatility may spike."] } };
    globalFeed = envelope("all", ["EURUSD"]);
    render(<MarketScanner />); await settle();
    expect(screen.getByTestId("scanner-action-EURUSD").textContent).toBe("No trade");
    // Ruby's Setup Reason would be sent recommendedAction BUY + HOT_SETUP and
    // answer "This looks like a possible buy setup." in a green box.
    expect(rubySignals.filter((s) => s.symbol === "EURUSD")).toEqual([]);
    const note = screen.getByTestId("scanner-final-read-note-EURUSD").textContent ?? "";
    expect(note).toMatch(/No trade/);
    expect(note).toMatch(/Major event nearby/);
    expect(note).not.toMatch(/buy setup/i);
  });

  it("a withheld row with no final-read reasons still says why the setup reason is not shown", async () => {
    rowOverrides = { finalRead: { label: "AVOID_FOR_NOW" } };
    globalFeed = envelope("all", ["EURUSD"]);
    render(<MarketScanner />); await settle();
    expect(rubySignals.filter((s) => s.symbol === "EURUSD")).toEqual([]);
    expect(screen.getByTestId("scanner-final-read-note-EURUSD").textContent).toMatch(/Avoid for now/);
  });

  it("a row the final read allows keeps its grade and status badge", async () => {
    rowOverrides = { finalRead: { label: "TRADE_WATCH" } };
    globalFeed = envelope("all", ["EURUSD"]);
    render(<MarketScanner />); await settle();
    expect(screen.getByTestId("scanner-action-EURUSD").textContent).toBe("BUY");
    expect(screen.getByText("Hot setup")).toBeTruthy();
    expect(screen.getByText("ELITE 87")).toBeTruthy();
    expect(screen.queryByTestId("scanner-final-read-note-EURUSD")).toBeNull();
    const sent = rubySignals.filter((s) => s.symbol === "EURUSD");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[sent.length - 1].recommendedAction).toBe("BUY");
    expect(sent[sent.length - 1].statusBadge).toBe("HOT_SETUP");
  });
});

// Review pass 2: the card now says "No trade", but its Trade Setup / BUY /
// SELL buttons still open the ticket, whose Summary asked Ruby to explain the
// raw BUY + HOT_SETUP signal ("This looks like a possible buy setup."). The
// ticket is told the final read withheld the setup reason, so it shows the
// same note as the card. The signal itself (what an order records) is unchanged.
describe("legacy scanner result card — the trade ticket under a withheld final read", () => {
  const lastModal = () => modalProps[modalProps.length - 1];

  for (const button of ["Trade Setup", "BUY", "SELL"] as const) {
    it(`${button} on a NO_TRADE row opens the ticket with the setup reason withheld`, async () => {
      rowOverrides = { finalRead: { label: "NO_TRADE", headline: "No trade", reasons: ["Major event nearby. Volatility may spike."] } };
      globalFeed = envelope("all", ["EURUSD"]);
      render(<MarketScanner />); await settle();
      const target = button === "Trade Setup" ? screen.getByText("Trade Setup") : screen.getByTestId(`scanner-${button.toLowerCase()}-EURUSD`);
      fireEvent.click(target); await settle();
      expect(modalProps.length).toBeGreaterThan(0);
      expect(lastModal().setupReasonWithheld).toEqual({ label: "No trade", reasons: ["Major event nearby. Volatility may spike."] });
      // The order-side signal is not rewritten: only the display is told.
      expect((lastModal().signal as Record<string, unknown>).recommendedAction).toBe("BUY");
    });
  }

  it("an AVOID_FOR_NOW row with no reasons still withholds the setup reason in the ticket", async () => {
    rowOverrides = { finalRead: { label: "AVOID_FOR_NOW" } };
    globalFeed = envelope("all", ["EURUSD"]);
    render(<MarketScanner />); await settle();
    fireEvent.click(screen.getByText("Trade Setup")); await settle();
    expect(lastModal().setupReasonWithheld).toEqual({ label: "Avoid for now", reasons: [] });
  });

  it("a row the final read allows opens the ticket without a withheld note", async () => {
    rowOverrides = { finalRead: { label: "TRADE_WATCH" } };
    globalFeed = envelope("all", ["EURUSD"]);
    render(<MarketScanner />); await settle();
    fireEvent.click(screen.getByText("Trade Setup")); await settle();
    expect(lastModal().setupReasonWithheld ?? null).toBeNull();
  });
});

describe("legacy scanner result card — Live Intent reports the server's verdict", () => {
  function submitWith(resp: { ok: boolean; status: number; body: unknown } | Error) {
    const alerts: string[] = [];
    vi.stubGlobal("alert", (m: string) => { alerts.push(String(m)); });
    fetchMock.mockImplementation(async (url) => {
      if (!String(url).includes("/api/live-intent/submit")) throw new Error(`unexpected ${String(url)}`);
      if (resp instanceof Error) throw resp;
      return { ok: resp.ok, status: resp.status, json: async () => resp.body } as Response;
    });
    return alerts;
  }

  it("a risk rejection is not reported as captured and pending", async () => {
    rowOverrides = { finalRead: { label: "TRADE_WATCH" } };
    globalFeed = envelope("all", ["EURUSD"]);
    const alerts = submitWith({ ok: true, status: 200, body: {
      status: "REJECTED_BY_RISK", riskCheckPassed: false, accepted: false,
      reason: "Risk check failed: stopLoss is required for live-intent capture",
    } });
    render(<MarketScanner />); await settle();
    fireEvent.click(screen.getByText("Live Intent")); await settle();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).not.toMatch(/PENDING_MT5_CONNECTION/);
    expect(alerts[0]).not.toMatch(/captured/i);
    expect(alerts[0]).toMatch(/rejected/i);
    expect(alerts[0]).toMatch(/stopLoss is required/);
  });

  it("names the status the server returned, not a hard-coded one", async () => {
    rowOverrides = { finalRead: { label: "TRADE_WATCH" } };
    globalFeed = envelope("all", ["EURUSD"]);
    const alerts = submitWith({ ok: true, status: 200, body: {
      status: "READY_FOR_BROKER_WHEN_CONNECTED", riskCheckPassed: true, accepted: false, mt5Connected: true,
      reason: "Risk checks passed. No broker order was placed.",
    } });
    render(<MarketScanner />); await settle();
    fireEvent.click(screen.getByText("Live Intent")); await settle();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).not.toMatch(/PENDING_MT5_CONNECTION/);
    expect(alerts[0]).toMatch(/READY_FOR_BROKER_WHEN_CONNECTED/);
    expect(alerts[0]).toMatch(/No broker order was placed/);
  });

  it("a failed request says the intent could not be submitted", async () => {
    rowOverrides = { finalRead: { label: "TRADE_WATCH" } };
    globalFeed = envelope("all", ["EURUSD"]);
    const alerts = submitWith({ ok: false, status: 500, body: { error: "Failed to capture live intent" } });
    render(<MarketScanner />); await settle();
    fireEvent.click(screen.getByText("Live Intent")); await settle();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/could not be submitted/i);
    expect(alerts[0]).toMatch(/Failed to capture live intent/);
    // The route writes its safety-log event before the intent row, so a 500
    // can follow a partial write: the client cannot say nothing was recorded.
    expect(alerts[0]).not.toMatch(/Nothing was recorded/i);
    expect(alerts[0]).toMatch(/whether the server recorded .* could not be confirmed/i);
  });

  it("a dropped connection does not claim nothing was recorded", async () => {
    rowOverrides = { finalRead: { label: "TRADE_WATCH" } };
    globalFeed = envelope("all", ["EURUSD"]);
    const alerts = submitWith(new TypeError("Failed to fetch"));
    render(<MarketScanner />); await settle();
    fireEvent.click(screen.getByText("Live Intent")); await settle();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/could not be submitted: Failed to fetch/);
    expect(alerts[0]).not.toMatch(/Nothing was recorded/i);
    expect(alerts[0]).toMatch(/could not be confirmed/i);
  });
});
