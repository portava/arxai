// Truth sweep 2026-11-04 (TRUTH-2/4/5): the feed badge names a shared feed,
// bridge contention, a receive-time tick stamp and stored history / closed market.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import { FeedConfidenceBadge } from "./FeedConfidenceBadge";

afterEach(() => cleanup());

function feed(over: Record<string, unknown> = {}): ChartFeedStatus {
  return {
    symbol: "EURUSD", displaySymbol: "EUR/USD", assetClass: "forex", source: "mt5_broker",
    isLive: true, lastTickTime: new Date(Date.now() - 5 * 60_000).toISOString(),
    lastCandleTime: new Date(Date.now() - 60_000).toISOString(), latencyMs: 40,
    missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0, invalidOhlcCount: 0, trailingIntervals: 1,
    stale: false, quality: "clean", warning: null, aiUsable: true, message: "Live feed active",
    ...over,
  } as unknown as ChartFeedStatus;
}

function row(label: string): string {
  const detail = screen.getByTestId("arx-feed-detail");
  const r = [...detail.querySelectorAll("div")].find((el) => el.firstElementChild?.textContent === label);
  return r?.lastElementChild?.textContent ?? "";
}

describe("FeedConfidenceBadge provenance (TRUTH-2)", () => {
  it("shows a shared-feed chip and a contention chip", () => {
    render(<FeedConfidenceBadge feedStatus={feed({ feedScope: "platform_shared", contention: true })} />);
    expect(screen.getByTestId("arx-feed-scope-platform_shared").textContent).toBe("Shared feed — not your bridge");
    expect(screen.getByTestId("arx-feed-scope-contention")).toBeTruthy();
  });
  it("shows no chip for the trader's own bridge", () => {
    render(<FeedConfidenceBadge feedStatus={feed({ feedScope: "own_bridge", contention: false })} />);
    expect(screen.queryByTestId("arx-feed-scope-platform_shared")).toBeNull();
    expect(screen.queryByTestId("arx-feed-scope-contention")).toBeNull();
  });
  it("marks a server-receive last tick as (received)", () => {
    render(<FeedConfidenceBadge feedStatus={feed({ lastTickTimeBasis: "server_receive" })} />);
    fireEvent.click(screen.getByTestId("arx-feed-badge"));
    expect(row("Last tick")).toBe("5m ago (received)");
  });
  it("leaves a producer tick time unmarked", () => {
    render(<FeedConfidenceBadge feedStatus={feed({ lastTickTimeBasis: "producer_tick" })} />);
    fireEvent.click(screen.getByTestId("arx-feed-badge"));
    expect(row("Last tick")).toBe("5m ago");
  });
});

describe("FeedConfidenceBadge not-live reasons (TRUTH-4/5)", () => {
  it("stored history: label, State row and server message — never Delayed", () => {
    render(<FeedConfidenceBadge feedStatus={feed({ isLive: false, aiUsable: false, notLiveReason: "stored_history", message: "Showing stored EURUSD candles." })} />);
    fireEvent.click(screen.getByTestId("arx-feed-badge"));
    expect(row("State")).toBe("Stored history");
    const detail = screen.getByTestId("arx-feed-detail").textContent ?? "";
    expect(detail).toContain("Stored history feed");
    expect(detail).toContain("Showing stored EURUSD candles.");
    expect(detail).not.toContain("Delayed");
  });
  it("market closed: label and State row", () => {
    render(<FeedConfidenceBadge feedStatus={feed({ isLive: false, stale: true, aiUsable: false, notLiveReason: "market_closed", message: "Market closed for EURUSD." })} />);
    fireEvent.click(screen.getByTestId("arx-feed-badge"));
    expect(row("State")).toBe("Market closed");
    expect(screen.getByTestId("arx-feed-detail").textContent).toContain("Market closed for EURUSD.");
  });
});
