// Behavioral render proof — the Scan-button cooldown countdown (Task #565).
//
// After a *successful* manual scan the Scan button disables and shows a live
// "Scan again in Ns" countdown seeded from the mirrored client constant; a 429
// reconciles that deadline to the server's authoritative `retryAfterMs`; and the
// button re-enables once the countdown reaches zero. This locks that UX so a
// future refactor can't silently break the disable/countdown/reconcile logic.
//
// The page imports ~30 heavy child surfaces (incl. lightweight-charts, which
// can't render headlessly), so — exactly like the companion outage-banner proof
// — every child + data hook is stubbed and the real `scan()` is driven through a
// mocked `fetch` (the `api()` helper) + a mocked `safeJson` (the `load()` poll).
// Fake timers drive the 250ms cooldown tick deterministically.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ---- Controllable scan endpoint (the `api()` helper uses global fetch) -----
type ScanOutcome = "success" | "rate_limited";
let scanOutcome: ScanOutcome = "success";
let serverRetryAfterMs = 3_000;

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/market-scanner/scan")) {
    if (scanOutcome === "rate_limited") {
      return {
        ok: false,
        status: 429,
        json: async () => ({ ok: false, reason: "SCAN_RATE_LIMITED", retryAfterMs: serverRetryAfterMs }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  }
  return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
});

