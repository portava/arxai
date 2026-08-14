import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import type { ScannerTruth } from "@/lib/scannerTruth";
import { resolveRubyReadPanelState } from "@/lib/rubyReadPanelState";
import {
  feedConfidence,
  capConfidence,
} from "@/lib/feed-confidence";
import { FeedConfidenceBadge } from "@/components/charts/FeedConfidenceBadge";

// ── Scanner feed-badge cap honesty (Task #511) ──────────────────────────────
//
// Task #506 made the Scanner "Ruby Chart Read" panel cap its FeedConfidenceBadge
// by the ONE resolved scanner-truth verdict. This guard locks the SAME honesty
// for every place the same badge is reachable from the Scanner chart panel and
// the per-signal scalp cards: the badge there must never claim Clean/AI when the
// resolved truth for that symbol/timeframe is downgraded or still unresolved.
//
// In the current code BOTH surfaces reach FeedConfidenceBadge exclusively through
// <RubyChartRead> (ScannerChartPanel renders it under the chart; ScalpSignalCard
// renders it under "Ask Ruby"), and that component caps the badge with
// `aiUsableResolved={panel.badgeAiUsable}` derived from the shared useScannerTruth
// verdict. The Scanner chart header itself uses the honest copy-fixed
// ChartFeedStatusBadge (Task #510), which never reads "Clean · AI".
//
// This test pins three things so the uncapped "Clean · AI" badge can never be
// reintroduced to these surfaces:
//   1. The cap helper (`capConfidence`) refuses Clean/AI for a downgraded /
//      unresolved verdict, even on a pristine clean+live+AI feed.
//   2. The verdict the surfaces feed the badge is derived from the shared
//      scanner truth exactly as the task requires: full ⇒ true, downgraded ⇒
//      false, unresolved ⇒ null.
//   3. Rendering the REAL FeedConfidenceBadge with that derived verdict produces
//      an honest DOM (no Clean/AI when downgraded/unresolved).
//   4. A structural guard: neither ScannerChartPanel nor ScalpSignalCard renders
//      a raw, uncapped FeedConfidenceBadge — they route it through the capped
//      RubyChartRead, which always passes `aiUsableResolved`.

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

// The exact verdict each surface feeds the badge: derived from the shared
// useScannerTruth resolution via resolveRubyReadPanelState BEFORE any read has
// run (read: null), which is what RubyChartRead passes as `badgeAiUsable`.
function badgeVerdictForLevel(level: Level | null): boolean | null {
  return resolveRubyReadPanelState({
    truthLevel: level,
    truthReason: null,
    aiUsableProp: undefined,
    read: null,
  }).badgeAiUsable;
}

describe("Scanner feed badge cap — capConfidence honesty (Task #511)", () => {
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

describe("Scanner feed badge cap — verdict derived from shared truth (Task #511)", () => {
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

describe("Scanner feed badge cap — rendered badge is capped (Task #511)", () => {
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

// ── Structural guard: the named surfaces never reintroduce an uncapped badge ──
//
// The honesty above only holds because both surfaces reach the badge through the
// capped RubyChartRead. If a future edit drops a raw <FeedConfidenceBadge> into
// either file (the original Task #511 regression), it would bypass the cap. This
// guard reads the real source and fails the build on that reintroduction.
describe("Scanner feed badge cap — structural routing guard (Task #511)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => readFileSync(path.join(here, rel), "utf8");

  const NAMED_SURFACES = [
    { file: "ScannerChartPanel.tsx", label: "the Scanner chart panel" },
    { file: "ScalpSignalCard.tsx", label: "the per-signal scalp card" },
  ];

  for (const { file, label } of NAMED_SURFACES) {
    it(`${label} routes feed confidence through the capped RubyChartRead, not a raw badge`, () => {
      const src = read(file);
      // No direct <FeedConfidenceBadge ...> JSX (which would be uncapped here).
      expect(
        /<FeedConfidenceBadge/.test(src),
        `${file} must not render FeedConfidenceBadge directly — route it through the capped RubyChartRead`,
      ).toBe(false);
      // It DOES render the capped RubyChartRead (the only sanctioned path to the
      // badge on these surfaces).
      expect(
        /<RubyChartRead/.test(src),
        `${file} must render RubyChartRead (the capped feed-badge path)`,
      ).toBe(true);
    });
  }

  it("RubyChartRead caps the badge with a resolved verdict (aiUsableResolved)", () => {
    const src = read("RubyChartRead.tsx");
    expect(/<FeedConfidenceBadge/.test(src)).toBe(true);
    expect(
      /<FeedConfidenceBadge[^>]*aiUsableResolved=/.test(src),
      "RubyChartRead must pass aiUsableResolved to FeedConfidenceBadge",
    ).toBe(true);
  });
});
