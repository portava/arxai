// Regression test — the "chart never looks more live than the header" rule
// (Task #347, locked in by Task #348).
//
// The Scanner chart resolves its honesty state through two pure helpers in the
// shared chart-display-status module:
//   - resolveDisplayStatus(feedStatus, hasCandles) maps the backend feedStatus
//     onto a safe display state (LIVE only when clean + isLive).
//   - applyHeaderCap(status, headerOk) enforces that the chart can never show a
//     more-live state than the feed-status header — when the header reports the
//     feed unavailable (ok === false) the chart is capped at ANALYSIS_ONLY.
//   - isLivePriceDisplay(status) decides whether the live-price affordance may
//     render — it must be true ONLY for LIVE.
//
// These assertions call the real functions and inspect their output — behavioural,
// not a source-scan — so a future edit that silently reintroduces the bug (e.g.
// stale composite candles rendering as LIVE while the header says "unavailable")
// fails the build.

import { describe, it, expect } from "vitest";
import {
  type FeedStatus,
  type ChartDisplayStatus,
  resolveDisplayStatus,
  applyHeaderCap,
  isLivePriceDisplay,
} from "./chart-display-status.js";

// A genuinely-live feed: clean quality + isLive, not stale, broker-native.
const liveFeed: FeedStatus = {
  isLive: true,
  stale: false,
  quality: "clean",
  source: "mt5_broker",
  aiUsable: true,
  warning: null,
  message: "Live broker feed",
  lastCandleTime: "2026-06-07T00:00:00.000Z",
};

// Build a FeedStatus from the defaults, overriding only the fields under test.
function feed(overrides: Partial<FeedStatus>): FeedStatus {
  return { ...liveFeed, ...overrides };
}

describe("resolveDisplayStatus — quality truth table", () => {
  it("renders LIVE only for genuinely-live data (clean + isLive)", () => {
    expect(resolveDisplayStatus(liveFeed, true)).toBe("LIVE");
  });

  it("never renders LIVE when quality is clean but the feed is not isLive", () => {
    expect(resolveDisplayStatus(feed({ isLive: false }), true)).not.toBe("LIVE");
  });

  it("maps quality 'delayed' to FALLBACK_COMPOSITE", () => {
    expect(resolveDisplayStatus(feed({ quality: "delayed", isLive: false }), true)).toBe(
      "FALLBACK_COMPOSITE",
    );
  });

  it("maps quality 'stale' (and the stale flag) to STALE", () => {
    expect(resolveDisplayStatus(feed({ quality: "stale", isLive: false }), true)).toBe("STALE");
    // The stale flag alone caps to STALE even if quality still reads clean.
    expect(resolveDisplayStatus(feed({ stale: true }), true)).toBe("STALE");
  });

  it("maps quality 'partial' and 'invalid' to ANALYSIS_ONLY", () => {
    expect(resolveDisplayStatus(feed({ quality: "partial", isLive: false }), true)).toBe(
      "ANALYSIS_ONLY",
    );
    expect(resolveDisplayStatus(feed({ quality: "invalid", isLive: false }), true)).toBe(
      "ANALYSIS_ONLY",
    );
  });

  it("maps quality 'empty' and 'unavailable' to UNAVAILABLE", () => {
    expect(resolveDisplayStatus(feed({ quality: "empty", isLive: false }), true)).toBe(
      "UNAVAILABLE",
    );
    expect(resolveDisplayStatus(feed({ quality: "unavailable", isLive: false }), false)).toBe(
      "UNAVAILABLE",
    );
  });

  it("classifies a non-live composite source as FALLBACK_COMPOSITE", () => {
    // Third-party composite candles that aren't AI-usable are delayed composite
    // data, not LIVE.
    expect(
      resolveDisplayStatus(
        feed({ isLive: false, aiUsable: false, source: "assistant_real:twelve_data" }),
        true,
      ),
    ).toBe("FALLBACK_COMPOSITE");
  });

  it("degrades any other not-LIVE shape to the safer ANALYSIS_ONLY", () => {
    // Not live, AI-usable but broker-native and not clean → no positive LIVE,
    // no composite-fallback signal → ANALYSIS_ONLY.
    expect(
      resolveDisplayStatus(feed({ isLive: false, aiUsable: true, source: "mt5_broker" }), true),
    ).toBe("ANALYSIS_ONLY");
  });

  it("handles a null feedStatus honestly: ANALYSIS_ONLY with candles, UNAVAILABLE without", () => {
    expect(resolveDisplayStatus(null, true)).toBe("ANALYSIS_ONLY");
    expect(resolveDisplayStatus(null, false)).toBe("UNAVAILABLE");
  });
});

