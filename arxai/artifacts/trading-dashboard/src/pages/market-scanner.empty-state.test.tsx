// Task #573 Part A — render proof that the scanner distinguishes NEVER-SCANNED
// from SCANNED-EMPTY.
//
// The honesty bug: a fresh page with zero opportunities and a finished scan that
// found zero opportunities must NOT show the same copy. "No scan run yet …" is a
// prompt to act; "Scan complete — no qualifying setups …" is a truthful result.
// Conflating them either nags a user who already scanned or implies a result the
// scanner never produced.
//
// This is a true DOM render proof (not a source scan): it mounts the real page,
// asserts the NEVER-SCANNED branch, drives the real `scan()` through a mocked
// fetch + `safeJson` that return ZERO opportunities, then asserts the branch
// flips to SCANNED-EMPTY (and back-asserts the other branch is gone each time).
//
// The page imports ~30 heavy child surfaces (incl. lightweight-charts, which
// can't render headlessly), so — exactly like the companion cooldown proof —
// every child + data hook is stubbed and only the empty-state logic is exercised.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useEffect } from "react";

// ---- Scan endpoint: always a clean success (the `api()` helper uses fetch) --
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/market-scanner/scan")) {
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  }
  return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
});

// ---- `load()` reads: healthy, but ZERO opportunities for every universe ------
const defaultReads = async (url: string) => {
  if (url.includes("/universes")) return { ok: true, data: { universes: [] } };
  if (url.includes("/status")) {
    return {
      ok: true,
      data: { running: false, opportunityCount: 0, lastScanAt: null, universe: "all", universeSymbols: [] },
    };
  }
  if (url.includes("/opportunities")) return { ok: true, data: { opportunities: [] } };
  return { ok: true, data: {} };
};
const safeJsonMock = vi.fn(defaultReads);
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
vi.mock("@/lib/symbolRegistry", () => ({ resolveSymbol: (s: string) => ({ canonicalSymbol: s }) }));
vi.mock("@/hooks/useViewMode", () => ({ useViewMode: () => ({ realIsAdmin: false }) }));
vi.mock("wouter", () => ({ Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a> }));

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
  PageTabs: ({ tabs }: { tabs: Tab[] }) => (
    <div data-testid="page-tabs">{tabs.map((t) => <div key={t.id}>{t.content}</div>)}</div>
  ),
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: Kids) => <div>{children}</div>,
  CardContent: ({ children, ...rest }: Kids & { "data-testid"?: string }) => (
    <div data-testid={rest["data-testid"]}>{children}</div>
  ),
  CardHeader: ({ children }: Kids) => <div>{children}</div>,
  CardTitle: ({ children }: Kids) => <div>{children}</div>,
  CardDescription: ({ children }: Kids) => <div>{children}</div>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, ...rest }: Kids & {
    onClick?: () => void; disabled?: boolean; "data-testid"?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} data-testid={rest["data-testid"]}>{children}</button>
  ),
}));
vi.mock("@/components/ui/badge", () => ({ Badge: ({ children }: Kids) => <span>{children}</span> }));
vi.mock("@/components/ui/CompactAlert", () => ({
  CompactAlert: ({ children, description }: Kids & { description?: React.ReactNode }) => (
    <div>{description}{children}</div>
  ),
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, onValueChange }: Kids & { onValueChange?: (v: string) => void }) => (
    <div>
      <button data-testid="universe-change" onClick={() => onValueChange?.("crypto")}>change universe</button>
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
// Task #605 — a configurable stub of the opportunity map. By default (null) it's
// inert (renders nothing, never calls onScanned) so the existing empty-state
// proofs are unaffected. A test can set the signal to drive the REAL
// onScanned → page `scanExists` wiring (the populated-map-suppresses-"No scan
// run yet" path), exactly like the real component reports a scan upward.
const mapScanSignal = vi.hoisted(() => ({ value: null as boolean | null }));
vi.mock("@/components/scanner/BroadScanOpportunityMap", () => ({
  BroadScanOpportunityMap: ({ onScanned }: { onScanned?: (scanned: boolean) => void }) => {
    useEffect(() => {
      if (mapScanSignal.value !== null) onScanned?.(mapScanSignal.value);
    }, [onScanned]);
    return null;
  },
}));
vi.mock("@/components/scanner/RubyScalpBuilder", () => ({ RubyScalpBuilder: () => null }));
vi.mock("@/components/scanner/RubyScalpBasketPanel", () => ({ RubyScalpBasketPanel: () => null }));
vi.mock("@/components/scanner/RubyScalpReviewPanel", () => ({ RubyScalpReviewPanel: () => null }));

// Imported AFTER the mocks so the page picks up the stubbed modules.
import MarketScanner from "./market-scanner";

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  fetchMock.mockClear();
  safeJsonMock.mockClear();
  safeJsonMock.mockImplementation(defaultReads);
  mapScanSignal.value = null;
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Market Scanner — empty-state honesty (never-scanned vs scanned-empty)", () => {
  it("shows the NEVER-SCANNED prompt on a fresh page (no scan has run)", async () => {
    render(<MarketScanner />);
    await settle();

    expect(screen.getByTestId("scanner-never-scanned")).toBeTruthy();
    expect(screen.queryByTestId("scanner-scanned-empty")).toBeNull();
    expect(screen.getByTestId("scanner-never-scanned").textContent).toMatch(/No scan run yet/i);
  });

  it("flips to the SCANNED-EMPTY result after a scan that finds zero setups", async () => {
    render(<MarketScanner />);
    await settle();
    expect(screen.getByTestId("scanner-never-scanned")).toBeTruthy();

    // Drive the REAL scan() → load() chain; the mocked reads return zero opps.
    await act(async () => {
      fireEvent.click(screen.getByTestId("scanner-btn-scan"));
      await Promise.resolve();
    });
    await settle();

    // The branch must flip: scanned-empty appears, never-scanned is gone.
    expect(screen.getByTestId("scanner-scanned-empty")).toBeTruthy();
    expect(screen.queryByTestId("scanner-never-scanned")).toBeNull();
    expect(screen.getByTestId("scanner-scanned-empty").textContent).toMatch(/Scan complete/i);
  });

  it("the two empty states use distinct, non-interchangeable copy", async () => {
    render(<MarketScanner />);
    await settle();
    const neverCopy = screen.getByTestId("scanner-never-scanned").textContent ?? "";

    await act(async () => {
      fireEvent.click(screen.getByTestId("scanner-btn-scan"));
      await Promise.resolve();
    });
    await settle();
    const scannedCopy = screen.getByTestId("scanner-scanned-empty").textContent ?? "";

    expect(neverCopy.length).toBeGreaterThan(0);
    expect(scannedCopy.length).toBeGreaterThan(0);
    expect(scannedCopy).not.toBe(neverCopy);
  });

  // Task #600 scanner-truth regression — assertion (4): the no-scan empty state
  // cannot appear when results exist. A fresh React session never clicked scan
  // (hasScanned=false), zero opportunities — but the SERVER reports a real
  // lastScanAt (the always-on engine or a prior scan ran). The page must defer to
  // server truth (`scanExists = hasScanned || Boolean(status?.lastScanAt)`) and
  // show the truthful SCANNED-EMPTY result, never the NEVER-SCANNED prompt — so it
  // can't claim "no scan run" while the opportunity map above shows a scan count.
  it("(4) shows SCANNED-EMPTY (not NEVER-SCANNED) when the server reports a prior scan", async () => {
    safeJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/universes")) return { ok: true, data: { universes: [] } };
      if (url.includes("/status")) {
        return {
          ok: true,
          data: {
            running: false,
            opportunityCount: 0,
            lastScanAt: "2026-06-08T11:00:00Z",
            universe: "all",
            universeSymbols: [],
          },
        };
      }
      if (url.includes("/opportunities")) return { ok: true, data: { opportunities: [] } };
      return { ok: true, data: {} };
    });

    render(<MarketScanner />);
    await settle();

    // No scan() was clicked this session, yet the server's lastScanAt is truth.
    expect(screen.getByTestId("scanner-scanned-empty")).toBeTruthy();
    expect(screen.queryByTestId("scanner-never-scanned")).toBeNull();
  });

  // Task #605 — the populated opportunity map reports a REAL scan up to the page
  // via onScanned; the page folds it into `scanExists`. So even on a fresh session
  // (no scan() click this session, the server reports no lastScanAt, zero
  // opportunities) the legacy results block must show the truthful SCANNED-EMPTY
  // result — it can NOT claim "No scan run yet" while a populated opportunity map
  // sits directly above it (the exact contradiction this onScanned wiring fixed).
  it("(#605) shows SCANNED-EMPTY (not NEVER-SCANNED) when the opportunity map reports a scan", async () => {
    mapScanSignal.value = true;
    render(<MarketScanner />);
    await settle();

    expect(screen.getByTestId("scanner-scanned-empty")).toBeTruthy();
    expect(screen.queryByTestId("scanner-never-scanned")).toBeNull();
  });
});

