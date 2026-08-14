import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import type { ScannerTruth } from "@/lib/scannerTruth";
import { resolveFeedBadgeVerdict } from "@/lib/rubyReadPanelState";
import { feedConfidence, capConfidence } from "@/lib/feed-confidence";
import { FeedConfidenceBadge } from "@/components/charts/FeedConfidenceBadge";

// ── Live-chart / trade-panel feed-badge cap honesty (Task #521) ──────────────
//
// Task #506 capped the Scanner "Ruby Chart Read" panel's FeedConfidenceBadge by
// the ONE resolved scanner-truth verdict, and Task #511 locked that for every
// other badge reachable from the Scanner. This guard extends the SAME honesty to
// the live-chart header (ARXNativeChart) and the trade-decision surfaces — the
// "Trade from chart" card and the Trade Command Room quick-trade panel — which
// reach the badge through the self-fetching <ChartFeedConfidence> wrapper. None
// of these may ever claim Clean/AI when the resolved truth for the active
// symbol/timeframe is downgraded or still unresolved.
//
// In the current code the badge is reached two ways:
//   - DIRECT: ARXNativeChart and ChartFeedConfidence render <FeedConfidenceBadge>
//     themselves, always capped with `aiUsableResolved` derived from the shared
//     useScannerTruth verdict (resolveFeedBadgeVerdict).
//   - VIA WRAPPER: ChartTradeEntry and QuickTradePanel render <ChartFeedConfidence>
//     (never a raw badge), which applies the same cap.
//
// This test pins four things so the uncapped "Clean · AI" badge can never be
// reintroduced to these surfaces:
//   1. The cap helper (`capConfidence`) refuses Clean/AI for a downgraded /
//      unresolved verdict, even on a pristine clean+live+AI feed.
//   2. The verdict the surfaces feed the badge is derived from the shared
//      scanner truth exactly as the task requires (full ⇒ true, downgraded ⇒
//      false, unresolved ⇒ null) — via the shared resolveFeedBadgeVerdict.
//   3. Rendering the REAL FeedConfidenceBadge with that derived verdict produces
//      an honest DOM (no Clean/AI when downgraded/unresolved).
//   4. A structural guard: the direct surfaces always cap the badge with
//      `aiUsableResolved`, and the trade-decision surfaces route through the
//      capped ChartFeedConfidence rather than a raw, uncapped badge.

afterEach(() => cleanup());

