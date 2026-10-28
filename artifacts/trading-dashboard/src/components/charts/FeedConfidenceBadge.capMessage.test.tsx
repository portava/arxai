import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import { feedConfidence, capConfidence } from "@/lib/feed-confidence";
import { FeedConfidenceBadge } from "@/components/charts/FeedConfidenceBadge";

// Regression: capConfidence rewrote the label/severity/AI flag but kept the
// server's message, and the popover's State row read raw fs.isLive — so a
// capped chip read "Unconfirmed · No AI" while its own popover said
// "Live feed active for EURUSD (your broker's MetaTrader 5 feed)." and
// "State: Live".

afterEach(() => cleanup());

const LIVE_MSG = "Live feed active for EURUSD (your broker's MetaTrader 5 feed).";

function cleanLiveFeed(over: Partial<ChartFeedStatus> = {}): ChartFeedStatus {
  return {
    symbol: "EURUSD", displaySymbol: "EUR/USD", assetClass: "forex", source: "mt5_broker",
    isLive: true, lastTickTime: new Date().toISOString(), lastCandleTime: new Date().toISOString(),
    latencyMs: 80, missing: 0, duplicate: 0, outOfOrder: 0, invalidOhlc: 0, stale: false,
    quality: "clean", warning: null, aiUsable: true, feedReadinessState: "ready", message: LIVE_MSG,
    ...over,
  } as ChartFeedStatus;
}

function openPopover(resolved: boolean | null): HTMLElement {
  const view = render(<FeedConfidenceBadge feedStatus={cleanLiveFeed()} aiUsableResolved={resolved} />);
  fireEvent.click(view.container.querySelector('[data-testid="arx-feed-badge"]')!);
  const detail = document.body.querySelector<HTMLElement>('[data-testid="arx-feed-detail"]');
  expect(detail).not.toBeNull();
  return detail!;
}

describe("capConfidence — a capped verdict never keeps a live claim in its message", () => {
  it("resolved false: message no longer says the feed is live", () => {
    const raw = feedConfidence(cleanLiveFeed());
    expect(raw.severity).toBe("clean");
    const capped = capConfidence(raw, false);
    expect(capped.message).not.toBe(raw.message);
    expect(capped.message).not.toMatch(/live feed active/i);
  });
  it("resolved null: message says it is still being checked", () => {
    const capped = capConfidence(feedConfidence(cleanLiveFeed()), null);
    expect(capped.message).not.toMatch(/live feed active/i);
  });
  it("resolved true / omitted: the server message is kept", () => {
    const raw = feedConfidence(cleanLiveFeed());
    expect(capConfidence(raw, true).message).toBe(LIVE_MSG);
    expect(capConfidence(raw, undefined).message).toBe(LIVE_MSG);
  });
});

describe("FeedConfidenceBadge popover agrees with its capped chip", () => {
  it("Unconfirmed: no 'Live feed active' detail and the State row does not read Live", () => {
    const detail = openPopover(false);
    expect(detail.textContent).toContain("Unconfirmed feed");
    expect(detail.textContent).not.toContain("Live feed active");
    expect(detail.textContent).not.toMatch(/State\s*Live/);
  });
  it("Checking…: no 'Live feed active' detail and the State row does not read Live", () => {
    const detail = openPopover(null);
    expect(detail.textContent).toContain("Checking… feed");
    expect(detail.textContent).not.toContain("Live feed active");
    expect(detail.textContent).not.toMatch(/State\s*Live/);
  });
  it("confirmed: keeps the server message and State Live", () => {
    const detail = openPopover(true);
    expect(detail.textContent).toContain("Live feed active");
    expect(detail.textContent).toMatch(/State\s*Live/);
  });
});