// ── Scanner empty-state honesty: a scan that RAN on a degraded / historical- ──
//    only / read-only feed must never read as "nothing scanned" ────────────────
//
// The third confusable state (beyond NEVER-SCANNED and SCANNED-EMPTY): a scan
// genuinely RAN and readable but degraded/historical-only/read-only data exists,
// yet zero ACTIONABLE setups qualified. The empty-state area must tell the truth
// ("Scan complete — no qualifying setups …") and must NEVER fall back to the
// NEVER-SCANNED prompt or any wording implying nothing happened — that would
// either nag a user who already scanned or deny a scan the engine actually ran.
//
// These proofs drive the REAL page wiring (`scanExists = hasScanned ||
// status.lastScanAt || mapScanned`) with scan-existence proven two honest ways —
// the server's `lastScanAt` and the opportunity map's `onScanned` — each over a
// historical-only / read-only / feed-unconfirmed feed (`feedNote`) with zero
// opportunities, then assert both the honest result wording AND the absence of
// any never-scanned phrasing from the rendered DOM.
//
// TEST-ONLY: asserts existing behaviour; no page logic, contract, resolver, or
// backend scan path is changed.
const NEVER_SCANNED_PHRASES = [
  "No scan run yet",
  "Run a scan to get started",
  "to analyze the market",
];

