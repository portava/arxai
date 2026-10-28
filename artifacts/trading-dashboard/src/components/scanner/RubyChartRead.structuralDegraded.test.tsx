import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ScannerTruth } from "@/lib/scannerTruth";
import { resolveRubyReadPanelState, type RubyReadServerState } from "@/lib/rubyReadPanelState";

// Regression: a STORED STRUCTURAL_ONLY read (produced while the feed was
// delayed) outranked the CURRENT shared truth after it degraded to
// historical-only / blocked. The panel kept "Conditional BUY — structural read
// only" with the server's old "Live feed is delayed…" reason and no
// feed-not-confirmed banner, while the header for the same key said
// "Historical read only — not valid for a live entry".

const mockUseScannerTruth = vi.fn();
vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: (...args: unknown[]) => mockUseScannerTruth(...args),
}));
vi.mock("@/components/charts/FeedConfidenceBadge", () => ({
  FeedConfidenceBadge: () => <span data-testid="feed-confidence-badge" />,
}));
let mockStoredRead: RubyReadServerState | null = null;
vi.mock("@/components/scanner/rubyReadStore", () => ({
  useRubyReadStore: () => ({
    get: () => mockStoredRead,
    set: (_s: string, _t: string, next: RubyReadServerState | null) => {
      mockStoredRead = next;
    },
  }),
}));

import { RubyChartRead } from "./RubyChartRead";

const DELAYED_REASON = "Live feed is delayed — read uses the last confirmed bars, not the current candle.";
const FROZEN_REASON = "The latest candle is frozen — this is historical context, not a live read.";

function structuralRead(band: string | undefined): RubyReadServerState {
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    bias: "Bullish",
    confidence: "Medium",
    why: "Trend structure leans up.",
    supportZone: "1.0800 – 1.0810",
    resistanceZone: "1.0890 – 1.0900",
    cautions: [],
    gated: false,
    dataQuality: "ok",
    readLayer: "STRUCTURAL_ONLY",
    liveSetupWithheld: true,
    canReadStructure: true,
    canShowLiveTradeSetup: false,
    ...(band ? { tradeHealthFreshness: band } : {}),
    blockedReason: DELAYED_REASON,
    observedAt: new Date(Date.now() - 10_000).toISOString(),
  } as unknown as RubyReadServerState;
}

function truthAt(level: ScannerTruth["analysis"]["level"], reason: string): ScannerTruth {
  return { analysis: { level, reason } } as unknown as ScannerTruth;
}

beforeEach(() => {
  mockUseScannerTruth.mockReset();
  mockStoredRead = null;
});
afterEach(() => cleanup());

describe("resolveRubyReadPanelState — current truth outranks a stored structural tier", () => {
  it("read produced on a delayed feed, truth now historical_only → not_confirmed with the truth's reason", () => {
    const panel = resolveRubyReadPanelState({
      truthLevel: "historical_only",
      truthReason: FROZEN_REASON,
      aiUsableProp: undefined,
      read: structuralRead("LIVE_DELAYED"),
    });
    expect(panel.verdict).toBe("not_confirmed");
    expect(panel.feedNotConfirmed).toBe(true);
    expect(panel.reason).toBe(FROZEN_REASON);
    expect(panel.badgeAiUsable).toBe(false);
  });

  it("truth now blocked (no data) → not_confirmed even when the read's band is unknown", () => {
    const panel = resolveRubyReadPanelState({
      truthLevel: "blocked",
      truthReason: "No market data — analysis is unavailable.",
      aiUsableProp: undefined,
      read: structuralRead(undefined),
    });
    expect(panel.verdict).toBe("not_confirmed");
    expect(panel.reason).toBe("No market data — analysis is unavailable.");
  });

  it("truth still limited (same as the read's delayed band) keeps the structural verdict", () => {
    const panel = resolveRubyReadPanelState({
      truthLevel: "limited",
      truthReason: "Delayed market data — readable, but slightly behind live.",
      aiUsableProp: undefined,
      read: structuralRead("LIVE_DELAYED"),
    });
    expect(panel.verdict).toBe("structural_only");
    expect(panel.reason).toBe(DELAYED_REASON);
  });

  it("a read already produced on historical data keeps the structural verdict under historical truth", () => {
    const panel = resolveRubyReadPanelState({
      truthLevel: "historical_only",
      truthReason: FROZEN_REASON,
      aiUsableProp: undefined,
      read: structuralRead("HISTORICAL_ONLY"),
    });
    expect(panel.verdict).toBe("structural_only");
  });
});

describe("RubyChartRead render — degraded truth over a stored structural read", () => {
  it("shows the feed warning with the current reason, no structural notice, and a WAIT decision", () => {
    mockUseScannerTruth.mockReturnValue({
      truth: truthAt("historical_only", FROZEN_REASON),
      feedStatus: null,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockStoredRead = structuralRead("LIVE_DELAYED");
    render(<RubyChartRead symbol="EURUSD" timeframe="15m" draft={null} />);
    const banner = screen.getByTestId("ruby-chart-read-feed-warning");
    expect(banner.textContent).toContain(FROZEN_REASON);
    expect(screen.queryByTestId("ruby-chart-read-structural-notice")).toBeNull();
    const body = screen.getByTestId("ruby-chart-read").textContent ?? "";
    expect(body).not.toContain("structural read only");
    expect(body).not.toContain(DELAYED_REASON);
    const decision = screen.getByTestId("ruby-chart-read-reasoning-decision").textContent ?? "";
    expect(decision).toMatch(/WAIT/);
    expect(decision).not.toMatch(/Conditional BUY/);
  });
});
