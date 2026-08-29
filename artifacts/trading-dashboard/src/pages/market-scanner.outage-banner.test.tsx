// Behavioral render proof — the honest "Scanner error" degraded banner shows on
// the DEFAULT Focus tab during a scanner outage, and clears on recovery.
//
// The companion source-scan guard (market-scanner.scan-feedback.test.ts) locks
// the STRUCTURE: the banner renders exactly once, at page scope, above the tab
// bar — so it can never be tab-trapped. This test locks the BEHAVIOUR that the
// structure exists to deliver:
//
//   1. When the two scanner reads (status + opportunities) fail (the body-less
//      502 the dev outage injector produces — see api-server
//      lib/devScannerOutage.ts), `load()` sets the honest degraded copy and the
//      CompactAlert with data-testid="scanner-error" appears while the default
//      Focus tab is active.
//   2. When the reads recover, the same banner disappears on the next load.
//
// The page imports ~30 heavy child surfaces (incl. lightweight-charts, which
// can't render headlessly), so every child + data hook is stubbed; we keep the
// REAL CompactAlert + scannerResilience copy and drive the real `load()` purely
// through the mocked `safeJson`. PageTabs is stubbed to render the active
// (default = focus) tab so the assertion proves the banner shows WITH the Focus
// tab, not only on Broad Scan.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { SCANNER_DEGRADED_MESSAGE } from "@/lib/scannerResilience";

// ---- Controllable scanner feed (the "outage" switch) ----------------------
let outageArmed = true;
const safeJsonMock = vi.fn(async (url: string) => {
  // Universe definitions read — independent of the outage; keep it honest-empty.
  if (url.includes("/universes")) return { ok: true, data: { universes: [] } };
  // While the outage is armed BOTH scanner feeds answer like a body-less 502.
  if (outageArmed) return { ok: false, kind: "http", status: 502, message: "Bad Gateway" };
  if (url.includes("/status")) {
    return {
      ok: true,
      data: { running: true, opportunityCount: 0, lastScanAt: null, universe: "all", universeSymbols: [] },
    };
  }
  if (url.includes("/opportunities")) return { ok: true, data: { opportunities: [] } };
  return { ok: true, data: {} };
});

vi.mock("@/lib/api/safeJson", () => ({ safeJson: (...a: unknown[]) => safeJsonMock(...(a as [string])) }));

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
vi.mock("@/hooks/useViewMode", () => ({ useViewMode: () => ({ realIsAdmin: false }) }));
vi.mock("wouter", () => ({ Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a> }));

// Enumerated lucide icons used by the page + the (real) CompactAlert.
vi.mock("lucide-react", () => {
  const Stub = () => null;
  return {
    Radar: Stub, Play: Stub, Square: Stub, RefreshCw: Stub, Send: Stub,
    TrendingUp: Stub, TrendingDown: Stub, Sliders: Stub, Target: Stub,
    Layers: Stub, Wand2: Stub, Thermometer: Stub, ArrowRight: Stub,
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
  PageTabs: ({ tabs, defaultTab }: { tabs: Tab[]; defaultTab: string }) => {
    const active = tabs.find((t) => t.id === defaultTab) ?? tabs[0];
    return (
      <div data-testid="page-tabs">
        <div data-testid="active-tab">{active?.id}</div>
        {active?.content}
      </div>
    );
  },
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: Kids) => <div>{children}</div>,
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
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: Kids) => <div>{children}</div>,
  SelectContent: ({ children }: Kids) => <div>{children}</div>,
  SelectItem: ({ children }: Kids) => <div>{children}</div>,
  SelectTrigger: ({ children }: Kids) => <div>{children}</div>,
  SelectValue: () => null,
}));

