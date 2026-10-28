// Truth regression: the feed popover (live chart, Ruby Chart Read, chat bubble)
//  - must not say "Last candle: just now" for a timestamp in the future (the
//    forming bar's scheduled close), independent of whether ticks arrive;
//  - must not print the raw Deriv readiness token (e.g. AUTH_FAILED).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";
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

describe("FeedConfidenceBadge popover clock", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("ages the Last tick / Last candle rows while the popover stays open", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const t0 = Date.parse("2026-10-28T12:00:00.000Z");
    vi.setSystemTime(t0);
    const fs = feed({
      lastTickTime: new Date(t0 - 12_000).toISOString(),
      lastCandleTime: new Date(t0 + 10 * 60_000).toISOString(),
    });
    render(<FeedConfidenceBadge feedStatus={fs} />);
    fireEvent.click(screen.getByTestId("arx-feed-badge"));
    const row = (label: string) => {
      const detail = screen.getByTestId("arx-feed-detail");
      const el = [...detail.querySelectorAll("div")].find((d) => d.firstElementChild?.textContent === label);
      return el?.lastElementChild?.textContent ?? "";
    };
    expect(row("Last tick")).toBe("12s ago");
    expect(row("Last candle")).toBe("Forming bar · closes in 10m");
    act(() => {
      vi.setSystemTime(t0 + 5 * 60_000);
      vi.advanceTimersByTime(1_000);
    });
    expect(row("Last tick")).toBe("5m ago");
    expect(row("Last candle")).toBe("Forming bar · closes in 4m");
  });
});
