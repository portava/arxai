// Scanner chart feed-status badge ↔ live API agreement (Task #510).
//
// WHAT THIS LOCKS
//   The rendered Scanner chart feed-status badge ("Delayed market data" /
//   "Stale · last-known" / "Live feed unavailable · Analysis only" / no badge
//   when LIVE) must ALWAYS reflect the honest GET /api/chart/candles feedStatus
//   for the same symbol/timeframe, and must NEVER render a more-live badge than
//   the API actually reports.
//
//   Task #502 only verified the pure resolver (resolveDisplayStatus) at source
//   level. The remaining gap was the *rendered* badge: ScannerChartPanel used to
//   carry its OWN inline copy of the badge JSX (a drift surface), and the badge
//   the user actually sees is driven by useScannerTruth → resolveScannerTruth's
//   `displayStatus`, NOT resolveDisplayStatus directly. This test renders the
//   REAL shared <ChartFeedStatusBadge> (now the single source the Scanner header
//   uses, via testIdPrefix="scanner-chart") driven by the REAL resolveScannerTruth
//   derivation, so a drift between the API feed state and the painted badge fails
//   the build.
//
// WHY A jsdom RENDER TEST (+ an env-gated live leg) — not a Playwright screenshot
//   The Scanner sits behind the app's session wall: the headless screenshot tool
//   cannot inject the arx_user_session cookie, so a real authenticated browser
//   capture of this badge is impossible in this environment. Instead we (a) render
//   the REAL badge component against a matrix of real-API-shaped ChartFeedStatus
//   values that mirror every quality/isLive/stale/source shape the contract emits
//   (always runs — the durable CI guarantee), and (b) optionally drive the SAME
//   render+assert against the genuinely-live GET /api/chart/candles responses for
//   a logged-in user when ARX_BADGE_LIVE_BASE + ARX_BADGE_LIVE_COOKIE are provided
//   (the authenticated end-to-end leg; skipped cleanly in CI so the suite stays
//   green without secrets).

import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import {
  resolveDisplayStatus,
  type FeedStatus,
  type ChartDisplayStatus,
} from "@/lib/chart-display-status";
import {
  resolveScannerTruth,
  type ScannerTruthInputs,
  type ScannerTruthMode,
} from "@/lib/scannerTruth";
import { ChartFeedStatusBadge } from "@/components/charts/ChartFeedStatusBadge";

// ── Honesty ordering ─────────────────────────────────────────────────────────
// Higher rank = SAFER (less live). The rendered badge must never claim a rank
// LOWER (more live) than what the raw API feedStatus resolves to.
const SAFETY_RANK: Record<ChartDisplayStatus, number> = {
  LIVE: 0,
  FALLBACK_COMPOSITE: 1,
  STALE: 2,
  ANALYSIS_ONLY: 3,
  UNAVAILABLE: 4,
};

// The visible badge each display state renders (LIVE / UNAVAILABLE render none).
const EXPECTED_BADGE: Record<
  ChartDisplayStatus,
  { testId: string; text: string } | null
> = {
  LIVE: null,
  UNAVAILABLE: null,
  FALLBACK_COMPOSITE: { testId: "scanner-chart-feed-delayed", text: "Delayed market data" },
  STALE: { testId: "scanner-chart-feed-stale", text: "Stale · last-known" },
  ANALYSIS_ONLY: {
    testId: "scanner-chart-feed-analysis",
    text: "Live feed unavailable · Analysis only",
  },
};

// Read which feed-status badge the rendered DOM is actually showing (the exact
// scanner-chart-feed-* testids ScannerChartPanel renders).
function renderedBadge(c: HTMLElement): { testId: string; text: string } | null {
  for (const tid of [
    "scanner-chart-feed-delayed",
    "scanner-chart-feed-stale",
    "scanner-chart-feed-analysis",
  ]) {
    const el = c.querySelector(`[data-testid="${tid}"]`);
    if (el) return { testId: tid, text: (el.textContent ?? "").trim() };
  }
  return null;
}

const NOW = Date.parse("2026-06-08T12:00:00.000Z");