// A pristine feed that, UNCAPPED, renders the most-confident badge possible:
// clean quality, live, aiUsable true. Any honest cap must downgrade THIS.
function cleanLiveFeed(over: Partial<ChartFeedStatus> = {}): ChartFeedStatus {
  return {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    assetClass: "forex",
    source: "mt5_broker",
    isLive: true,
    lastTickTime: new Date().toISOString(),
    lastCandleTime: new Date().toISOString(),
    latencyMs: 80,
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

type Level = ScannerTruth["analysis"]["level"];
const DOWNGRADED: Level[] = ["limited", "historical_only", "blocked"];

// The exact verdict the chart/trade surfaces feed the badge: derived from the
// shared useScannerTruth resolution via resolveFeedBadgeVerdict (no server
// read-chart response and no parent override on these non-read surfaces).
function badgeVerdictForLevel(level: Level | null): boolean | null {
  return resolveFeedBadgeVerdict(level);
}

describe("Chart/trade feed badge cap — capConfidence honesty (Task #521)", () => {
  it("keeps a clean/AI verdict only when the resolved truth confirms it (true)", () => {
    const conf = capConfidence(feedConfidence(cleanLiveFeed()), true);
    expect(conf.severity).toBe("clean");
    expect(conf.aiUsable).toBe(true);
  });

  it("never claims Clean/AI when the resolved truth is downgraded (false)", () => {
    const conf = capConfidence(feedConfidence(cleanLiveFeed()), false);
    expect(conf.severity).not.toBe("clean");
    expect(conf.aiUsable).toBe(false);
    expect(conf.statusLabel).toBe("Unconfirmed");
  });

  it("renders a neutral checking state when the resolved truth is unresolved (null)", () => {
    const conf = capConfidence(feedConfidence(cleanLiveFeed()), null);
    expect(conf.severity).toBe("unknown");
    expect(conf.aiUsable).toBe(false);
    expect(conf.statusLabel).toBe("Checking…");
  });
});

describe("Chart/trade feed badge cap — verdict derived from shared truth (Task #521)", () => {
  it("maps a full scanner-truth verdict to a confirmed (true) badge", () => {
    expect(badgeVerdictForLevel("full")).toBe(true);
  });

  it("maps every downgraded scanner-truth verdict to a not-confirmed (false) badge", () => {
    for (const level of DOWNGRADED) {
      expect(badgeVerdictForLevel(level), `level=${level}`).toBe(false);
    }
  });

  it("maps an unresolved scanner-truth verdict to an unknown (null) badge", () => {
    expect(badgeVerdictForLevel(null)).toBeNull();
  });
});

describe("Chart/trade feed badge cap — rendered badge is capped (Task #521)", () => {
  function badgeEl(c: HTMLElement): HTMLElement {
    const el = c.querySelector<HTMLElement>('[data-testid="arx-feed-badge"]');
    expect(el, "the feed badge must render").not.toBeNull();
    return el!;
  }

  it("shows Clean + AI on a clean feed only when the truth is full", () => {
    const view = render(
      <FeedConfidenceBadge
        feedStatus={cleanLiveFeed()}
        aiUsableResolved={badgeVerdictForLevel("full")}
      />,
    );
    const el = badgeEl(view.container);
    expect(el.getAttribute("data-severity")).toBe("clean");
    expect(el.getAttribute("data-ai-usable")).toBe("true");
  });

  it("never paints Clean/AI on a clean feed when the truth is downgraded", () => {
    for (const level of DOWNGRADED) {
      const view = render(
        <FeedConfidenceBadge
          feedStatus={cleanLiveFeed()}
          aiUsableResolved={badgeVerdictForLevel(level)}
        />,
      );
      const el = badgeEl(view.container);
      expect(el.getAttribute("data-severity"), `level=${level}`).not.toBe("clean");
      expect(el.getAttribute("data-ai-usable"), `level=${level}`).toBe("false");
      cleanup();
    }
  });

  it("paints a neutral, no-AI badge on a clean feed while the truth is unresolved", () => {
    const view = render(
      <FeedConfidenceBadge
        feedStatus={cleanLiveFeed()}
        aiUsableResolved={badgeVerdictForLevel(null)}
      />,
    );
    const el = badgeEl(view.container);
    expect(el.getAttribute("data-severity")).toBe("unknown");
    expect(el.getAttribute("data-ai-usable")).toBe("false");
  });
});

// ── Structural guard: these surfaces never reintroduce an uncapped badge ──────
//
// The honesty above only holds because every badge on these surfaces is capped.
// The direct surfaces must always pass `aiUsableResolved`; the trade-decision
// surfaces must reach the badge only through the capped ChartFeedConfidence
// wrapper. If a future edit drops a raw, uncapped <FeedConfidenceBadge> into a
// trade surface, or strips the cap off a direct surface, this guard reads the
// real source and fails the build on that reintroduction.
describe("Chart/trade feed badge cap — structural routing guard (Task #521)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => readFileSync(path.join(here, rel), "utf8");

  // Surfaces that render the badge DIRECTLY must always cap it with a resolved
  // verdict (aiUsableResolved derived from the shared scanner truth).
  const CAPPED_DIRECT = [
    {
      file: "ChartFeedConfidence.tsx",
      label: "the self-fetching feed-confidence chip",
    },
    { file: "ARXNativeChart.tsx", label: "the live-chart header" },
  ];

  for (const { file, label } of CAPPED_DIRECT) {
    it(`${label} renders FeedConfidenceBadge only with a resolved cap (aiUsableResolved)`, () => {
      const src = read(file);
      expect(
        /<FeedConfidenceBadge/.test(src),
        `${file} must render FeedConfidenceBadge`,
      ).toBe(true);
      // `[^>]*` spans newlines, so this holds across the multi-line JSX as long
      // as `aiUsableResolved` sits before the tag's closing `>`.
      expect(
        /<FeedConfidenceBadge[^>]*aiUsableResolved=/.test(src),
        `${file} must cap FeedConfidenceBadge with aiUsableResolved`,
      ).toBe(true);
    });
  }

  // Trade-decision surfaces must reach the badge ONLY through the capped
  // ChartFeedConfidence wrapper — never a raw, uncapped FeedConfidenceBadge.
  const VIA_WRAPPER = [
    {
      file: "ChartTradeEntry.tsx",
      label: "the live-chart Trade-from-chart card",
    },
    {
      file: "../dashboard/trade/QuickTradePanel.tsx",
      label: "the Trade Command Room quick-trade panel",
    },
  ];

  for (const { file, label } of VIA_WRAPPER) {
    it(`${label} routes feed confidence through the capped ChartFeedConfidence, not a raw badge`, () => {
      const src = read(file);
      expect(
        /<FeedConfidenceBadge/.test(src),
        `${file} must not render FeedConfidenceBadge directly — route it through the capped ChartFeedConfidence`,
      ).toBe(false);
      expect(
        /<ChartFeedConfidence/.test(src),
        `${file} must render ChartFeedConfidence (the capped feed-badge path)`,
      ).toBe(true);
    });
  }
});

// ── Trailing-interval gap in the popover (Task #778) ─────────────────────────
//
// The diagnostic popover must surface HOW MANY recent bar-intervals are missing
// (the trailing-interval gap that drives "delayed" vs "stale") next to the
// existing State row — and must read "—" honestly when the gap is unknown.
describe("Feed badge popover — trailing-interval gap (Task #778)", () => {
  function openPopover(fs: ChartFeedStatus): HTMLElement {
    const view = render(<FeedConfidenceBadge feedStatus={fs} />);
    fireEvent.click(view.container.querySelector('[data-testid="arx-feed-badge"]')!);
    const detail = document.body.querySelector<HTMLElement>(
      '[data-testid="arx-feed-detail"]',
    );
    expect(detail, "the detail popover must render when opened").not.toBeNull();
    return detail!;
  }

  it("renders the trailing-interval gap count alongside the State row", () => {
    const detail = openPopover(cleanLiveFeed({ trailingIntervals: 2, quality: "delayed" }));
    expect(detail.textContent).toContain("Missing intervals");
    // The exact gap number must be shown so delayed (2) vs stale (>=3) is clear.
    expect(detail.textContent).toMatch(/Missing intervals\s*2/);
  });

  it("reads an honest dash when the gap is unknown (no candles)", () => {
    const detail = openPopover(cleanLiveFeed({ trailingIntervals: null }));
    expect(detail.textContent).toContain("Missing intervals");
    expect(detail.textContent).toMatch(/Missing intervals\s*—/);
  });
});

// ── Inline trailing-interval gap on the ALWAYS-VISIBLE chip (Task #780) ───────
//
// The popover already carries the full "Missing intervals" row (#778). For the
// Ruby chat feed chip the count must also show inline on the always-visible chip
// (no click), but ONLY when the caller opts in via `showTrailingGap` — every
// other FeedConfidenceBadge caller keeps the bare chip. The count is suppressed
// for a current feed (<=1) and reads an honest "—" when unknown.
describe("Feed badge chip — inline trailing-interval gap (Task #780)", () => {
  function chipText(fs: ChartFeedStatus, showTrailingGap = false): string {
    const view = render(
      <FeedConfidenceBadge feedStatus={fs} showTrailingGap={showTrailingGap} />,
    );
    const btn = view.container.querySelector<HTMLElement>(
      '[data-testid="arx-feed-badge"]',
    );
    const text = btn?.textContent ?? "";
    cleanup();
    return text;
  }

  it("shows the count inline on the always-visible chip when opted in", () => {
    const text = chipText(
      cleanLiveFeed({ trailingIntervals: 3, quality: "stale", isLive: false, stale: true }),
      true,
    );
    expect(text).toContain("3 missing");
  });

  it("does NOT render the inline count without opt-in (other callers unchanged)", () => {
    const text = chipText(
      cleanLiveFeed({ trailingIntervals: 3, quality: "stale", isLive: false, stale: true }),
      false,
    );
    expect(text).not.toContain("missing");
  });

  it("suppresses the inline count for a current feed (<=1, the clean baseline)", () => {
    const text = chipText(cleanLiveFeed({ trailingIntervals: 1 }), true);
    expect(text).not.toContain("missing");
  });

  it("reads an honest dash inline when the gap is unknown (null) and opted in", () => {
    const text = chipText(
      cleanLiveFeed({ trailingIntervals: null, quality: "delayed", isLive: false }),
      true,
    );
    expect(text).toContain("—");
  });
});
