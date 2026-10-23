import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import { FeedConfidenceBadge } from "@/components/charts/FeedConfidenceBadge";

// ── Ruby chat chart-read feed-confidence badge (Task #777) ───────────────────
//
// The chat chart-read footer reported a feed verdict in PROSE only. Task #777
// brings in the SAME compact FeedConfidenceBadge the chart popover and the
// Scanner "Ruby Chart Read" panel render, driven off the ONE resolved verdict
// that already produced the reasoning block — never a second source of truth.
//
// The honesty contract this guard pins:
//   1. The rendered badge is CAPPED by the resolved read verdict
//      (`aiUsableResolved`) — a pristine clean+live+AI feed can never paint
//      Clean/AI in the chat bubble when the read itself was withheld.
//   2. Structural: the chat panel reaches FeedConfidenceBadge ONLY with an
//      `aiUsableResolved` cap, and resolves the live feed-status detail through
//      the SAME shared `useScannerTruth` query the scanner badge uses (no
//      independent feed-status poll, no uncapped raw badge).

afterEach(() => cleanup());

// A pristine feed that, UNCAPPED, renders the most-confident badge possible.
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

function badgeEl(c: HTMLElement): HTMLElement {
  const el = c.querySelector<HTMLElement>('[data-testid="arx-feed-badge"]');
  expect(el, "the feed badge must render").not.toBeNull();
  return el!;
}

describe("Ruby chat chart-read badge — capped by the resolved read verdict (Task #777)", () => {
  it("shows Clean + AI on a clean feed only when the read was fully confirmed (true)", () => {
    const view = render(
      <FeedConfidenceBadge feedStatus={cleanLiveFeed()} aiUsableResolved={true} />,
    );
    const el = badgeEl(view.container);
    expect(el.getAttribute("data-severity")).toBe("clean");
    expect(el.getAttribute("data-ai-usable")).toBe("true");
  });

  it("never paints Clean/AI on a clean feed when the read was withheld (false)", () => {
    const view = render(
      <FeedConfidenceBadge feedStatus={cleanLiveFeed()} aiUsableResolved={false} />,
    );
    const el = badgeEl(view.container);
    expect(el.getAttribute("data-severity")).not.toBe("clean");
    expect(el.getAttribute("data-ai-usable")).toBe("false");
  });

  it("paints a neutral, no-AI badge while the verdict is unresolved (null)", () => {
    const view = render(
      <FeedConfidenceBadge feedStatus={cleanLiveFeed()} aiUsableResolved={null} />,
    );
    const el = badgeEl(view.container);
    expect(el.getAttribute("data-severity")).toBe("unknown");
    expect(el.getAttribute("data-ai-usable")).toBe("false");
  });
});

// ── Structural guard: the chat panel never reintroduces an uncapped badge ─────
//
// The honesty above only holds because the chat-bubble badge is capped with the
// resolved verdict and resolves its live feed detail through the shared scanner
// truth (the SAME source the scanner badge uses). If a future edit drops a raw,
// uncapped <FeedConfidenceBadge> into the chat panel, or fetches feed status
// from a second source, this guard reads the real source and fails the build.
describe("Ruby chat chart-read badge — structural wiring guard (Task #777)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "ArxAssistantLivePanel.tsx"), "utf8");

  it("renders FeedConfidenceBadge", () => {
    expect(/<FeedConfidenceBadge/.test(src)).toBe(true);
  });

  it("caps every FeedConfidenceBadge with a resolved verdict (aiUsableResolved)", () => {
    // `[^>]*` spans newlines, so this holds across the multi-line JSX as long as
    // `aiUsableResolved` sits before the tag's closing `>`.
    expect(/<FeedConfidenceBadge[^>]*aiUsableResolved=/.test(src)).toBe(true);
  });

  it("resolves live feed detail through the shared useScannerTruth query (no second source)", () => {
    expect(/useScannerTruth\(/.test(src)).toBe(true);
  });
});