function feed(over: Partial<ChartFeedStatus> = {}): ChartFeedStatus {
  return {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    assetClass: "forex",
    source: "twelvedata",
    isLive: true,
    lastTickTime: new Date(NOW).toISOString(),
    lastCandleTime: new Date(NOW).toISOString(),
    latencyMs: 100,
    missing: 0,
    duplicate: 0,
    outOfOrder: 0,
    invalidOhlc: 0,
    stale: false,
    quality: "clean",
    warning: null,
    aiUsable: true,
    feedReadinessState: "ready",
    message: "ok",
    ...over,
  } as ChartFeedStatus;
}

function mode(over: Partial<ScannerTruthMode> = {}): ScannerTruthMode {
  return {
    isLoading: false,
    isDemo: true,
    isLiveShared: false,
    isPaper: false,
    isLiveArmed: false,
    isFrozen: false,
    canManualTrade: true,
    canAutoTrade: false,
    isSharedMasterAssigned: false,
    ownBridgeConnected: false,
    approvalStatus: null,
    frozenReason: null,
    cleanBlockedReason: null,
    ...over,
  };
}

// A truth input that is fresh + has plenty of candles, so a clean+live feed
// resolves all the way to LIVE (not downgraded by min-candle / age gating). The
// per-case feedStatus is what actually moves the resolved badge.
function inputsFor(
  feedStatus: ChartFeedStatus | null,
  over: Partial<ScannerTruthInputs> = {},
): ScannerTruthInputs {
  const candleCount = over.candleCount ?? 200;
  return {
    symbolDisplay: "EURUSD",
    symbolInternal: "EURUSD",
    timeframe: "5m",
    feedStatus,
    candleCount,
    requestedCount: 200,
    firstTime: new Date(NOW - candleCount * 5 * 60_000).toISOString(),
    lastTime: new Date(NOW - 10_000).toISOString(),
    lastClose: 1.10501,
    quote: null,
    headerOk: null,
    mode: mode(),
    nowMs: NOW,
    ...over,
  };
}

function toFeedForDisplay(fs: ChartFeedStatus | null): FeedStatus | null {
  if (!fs) return null;
  return {
    isLive: fs.isLive,
    stale: fs.stale,
    quality: fs.quality as FeedStatus["quality"],
    source: fs.source,
    aiUsable: fs.aiUsable,
    warning: fs.warning,
    message: fs.message,
    lastCandleTime: fs.lastCandleTime,
  };
}

// Render the REAL badge exactly as ScannerChartPanel does and assert it agrees
// with the truth derivation AND never out-lives the raw API feedStatus.
function assertBadgeAgrees(input: ScannerTruthInputs, label: string) {
  const truth = resolveScannerTruth(input);
  const hasCandles = input.candleCount > 0;
  const rawApi = resolveDisplayStatus(toFeedForDisplay(input.feedStatus), hasCandles);

  const view = render(
    <ChartFeedStatusBadge
      status={truth.displayStatus}
      hasCandles={hasCandles}
      testIdPrefix="scanner-chart"
    />,
  );
  const painted = renderedBadge(view.container);
  cleanup();

  // 1) The painted badge is EXACTLY the badge documented for the resolved state.
  const expected = EXPECTED_BADGE[truth.displayStatus];
  if (expected === null) {
    expect(painted, `${label}: ${truth.displayStatus} must paint NO feed badge`).toBeNull();
  } else {
    expect(painted, `${label}: expected a feed badge for ${truth.displayStatus}`).not.toBeNull();
    expect(painted!.testId, `${label}: wrong badge testid`).toBe(expected.testId);
    expect(painted!.text, `${label}: wrong badge copy`).toBe(expected.text);
  }

  // 2) NEVER more live than the API: the rendered (truth-driven) state must be
  //    equal-or-safer than the bare API feedStatus verdict.
  expect(
    SAFETY_RANK[truth.displayStatus],
    `${label}: rendered "${truth.displayStatus}" is MORE LIVE than API "${rawApi}"`,
  ).toBeGreaterThanOrEqual(SAFETY_RANK[rawApi]);

  return { truth, rawApi, painted };
}

