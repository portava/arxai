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
const row = (symbol: string) => ({ symbol, timeframe: "M5", dataStatus: "no_data", tradeable: false });
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
vi.mock("@/components/ui/badge", () => ({ Badge: ({ children }: Kids) => <span>{children}</span> }));
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
function visible(symbol: string) { return screen.queryByTestId(`scanner-result-unavailable-${symbol}`) !== null; }
function refreshPoll() {
  document.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T16:00:00Z"));
  globalFeed = envelope("all", ["EURUSD", "BTCUSD", "XAUUSD"]);
  pendingRead = null;
  mockRealIsAdmin = false;
  fetchMock.mockReset(); safeJsonMock.mockClear(); pickCallbacks.length = 0; mapGroups.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("scanner direct scan response and request ownership", () => {
  it("renders the POST envelope with no status/opportunities roundtrip", async () => {
    render(<MarketScanner />); await settle();
    const initialReads = safeJsonMock.mock.calls.length;
    fetchMock.mockResolvedValue(response(envelope("all", ["BTCUSD"])));
    fireEvent.click(screen.getByTestId("scanner-btn-scan")); await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(safeJsonMock).toHaveBeenCalledTimes(initialReads);
    expect(visible("BTCUSD")).toBe(true);
    expect(visible("EURUSD")).toBe(false);
  });
  it("aborts an old poll and cannot let its late response replace the manual result", async () => {
    const old = deferred<unknown>(); pendingRead = old;
    render(<MarketScanner />); await settle();
    const pollSignal = safeJsonMock.mock.calls.find(([url]) => url.includes("/opportunities"))![1]!.signal!;
    fetchMock.mockResolvedValue(response(envelope("all", ["BTCUSD"])));
    fireEvent.click(screen.getByTestId("scanner-btn-scan")); await settle();
    expect(pollSignal.aborted).toBe(true);
    await act(async () => { old.resolve({ ok: true, data: envelope("all", ["EURUSD"]) }); });
    expect(visible("BTCUSD")).toBe(true);
    expect(visible("EURUSD")).toBe(false);
  });
  it("keeps exact manual results when later global reads contain a different or older run", async () => {
    render(<MarketScanner />); await settle();
    fetchMock.mockResolvedValue(response(envelope("all", ["BTCUSD"])));
    fireEvent.click(screen.getByTestId("scanner-btn-scan")); await settle();
    globalFeed = envelope("metals", ["XAUUSD"], Date.now() + 1000);
    refreshPoll(); await settle();
    expect(visible("BTCUSD")).toBe(true); expect(visible("XAUUSD")).toBe(false);
    globalFeed = envelope("all", ["EURUSD"], Date.now() - 1000);
    refreshPoll(); await settle();
    expect(visible("BTCUSD")).toBe(true); expect(visible("EURUSD")).toBe(false);
  });
  it("latest operator selection wins and old completion cannot unlock the new scan", async () => {
    mockRealIsAdmin = true;
    const a = deferred<Response>(), b = deferred<Response>();
    fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    render(<MarketScanner />); await settle();
    fireEvent.click(screen.getByTestId("universe-crypto"));
    fireEvent.click(screen.getByTestId("universe-metals"));
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    await act(async () => { a.resolve(response(envelope("crypto", ["BTCUSD"]))); });
    expect((screen.getByTestId("scanner-btn-scan") as HTMLButtonElement).disabled).toBe(true);
    expect(visible("BTCUSD")).toBe(false);
    await act(async () => { b.resolve(response(envelope("metals", ["XAUUSD"]))); });
    expect(visible("XAUUSD")).toBe(true);
    expect(screen.queryByTestId("scanner-existing-scope")).toBeNull();
  });
  it("ignores old errors and pauses polling during a slow selected scan", async () => {
    mockRealIsAdmin = true;
    const a = deferred<Response>(), b = deferred<Response>();
    fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    render(<MarketScanner />); await settle();
    const reads = safeJsonMock.mock.calls.length;
    fireEvent.click(screen.getByTestId("universe-crypto"));
    fireEvent.click(screen.getByTestId("universe-metals"));
    await act(async () => { a.reject(new Error("obsolete failure")); });
    await settle(6000);
    expect(safeJsonMock).toHaveBeenCalledTimes(reads);
    expect(screen.queryByText("obsolete failure")).toBeNull();
    await act(async () => { b.resolve(response(envelope("metals", ["XAUUSD"]))); });
    expect(visible("XAUUSD")).toBe(true);
  });
  it("nonoperator selection only scopes existing rows and does not claim a fresh scan", async () => {
    render(<MarketScanner />); await settle();
    const reads = safeJsonMock.mock.calls.length;
    const callback = pickCallbacks.at(-1);
    fireEvent.click(screen.getByTestId("universe-crypto")); await settle();
    expect(fetchMock).not.toHaveBeenCalled(); expect(safeJsonMock).toHaveBeenCalledTimes(reads);
    expect(visible("BTCUSD")).toBe(true); expect(visible("EURUSD")).toBe(false);
    expect(screen.getByTestId("scanner-existing-scope").textContent).toContain("existing results filtered to Crypto");
    await settle(1000);
    expect(pickCallbacks.at(-1)).toBe(callback);
  });
  it("shows a current scan failure and refuses malformed success as a completed scan", async () => {
    globalFeed = envelope("all", []);
    render(<MarketScanner />); await settle();
    fetchMock.mockRejectedValueOnce(new Error("current scan failed"));
    fireEvent.click(screen.getByTestId("scanner-btn-scan")); await settle();
    expect(screen.getByText("current scan failed")).toBeTruthy();
    fetchMock.mockResolvedValueOnce(response({ ok: true }));
    fireEvent.click(screen.getByTestId("scanner-btn-scan")); await settle();
    expect(screen.queryByTestId("scanner-scanned-empty")).toBeNull();
    expect(screen.queryByTestId("scanner-empty-degraded")).not.toBeNull();
  });
  it("changing to an unavailable scope cannot publish a prior manual scan", async () => {
    const pending = deferred<Response>(); fetchMock.mockReturnValue(pending.promise);
    render(<MarketScanner />); await settle();
    fireEvent.click(screen.getByTestId("scanner-btn-scan"));
    fireEvent.click(screen.getByTestId("universe-crypto"));
    await act(async () => { pending.resolve(response(envelope("all", ["EURUSD"]))); });
    expect(visible("EURUSD")).toBe(false);
    expect(visible("BTCUSD")).toBe(true);
    expect(screen.queryByTestId("scanner-existing-scope")).not.toBeNull();
  });
  it("passes Indices as the HTTP-supported indices group, never stocks", async () => {
    render(<MarketScanner />); await settle();
    fireEvent.click(screen.getByTestId("universe-indices")); await settle();
    expect(mapGroups.at(-1)).toBe("indices");
    expect(mapGroups).not.toContain("stocks");
  });
  it("unmount aborts pending actions and ignores late success", async () => {
    const pending = deferred<Response>(); fetchMock.mockReturnValue(pending.promise);
    const { unmount } = render(<MarketScanner />); await settle();
    fireEvent.click(screen.getByTestId("scanner-btn-scan"));
    unmount();
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    await act(async () => { pending.resolve(response(envelope())); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