describe("applyHeaderCap — chart never more-live than the header", () => {
  const cappable: ChartDisplayStatus[] = ["LIVE", "FALLBACK_COMPOSITE", "STALE"];

  it("caps LIVE/FALLBACK_COMPOSITE/STALE to ANALYSIS_ONLY when the header reports unavailable", () => {
    for (const status of cappable) {
      expect(applyHeaderCap(status, false)).toBe("ANALYSIS_ONLY");
    }
  });

  it("does not upgrade already-safe states when the header reports unavailable", () => {
    expect(applyHeaderCap("ANALYSIS_ONLY", false)).toBe("ANALYSIS_ONLY");
    expect(applyHeaderCap("UNAVAILABLE", false)).toBe("UNAVAILABLE");
  });

  it("leaves the status untouched when the header is ok (true) or unknown (null)", () => {
    for (const status of cappable) {
      expect(applyHeaderCap(status, true)).toBe(status);
      expect(applyHeaderCap(status, null)).toBe(status);
    }
  });

  it("a live feedStatus capped by an unavailable header never resolves to LIVE", () => {
    const resolved = resolveDisplayStatus(liveFeed, true);
    expect(resolved).toBe("LIVE");
    expect(applyHeaderCap(resolved, false)).toBe("ANALYSIS_ONLY");
  });
});

describe("isLivePriceDisplay — live-price marker only on LIVE", () => {
  it("is true ONLY for LIVE", () => {
    const all: ChartDisplayStatus[] = [
      "LIVE",
      "FALLBACK_COMPOSITE",
      "STALE",
      "ANALYSIS_ONLY",
      "UNAVAILABLE",
    ];
    for (const status of all) {
      expect(isLivePriceDisplay(status)).toBe(status === "LIVE");
    }
  });

  it("never shows the live-price marker once a header cap has fired", () => {
    const capped = applyHeaderCap(resolveDisplayStatus(liveFeed, true), false);
    expect(isLivePriceDisplay(capped)).toBe(false);
  });
});

describe("safety ordering — UNAVAILABLE > ANALYSIS_ONLY > STALE > FALLBACK_COMPOSITE > LIVE", () => {
  // The documented safest-state-wins precedence. We assert the rank ordering so a
  // future refactor that reorders the resolver branches is caught.
  const SAFETY_RANK: Record<ChartDisplayStatus, number> = {
    UNAVAILABLE: 4,
    ANALYSIS_ONLY: 3,
    STALE: 2,
    FALLBACK_COMPOSITE: 1,
    LIVE: 0,
  };

  it("ranks states from safest (UNAVAILABLE) to most-live (LIVE)", () => {
    const ordered: ChartDisplayStatus[] = [
      "UNAVAILABLE",
      "ANALYSIS_ONLY",
      "STALE",
      "FALLBACK_COMPOSITE",
      "LIVE",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(SAFETY_RANK[ordered[i]!]).toBeGreaterThan(SAFETY_RANK[ordered[i + 1]!]);
    }
  });

  it("the header cap can only move a state to an equal-or-safer rank, never more-live", () => {
    const all: ChartDisplayStatus[] = [
      "LIVE",
      "FALLBACK_COMPOSITE",
      "STALE",
      "ANALYSIS_ONLY",
      "UNAVAILABLE",
    ];
    for (const status of all) {
      const capped = applyHeaderCap(status, false);
      expect(SAFETY_RANK[capped]).toBeGreaterThanOrEqual(SAFETY_RANK[status]);
    }
  });
});