describe("Market Scanner — a scan that ran on a degraded feed never reads as never-scanned", () => {
  it("server reports a prior scan over a historical-only / read-only feed, zero setups → SCANNED-EMPTY honest copy", async () => {
    safeJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/universes")) return { ok: true, data: { universes: [] } };
      if (url.includes("/status")) {
        return {
          ok: true,
          data: {
            running: false,
            opportunityCount: 0,
            // A scan genuinely RAN (server truth)…
            lastScanAt: "2026-06-09T09:30:00Z",
            universe: "all",
            universeSymbols: [],
            // …but the feed/read data is historical-only / read-only.
            feedNote: "Historical-only feed — latest candles are not live-confirmed (read-only).",
          },
        };
      }
      if (url.includes("/opportunities")) return { ok: true, data: { opportunities: [] } };
      return { ok: true, data: {} };
    });

    render(<MarketScanner />);
    await settle();

    // The honest scanned-empty RESULT renders (a scan ran, nothing qualified)…
    const scanned = screen.getByTestId("scanner-scanned-empty");
    expect(scanned.textContent).toMatch(/Scan complete/i);
    expect(scanned.textContent).toMatch(/no qualifying setups/i);
    // …never the NEVER-SCANNED prompt…
    expect(screen.queryByTestId("scanner-never-scanned")).toBeNull();
    // …and a degraded read on a successful poll is NOT misread as an error.
    expect(screen.queryByTestId("scanner-empty-degraded")).toBeNull();
    // …with NO "nothing happened" phrasing in the empty-state area (scoped to
    // the results empty-state container so unrelated page text can't perturb it).
    const emptyState = screen.getByTestId("scanner-empty-state").textContent ?? "";
    for (const phrase of NEVER_SCANNED_PHRASES) {
      expect(emptyState).not.toContain(phrase);
    }
  });

  it("opportunity map reports a scan over a feed-unconfirmed / read-only feed (no server lastScanAt), zero setups → SCANNED-EMPTY honest copy", async () => {
    // Server reports NO prior scan (lastScanAt null) and the feed is read-only,
    // but the populated opportunity map above reported a real scan up to the page
    // via onScanned — so `scanExists` is driven ONLY by the map here.
    safeJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/universes")) return { ok: true, data: { universes: [] } };
      if (url.includes("/status")) {
        return {
          ok: true,
          data: {
            running: false,
            opportunityCount: 0,
            lastScanAt: null,
            universe: "all",
            universeSymbols: [],
            feedNote: "Feed not confirmed — showing read-only history.",
          },
        };
      }
      if (url.includes("/opportunities")) return { ok: true, data: { opportunities: [] } };
      return { ok: true, data: {} };
    });
    mapScanSignal.value = true;

    render(<MarketScanner />);
    await settle();

    const scanned = screen.getByTestId("scanner-scanned-empty");
    expect(scanned.textContent).toMatch(/Scan complete/i);
    expect(screen.queryByTestId("scanner-never-scanned")).toBeNull();
    expect(screen.queryByTestId("scanner-empty-degraded")).toBeNull();
    const emptyState = screen.getByTestId("scanner-empty-state").textContent ?? "";
    for (const phrase of NEVER_SCANNED_PHRASES) {
      expect(emptyState).not.toContain(phrase);
    }
  });
});