describe("Scanner chart feed badge ↔ API feedStatus agreement (Task #510)", () => {
  // Every real-API-shaped feedStatus shape the GET /api/chart/candles contract
  // can emit, paired with the badge a user must see.
  const cases: Array<{
    name: string;
    fs: ChartFeedStatus | null;
    over?: Partial<ScannerTruthInputs>;
    expect: ChartDisplayStatus;
  }> = [
    { name: "clean + live (fresh, enough candles)", fs: feed(), expect: "LIVE" },
    {
      name: "clean + live but broker-native source",
      fs: feed({ source: "mt5_broker" }),
      expect: "LIVE",
    },
    { name: "quality=delayed", fs: feed({ quality: "delayed", isLive: false }), expect: "FALLBACK_COMPOSITE" },
    {
      name: "not-live + not-aiUsable composite source → delayed",
      fs: feed({ isLive: false, aiUsable: false, quality: "clean", source: "polygon" }),
      expect: "FALLBACK_COMPOSITE",
    },
    { name: "quality=stale", fs: feed({ quality: "stale", isLive: false }), expect: "STALE" },
    { name: "stale flag set", fs: feed({ stale: true, isLive: false }), expect: "STALE" },
    { name: "quality=partial", fs: feed({ quality: "partial", isLive: false }), expect: "ANALYSIS_ONLY" },
    { name: "quality=invalid", fs: feed({ quality: "invalid", isLive: false }), expect: "ANALYSIS_ONLY" },
    {
      name: "not-live broker-native (no composite fallback)",
      fs: feed({ isLive: false, aiUsable: false, quality: "clean", source: "mt5_broker" }),
      expect: "ANALYSIS_ONLY",
    },
    { name: "quality=empty", fs: feed({ quality: "empty", isLive: false }), expect: "UNAVAILABLE" },
    {
      name: "quality=unavailable",
      fs: feed({ quality: "unavailable", isLive: false }),
      expect: "UNAVAILABLE",
    },
    { name: "no feedStatus, no candles", fs: null, over: { candleCount: 0 }, expect: "UNAVAILABLE" },
  ];

  for (const c of cases) {
    it(`paints the honest badge for: ${c.name}`, () => {
      const input = inputsFor(c.fs, c.over);
      const { truth } = assertBadgeAgrees(input, c.name);
      expect(truth.displayStatus, `${c.name}: resolved display state`).toBe(c.expect);
    });
  }

  it("header feed-unavailable (ok=false) caps a would-be LIVE badge to analysis-only", () => {
    // The API says clean+live, but the header reports the feed unavailable. The
    // chart must NOT out-live the header — the rendered badge degrades.
    const input = inputsFor(feed(), { headerOk: false });
    const { truth, painted } = assertBadgeAgrees(input, "headerOk=false cap");
    expect(truth.displayStatus).toBe("ANALYSIS_ONLY");
    expect(painted?.testId).toBe("scanner-chart-feed-analysis");
  });

  it("a too-thin candle window downgrades a clean+live feed below LIVE", () => {
    // Honest min-candle gating: even with a clean+live feedStatus, an
    // insufficient window must never render the live (no-badge) affordance.
    const input = inputsFor(feed(), { candleCount: 5 });
    const { truth, rawApi } = assertBadgeAgrees(input, "thin window");
    expect(rawApi).toBe("LIVE"); // the bare API verdict WAS live …
    expect(truth.displayStatus).not.toBe("LIVE"); // … but the rendered badge is not.
  });
});

