// Truth regression: the feed popover (live chart, Ruby Chart Read, chat bubble)
//  - must not say "Last candle: just now" for a timestamp in the future (the
//    forming bar's scheduled close), independent of whether ticks arrive;
//  - must not print the raw Deriv readiness token (e.g. AUTH_FAILED).
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import { relativeTime, feedReadinessLabel } from "@/lib/feed-confidence";
import { FeedConfidenceBadge } from "./FeedConfidenceBadge";

afterEach(() => cleanup());

function feed(over: Record<string, unknown> = {}): ChartFeedStatus {
  return {
    symbol: "R_75", displaySymbol: "Volatility 75", assetClass: "synthetic", source: "deriv_public",
    isLive: false, lastTickTime: new Date(Date.now() - 10 * 60_000).toISOString(),
    lastCandleTime: new Date(Date.now() - 60_000).toISOString(), latencyMs: 40,
    missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0, invalidOhlcCount: 0,
    stale: true, quality: "stale", warning: null, aiUsable: false, message: "stale",
    ...over,
  } as unknown as ChartFeedStatus;
}

function openRow(fs: ChartFeedStatus, label: string): string {
  render(<FeedConfidenceBadge feedStatus={fs} />);
  fireEvent.click(screen.getByTestId("arx-feed-badge"));
  const detail = screen.getByTestId("arx-feed-detail");
  const row = [...detail.querySelectorAll("div")].find((el) => el.firstElementChild?.textContent === label);
  if (!row) throw new Error(`row ${label} missing`);
  return row.lastElementChild?.textContent ?? "";
}

describe("relativeTime", () => {
  it("never calls a future timestamp 'just now'", () => {
    const value = relativeTime(new Date(Date.now() + 45 * 60_000).toISOString());
    expect(value).not.toBe("just now");
    expect(value).toMatch(/^in 4[45]m$/);
  });
  it("still formats past timestamps", () => {
    expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m ago");
  });
});

describe("FeedConfidenceBadge popover", () => {
  it("shows a future last-candle time as a forming bar, not 'just now'", () => {
    const value = openRow(feed({ lastCandleTime: new Date(Date.now() + 45 * 60_000).toISOString() }), "Last candle");
    expect(value).not.toMatch(/just now/);
    expect(value).toMatch(/forming/i);
  });

  it.each(["AUTH_FAILED", "CONNECTING", "HISTORY_READY_AWAITING_LIVE_TICK", "SOMETHING_NEW"])(
    "prints plain readiness copy for %s", (state) => {
      const value = openRow(feed({ feedReadinessState: state }), "Readiness");
      expect(value).not.toMatch(/[A-Z]+_[A-Z_]+/);
      expect(value).not.toContain(state);
      expect(value).toBe(feedReadinessLabel(state));
    });
});
