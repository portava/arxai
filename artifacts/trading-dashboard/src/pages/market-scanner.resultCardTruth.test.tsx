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
vi.mock("@/components/scanner/RubySetupReason", () => ({ RubySetupReason: () => null }));
vi.mock("@/components/scanner/ScannerTimingBadges", () => ({ ScannerTimingBadges: () => null }));
vi.mock("@/components/scanner/ScannerTradeModal", () => ({ ScannerTradeModal: () => null }));
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
  fetchMock.mockReset(); safeJsonMock.mockClear(); pickCallbacks.length = 0; mapGroups.length = 0;
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

  it("a row the final read allows keeps its grade and status badge", async () => {
    rowOverrides = { finalRead: { label: "TRADE_WATCH" } };
    globalFeed = envelope("all", ["EURUSD"]);
    render(<MarketScanner />); await settle();
    expect(screen.getByTestId("scanner-action-EURUSD").textContent).toBe("BUY");
    expect(screen.getByText("Hot setup")).toBeTruthy();
    expect(screen.getByText("ELITE 87")).toBeTruthy();
  });
});