// ---- Heavy scanner / live child surfaces → inert stubs ---------------------
// Each factory is inlined (no shared helper) because vi.mock is hoisted above
// all const declarations.
vi.mock("@/components/trading/SetupQualityBadge", () => ({ SetupQualityBadge: () => null }));
vi.mock("@/components/scanner/RubySetupReason", () => ({ RubySetupReason: () => null }));
vi.mock("@/components/scanner/ScannerTimingBadges", () => ({ ScannerTimingBadges: () => null }));
vi.mock("@/components/scanner/ScannerTradeModal", () => ({ ScannerTradeModal: () => null }));
// The page imports RECENT_SCANNER_TRADES_SECTION_DESCRIPTION from this module
// as well as the component. Spread the real module rather than re-typing the
// sentence here: a copy of it in three mocks would recreate exactly the
// divergence the constant exists to prevent. Only the component is stubbed.
vi.mock("@/components/scanner/RecentScannerTrades", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/scanner/RecentScannerTrades")>()),
  RecentScannerTrades: () => null,
}));
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({ MasterLiveAccessBanner: () => null }));
vi.mock("@/components/scanner/SelectedMarketPanel", () => ({ SelectedMarketPanel: () => null }));
vi.mock("@/components/scanner/ScannerDataHealthPanel", () => ({ ScannerDataHealthPanel: () => null }));
vi.mock("@/components/news/HighImpactEventBanner", () => ({ HighImpactEventBanner: () => null }));
vi.mock("@/components/scanner/SymbolExplorer", () => ({ SymbolExplorer: () => null }));
vi.mock("@/components/scanner/ScannerChartPanel", () => ({ ScannerChartPanel: () => null }));
vi.mock("@/components/live/TradeHealthPanel", () => ({ TradeHealthPanel: () => null }));
vi.mock("@/components/scanner/ScannerHeaderSummary", () => ({ ScannerHeaderSummary: () => null }));
vi.mock("@/components/scanner/RubyScalpFocusCard", () => ({ RubyScalpFocusCard: () => null }));
vi.mock("@/components/scanner/RubyScalpScan", () => ({ RubyScalpScan: () => null }));
vi.mock("@/components/scanner/RubyMarketReadCard", () => ({ RubyMarketReadCard: () => null }));
vi.mock("@/components/scanner/TimingIntelligenceCard", () => ({ TimingIntelligenceCard: () => null }));
vi.mock("@/components/scanner/ScannerReadGate", () => ({ ScannerReadGate: () => null }));
vi.mock("@/components/scanner/BroadScanOpportunityMap", () => ({ BroadScanOpportunityMap: () => null }));
vi.mock("@/components/scanner/RubyScalpBasketPanel", () => ({ RubyScalpBasketPanel: () => null }));
vi.mock("@/components/scanner/RubyScalpReviewPanel", () => ({ RubyScalpReviewPanel: () => null }));

// Imported AFTER the mocks so the page picks up the stubbed modules.
import MarketScanner from "./market-scanner";

function setVisibility(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  outageArmed = true;
  safeJsonMock.mockClear();
  setVisibility(false);
});
afterEach(() => cleanup());

describe("Market Scanner — degraded banner on the Focus tab", () => {
  it("shows the honest 'Scanner error' banner on the default Focus tab during an outage", async () => {
    render(<MarketScanner />);

    // The default tab is Focus…
    expect((await screen.findByTestId("active-tab")).textContent).toBe("focus");

    // …and the page-scoped degraded banner appears with the honest copy.
    const banner = await screen.findByTestId("scanner-error");
    expect(banner.textContent).toContain("Scanner error");
    expect(banner.textContent).toContain(SCANNER_DEGRADED_MESSAGE);
  });

  it("clears the banner when the scanner feeds recover", async () => {
    render(<MarketScanner />);

    // Outage first → banner present.
    await screen.findByTestId("scanner-error");

    // Recover the feeds, then force an immediate reload (visibility return runs
    // load() without waiting for the 5s poll tick).
    outageArmed = false;
    setVisibility(true);
    setVisibility(false);

    await waitFor(() => expect(screen.queryByTestId("scanner-error")).toBeNull());
    // Still on the Focus tab after recovery.
    expect(screen.getByTestId("active-tab").textContent).toBe("focus");
  });

  it("offers a 'Retry now' action that re-runs load() and clears on success", async () => {
    render(<MarketScanner />);

    // Outage first → banner present with a Retry now button.
    await screen.findByTestId("scanner-error");
    const retry = await screen.findByTestId("scanner-error-retry");
    expect(retry.textContent).toContain("Retry now");

    // Recover the feeds, then click Retry — load() should re-fetch and the
    // banner should self-dismiss on the successful reload (no 5s poll wait).
    outageArmed = false;
    fireEvent.click(retry);

    await waitFor(() => expect(screen.queryByTestId("scanner-error")).toBeNull());
  });
});