// ---- `load()` reads — always healthy so no degraded banner interferes -------
const safeJsonMock = vi.fn(async (url: string) => {
  if (url.includes("/universes")) return { ok: true, data: { universes: [] } };
  if (url.includes("/status")) {
    return {
      ok: true,
      data: { running: false, opportunityCount: 0, lastScanAt: null, universe: "all", universeSymbols: [] },
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
  // Render EVERY tab's content so the Scan button (Broad Scan card, Advanced
  // tab) is always mounted regardless of the default tab.
  PageTabs: ({ tabs }: { tabs: Tab[] }) => (
    <div data-testid="page-tabs">{tabs.map((t) => <div key={t.id}>{t.content}</div>)}</div>
  ),
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
vi.mock("@/components/scanner/RubyScalpScan", () => ({ RubyScalpScan: () => null }));
vi.mock("@/components/scanner/RubyMarketReadCard", () => ({ RubyMarketReadCard: () => null }));
vi.mock("@/components/scanner/TimingIntelligenceCard", () => ({ TimingIntelligenceCard: () => null }));
vi.mock("@/components/scanner/ScannerReadGate", () => ({ ScannerReadGate: () => null }));
vi.mock("@/components/scanner/BroadScanOpportunityMap", () => ({ BroadScanOpportunityMap: () => null }));
vi.mock("@/components/scanner/RubyScalpBasketPanel", () => ({ RubyScalpBasketPanel: () => null }));
vi.mock("@/components/scanner/RubyScalpReviewPanel", () => ({ RubyScalpReviewPanel: () => null }));

// Imported AFTER the mocks so the page picks up the stubbed modules.
import MarketScanner from "./market-scanner";

function scanButton(): HTMLButtonElement {
  return screen.getByTestId("scanner-btn-scan") as HTMLButtonElement;
}

// Settle the async scan()/load() promise chains and any due fake timers.
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  scanOutcome = "success";
  serverRetryAfterMs = 3_000;
  mockRealIsAdmin = false;
  fetchMock.mockClear();
  safeJsonMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Market Scanner — Scan-button cooldown countdown", () => {
  it("disables the Scan button and shows a countdown after a successful scan", async () => {
    render(<MarketScanner />);
    await settle();

    const btn = scanButton();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain("Scan");
    expect(btn.textContent).not.toContain("Scan again in");

    // Successful one-shot scan → proactively cools the button down for the
    // mirrored client window (7s) since the success response carries no timer.
    await act(async () => {
      fireEvent.click(btn);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Scan again in 7s");
  });

  it("reconciles the countdown to the server's retryAfterMs on a 429", async () => {
    render(<MarketScanner />);
    await settle();

    // Server reports a remaining wait DIFFERENT from the 7s client default so a
    // pass only proves the deadline was reconciled to the server value, not the
    // mirrored constant.
    scanOutcome = "rate_limited";
    serverRetryAfterMs = 3_000;

    const btn = scanButton();
    await act(async () => {
      fireEvent.click(btn);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Scan again in 3s");
    expect(btn.textContent).not.toContain("Scan again in 7s");
  });

  it("re-enables the Scan button when the countdown reaches zero", async () => {
    render(<MarketScanner />);
    await settle();

    const btn = scanButton();
    await act(async () => {
      fireEvent.click(btn);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Scan again in 7s");

    // Walk the cooldown down — still disabled mid-window…
    await settle(4_000);
    expect(scanButton().disabled).toBe(true);

    // …and re-enabled once the full window elapses.
    await settle(3_500);
    const after = scanButton();
    expect(after.disabled).toBe(false);
    expect(after.textContent).toContain("Scan");
    expect(after.textContent).not.toContain("Scan again in");
  });
});

describe("Market Scanner — admin universe-switch cooldown", () => {
  it("shows the friendly 'scanning too fast' copy (not a raw error) when an admin switches universes into a 429", async () => {
    mockRealIsAdmin = true;
    render(<MarketScanner />);
    await settle();

    // The admin universe switch fires the SAME rate-limited scan POST as the
    // Scan button. Server reports a remaining wait DIFFERENT from the 7s client
    // default so a pass proves the deadline reconciled to the server value.
    scanOutcome = "rate_limited";
    serverRetryAfterMs = 4_000;

    const changeBtn = screen.getByTestId("universe-change") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(changeBtn);
      await vi.advanceTimersByTimeAsync(0);
    });

    // Honest cooldown copy — never the raw 429 / technical error.
    expect(screen.getByText(/Scanning too fast — try again in 4s\./)).toBeTruthy();
    expect(screen.queryByText(/SCAN_RATE_LIMITED/)).toBeNull();
    expect(screen.queryByText(/\b429\b/)).toBeNull();

    // The shared Scan-button countdown reconciled to the server's window too.
    const scanBtn = scanButton();
    expect(scanBtn.disabled).toBe(true);
    expect(scanBtn.textContent).toContain("Scan again in 4s");
    expect(scanBtn.textContent).not.toContain("Scan again in 7s");
  });

  it("does not fire the rate-limited scan POST for a non-admin universe switch", async () => {
    mockRealIsAdmin = false;
    render(<MarketScanner />);
    await settle();

    fetchMock.mockClear();
    const changeBtn = screen.getByTestId("universe-change") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(changeBtn);
      await vi.advanceTimersByTimeAsync(0);
    });

    const scanPosts = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : String(input);
      return url.includes("/market-scanner/scan");
    });
    expect(scanPosts.length).toBe(0);
  });
});

describe("Market Scanner — mirrored cooldown constant parity", () => {
  it("keeps the client MANUAL_SCAN_COOLDOWN_MS consistent with the server MANUAL_SCAN policy", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "..", "..", "..", "..");

    const pageSrc = readFileSync(path.join(here, "market-scanner.tsx"), "utf8");
    const clientMatch = pageSrc.match(/MANUAL_SCAN_COOLDOWN_MS\s*=\s*([\d_]+)/);
    expect(clientMatch, "client MANUAL_SCAN_COOLDOWN_MS literal found").not.toBeNull();
    const clientMs = Number(clientMatch![1].replace(/_/g, ""));

    const policySrc = readFileSync(
      path.join(repoRoot, "lib", "domain", "src", "security", "operationalPolicies.ts"),
      "utf8",
    );
    const policyMatch = policySrc.match(/MANUAL_SCAN:\s*\{[^}]*cooldownMs:\s*([\d_]+)/);
    expect(policyMatch, "server MANUAL_SCAN cooldownMs literal found").not.toBeNull();
    const serverMs = Number(policyMatch![1].replace(/_/g, ""));

    expect(clientMs).toBe(serverMs);
  });
});