// ── Inline trailing-interval gap on the always-visible chip (Task #780) ──────
//
// The Scanner header chip now appends an inline "· N missing" count (reusing the
// shared formatTrailingGap over the SAME ChartFeedStatus.trailingIntervals the
// feed-details popover reads) so a degrading feed is diagnosable without opening
// the popover. The count is suppressed for a current feed (<=1, the clean
// baseline), reads an honest "—" when explicitly unknown, and never appears when
// the prop is omitted (e.g. the position mini-chart).
describe("Scanner chart feed chip — inline trailing-interval gap (Task #780)", () => {
  function chipText(
    status: ChartDisplayStatus,
    trailingIntervals: number | null | undefined,
  ): string {
    const view = render(
      <ChartFeedStatusBadge
        status={status}
        hasCandles
        testIdPrefix="scanner-chart"
        trailingIntervals={trailingIntervals}
      />,
    );
    const el = renderedBadge(view.container);
    cleanup();
    return el?.text ?? "";
  }

  it("appends the missing-interval count on a delayed chip", () => {
    expect(chipText("FALLBACK_COMPOSITE", 2)).toBe("Delayed market data · 2 missing");
  });

  it("appends the count after the existing copy on a stale chip", () => {
    expect(chipText("STALE", 4)).toBe("Stale · last-known · 4 missing");
  });

  it("appends the count on an analysis-only chip", () => {
    expect(chipText("ANALYSIS_ONLY", 3)).toBe(
      "Live feed unavailable · Analysis only · 3 missing",
    );
  });

  it("suppresses the suffix for a current feed (<=1, the clean baseline)", () => {
    expect(chipText("FALLBACK_COMPOSITE", 1)).toBe("Delayed market data");
    expect(chipText("FALLBACK_COMPOSITE", 0)).toBe("Delayed market data");
  });

  it("reads an honest dash when the gap is explicitly unknown (null)", () => {
    expect(chipText("STALE", null)).toBe("Stale · last-known · —");
  });

  it("keeps the bare copy when no trailingIntervals prop is supplied", () => {
    expect(chipText("FALLBACK_COMPOSITE", undefined)).toBe("Delayed market data");
  });
});

// ── Authenticated live-API leg (env-gated) ──────────────────────────────────
// Runs only when pointed at a running server with a real session cookie, e.g.:
//   ARX_BADGE_LIVE_BASE=http://localhost:80 \
//   ARX_BADGE_LIVE_COOKIE='arx_user_session=<token>' \
//   pnpm --filter @workspace/trading-dashboard run test -- ScannerChartFeedBadge
const LIVE_BASE = process.env.ARX_BADGE_LIVE_BASE;
const LIVE_COOKIE = process.env.ARX_BADGE_LIVE_COOKIE;
const liveLeg = LIVE_BASE && LIVE_COOKIE ? describe : describe.skip;

liveLeg("Scanner chart feed badge ↔ LIVE GET /api/chart/candles (authenticated)", () => {
  const SYMBOLS = ["EURUSD", "GBPUSD", "XAUUSD"];
  const TIMEFRAMES = ["M5", "H1", "D1"];

  async function fetchCandles(symbol: string, tf: string) {
    const url = `${LIVE_BASE}/api/chart/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${tf}&limit=200`;
    const res = await fetch(url, { headers: { cookie: LIVE_COOKIE as string } });
    expect(res.status, `${symbol} ${tf}: authenticated request must succeed (got ${res.status})`).toBe(200);
    const body = (await res.json()) as {
      candles?: Array<{ time?: number; openTime?: string; close?: number }>;
      feedStatus?: ChartFeedStatus | null;
    };
    return body;
  }

  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      it(`rendered badge matches live feedStatus for ${symbol} ${tf}`, async () => {
        const body = await fetchCandles(symbol, tf);
        const candles = Array.isArray(body.candles) ? body.candles : [];
        const last = candles.length > 0 ? candles[candles.length - 1] : null;
        const first = candles.length > 0 ? candles[0] : null;
        const toIso = (c: { time?: number; openTime?: string } | null): string | null => {
          if (!c) return null;
          if (typeof c.time === "number") return new Date(c.time).toISOString();
          if (typeof c.openTime === "string") return c.openTime;
          return null;
        };
        const input = inputsFor(body.feedStatus ?? null, {
          symbolDisplay: symbol,
          symbolInternal: symbol,
          candleCount: candles.length,
          firstTime: toIso(first),
          lastTime: toIso(last),
          lastClose: last?.close ?? null,
          nowMs: Date.now(),
        });
        // Drives the SAME real render + never-more-live assertion against the
        // genuinely-live authenticated API response.
        assertBadgeAgrees(input, `${symbol} ${tf}`);
      });
    }
  }
});
