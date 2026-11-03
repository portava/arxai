// Multi-timeframe card: the server marks a report DATA_NOT_CURRENT when any
// timeframe's newest bar is stale or untimestamped (a weekend series, a stalled
// feed). The card must give that label its own style, must not show the score
// measured on old bars as the current alignment or a bias, and every timeframe
// tile must say how old its newest bar is (or that it was not recorded).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MultiTimeframeAlignmentCard, type MultiTimeframeReport } from "./MultiTimeframeAlignmentCard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

/** Pin the clock the card re-checks stored bar times against (Date only). */
function atTime(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

type Fresh = "CURRENT" | "STALE" | "UNKNOWN";
function snap(trend: "UP" | "DOWN" | "SIDEWAYS", newestBarTime: string | null | undefined, freshness: Fresh | undefined) {
  const s: Record<string, unknown> = { trend, strength: 55, slope: 0.1, fastSma: 1.1, slowSma: 1.09, candlesUsed: 120 };
  if (newestBarTime !== undefined) s.newestBarTime = newestBarTime;
  if (freshness !== undefined) s.freshness = freshness;
  return s as MultiTimeframeReport["lowerTrend"];
}

const WARNING = "Not a current read: H4 newest bar opened Fri 20:00 UTC (38 h old). On these bars the timeframes showed strong bullish alignment (score 82/100), but the market may be closed or the feed stalled, so no bias is given.";

function report(over: Partial<MultiTimeframeReport>): MultiTimeframeReport {
  return {
    id: 1, symbol: "EURUSD",
    lowerTimeframe: "M5", middleTimeframe: "H1", higherTimeframe: "H4",
    lowerTrend: snap("UP", "2026-10-24T20:55:00.000Z", "STALE"),
    middleTrend: snap("UP", "2026-10-24T20:00:00.000Z", "STALE"),
    higherTrend: snap("UP", "2026-10-24T20:00:00.000Z", "STALE"),
    alignmentScore: 82, alignmentLabel: "DATA_NOT_CURRENT", conflictWarning: WARNING, bestBias: "NEUTRAL",
    aiSummary: "EURUSD: data is not current — M5 UP (55) as of Sat 20:55 UTC. No trend, alignment or bias is reported as current.",
    createdAt: "2026-10-25T10:00:00.000Z",
    ...over,
  };
}

/**
 * Serve the report the way the API does: with a Date header carrying the
 * server's clock. By default the server's clock reads the same as the pinned
 * browser clock; `serverDate` sets it apart, and null sends no Date header.
 */
function renderWith(r: MultiTimeframeReport, serverDate?: string | null) {
  vi.stubGlobal("fetch", vi.fn(async () => {
    const date = serverDate === undefined ? new Date().toUTCString() : serverDate;
    const headers: Record<string, string> = date === null ? {} : { date };
    return new Response(JSON.stringify(r), { status: 200, headers });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MultiTimeframeAlignmentCard symbol="EURUSD" />
    </QueryClientProvider>,
  );
}

describe("MultiTimeframeAlignmentCard data freshness", () => {
  it("a DATA_NOT_CURRENT report has a styled label and no current score or bias", async () => {
    renderWith(report({}));
    const block = await screen.findByTestId("mtf-not-current");
    const badge = screen.getByTestId("mtf-label");
    expect(badge.textContent).toBe("DATA NOT CURRENT");
    expect(badge.className).not.toMatch(/undefined/);
    expect(badge.className).toMatch(/bg-/);
    expect(block.textContent).toMatch(/Alignment not current/);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Alignment\s*82\/100/);
    expect(text).not.toMatch(/Best bias/);
    expect(text).not.toMatch(/Suggested bias/);
    expect(text).not.toMatch(/is in uptrend/);
    expect(text).toContain(WARNING);
    // The candles were plentiful (120 per timeframe): not a not-enough-data report.
    expect(screen.queryByTestId("mtf-insufficient")).toBeNull();
    expect(text).not.toMatch(/NOT ENOUGH DATA|Not enough candles|Alignment not measured/);
  });

  it("each timeframe tile names its newest bar time and whether it is current", async () => {
    atTime("2026-10-25T10:00:00.000Z");
    renderWith(report({
      lowerTrend: snap("UP", "2026-10-25T09:55:00.000Z", "CURRENT"),
      higherTrend: snap("UP", null, "UNKNOWN"),
    }));
    const times = await screen.findAllByTestId("mtf-bar-time");
    expect(times.map((e) => e.textContent)).toEqual([
      "newest bar Sun 2026-10-25 09:55 UTC · current when scanned",
      "newest bar Sat 2026-10-24 20:00 UTC · stale",
      "bars carried no time · age not checked",
    ]);
  });

  it("a measured report's tiles also say when their newest bar opened", async () => {
    atTime("2026-10-28T10:00:00.000Z");
    const fresh = (t: string) => snap("UP", t, "CURRENT");
    renderWith(report({
      lowerTrend: fresh("2026-10-28T09:55:00.000Z"),
      middleTrend: fresh("2026-10-28T09:00:00.000Z"),
      higherTrend: fresh("2026-10-28T08:00:00.000Z"),
      alignmentScore: 82, alignmentLabel: "STRONG_BULLISH_ALIGNMENT", conflictWarning: null, bestBias: "BUY",
    }));
    const times = await screen.findAllByTestId("mtf-bar-time");
    expect(times.map((e) => e.textContent)).toEqual([
      "newest bar Wed 2026-10-28 09:55 UTC · current when scanned",
      "newest bar Wed 2026-10-28 09:00 UTC · current when scanned",
      "newest bar Wed 2026-10-28 08:00 UTC · current when scanned",
    ]);
    // Still current now, so the alignment and bias are shown.
    expect(document.body.textContent).toMatch(/Alignment\s*82\/100/);
    expect(screen.queryByTestId("mtf-not-current")).toBeNull();
    expect(screen.queryByTestId("mtf-legacy-freshness")).toBeNull();
  });

  it("the client downgrades a report whose label is current but a timeframe is stale", async () => {
    renderWith(report({
      middleTrend: snap("UP", "2026-10-24T20:00:00.000Z", "STALE"),
      lowerTrend: snap("UP", "2026-10-28T09:55:00.000Z", "CURRENT"),
      higherTrend: snap("UP", "2026-10-28T08:00:00.000Z", "CURRENT"),
      alignmentLabel: "STRONG_BULLISH_ALIGNMENT", conflictWarning: null, bestBias: "BUY",
    }));
    await screen.findByTestId("mtf-not-current");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Best bias/);
    expect(text).not.toMatch(/Alignment\s*82\/100/);
    expect(text).toMatch(/H1 newest bar is not current/);
    expect(screen.queryByTestId("mtf-insufficient")).toBeNull();
    expect(text).not.toMatch(/NOT ENOUGH DATA|Not enough candles|Alignment not measured/);
  });

  it("a not-current report with a timeframe short of candles shows the not-enough-data block", async () => {
    const short = { ...snap("SIDEWAYS", "2026-10-24T20:00:00.000Z", "STALE"), candlesUsed: 4 };
    renderWith(report({ higherTrend: short }));
    const block = await screen.findByTestId("mtf-insufficient");
    expect(block.textContent).toMatch(/NOT ENOUGH DATA/);
    expect(document.body.textContent).toMatch(/Not enough candles were received for H4 \(4\)/);
  });

  it("in the not-enough-data block, trends from stale bars are not shown as plain current reads", async () => {
    // H4 is short of candles; M5 and H1 were read from 120 candles each, but
    // their newest bars (Saturday) were stale when the report was generated.
    const short = { ...snap("SIDEWAYS", "2026-10-24T20:00:00.000Z", "STALE"), candlesUsed: 4 };
    renderWith(report({ higherTrend: short }));
    const block = await screen.findByTestId("mtf-insufficient");
    expect(block.textContent).toMatch(/NOT ENOUGH DATA/);
    const tiles = screen.getAllByTestId("mtf-tile");
    for (const tile of tiles.slice(0, 2)) {
      expect(tile.textContent).toMatch(/UP on these bars/);
      expect(tile.querySelector(".text-green-400")).toBeNull();
      expect(within(tile).getByTestId("mtf-bar-time").textContent).toMatch(/· stale$/);
    }
    expect(tiles[2]!.textContent).toMatch(/No read/);
    const note = screen.getByTestId("mtf-insufficient-reason").textContent ?? "";
    // Two trends are shown, so the note does not say "no trend ... is shown".
    expect(note).not.toMatch(/no trend, alignment or bias is shown/);
    expect(note).toMatch(/Not enough candles were received for H4 \(4\) when this report was generated, so no trend is shown for it, and no alignment or bias is shown\./);
    expect(note).toMatch(/M5 newest bar is not current \(newest bar Sat 2026-10-24 20:55 UTC · stale\)/);
    expect(note).toMatch(/H1 newest bar is not current/);
  });

  it("a report scanned days ago is not shown as a current alignment or bias", async () => {
    // Generated Monday with every timeframe current; opened on Saturday.
    atTime("2026-10-31T10:00:00.000Z");
    const fresh = (t: string) => snap("UP", t, "CURRENT");
    renderWith(report({
      lowerTrend: fresh("2026-10-26T09:55:00.000Z"),
      middleTrend: fresh("2026-10-26T09:00:00.000Z"),
      higherTrend: fresh("2026-10-26T08:00:00.000Z"),
      alignmentScore: 82, alignmentLabel: "STRONG_BULLISH_ALIGNMENT", conflictWarning: null, bestBias: "BUY",
      createdAt: "2026-10-26T10:00:00.000Z",
    }));
    await screen.findByTestId("mtf-not-current");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Best bias/);
    expect(text).not.toMatch(/Alignment\s*82\/100/);
    expect(screen.queryByTestId("mtf-insufficient")).toBeNull();
    const times = screen.getAllByTestId("mtf-bar-time").map((e) => e.textContent);
    expect(times[0]).toBe("newest bar Mon 2026-10-26 09:55 UTC · current when scanned, not current now");
    for (const t of times) expect(t).not.toMatch(/· current$/);
    const reason = screen.getByTestId("mtf-not-current-reason").textContent ?? "";
    expect(reason).toMatch(/This scan is from Mon 2026-10-26 10:00 UTC/);
    expect(reason).toMatch(/M5 newest bar is no longer current/);
    expect(reason).toMatch(/Run the scan again for a current read/);
  });

  // The newest bar time and the freshness verdict are on the server's clock.
  // The re-check measures the time since the scan on that clock too (the
  // response's Date header plus the time since it arrived), never this
  // browser's clock, which can be minutes off: an M5 bar is current for only
  // 10 minutes.
  describe("the re-check uses the server's clock, not this browser's", () => {
    const fresh = (t: string) => snap("UP", t, "CURRENT");
    const scannedAt10 = () => report({
      lowerTrend: fresh("2026-10-28T09:55:00.000Z"),
      middleTrend: fresh("2026-10-28T09:00:00.000Z"),
      higherTrend: fresh("2026-10-28T08:00:00.000Z"),
      alignmentScore: 82, alignmentLabel: "STRONG_BULLISH_ALIGNMENT", conflictWarning: null, bestBias: "BUY",
      createdAt: "2026-10-28T10:00:00.000Z",
    });

    it("a browser clock 6 minutes fast does not flag a fresh scan as no longer current", async () => {
      atTime("2026-10-28T10:06:00.000Z");
      renderWith(scannedAt10(), new Date("2026-10-28T10:00:00.000Z").toUTCString());
      await screen.findAllByTestId("mtf-bar-time");
      expect(screen.queryByTestId("mtf-not-current")).toBeNull();
      expect(document.body.textContent).toMatch(/Alignment\s*82\/100/);
      expect(document.body.textContent).not.toMatch(/not current now|no longer current/);
    });

    it("a browser clock 20 minutes slow does not flag a fresh scan as no longer current", async () => {
      atTime("2026-10-28T09:40:00.000Z");
      renderWith(scannedAt10(), new Date("2026-10-28T10:00:00.000Z").toUTCString());
      await screen.findAllByTestId("mtf-bar-time");
      expect(screen.queryByTestId("mtf-not-current")).toBeNull();
      expect(document.body.textContent).toMatch(/Alignment\s*82\/100/);
    });

    it("a slow browser clock does not keep an aged report showing its score and bias", async () => {
      // Server clock 10:30: the M5 bar from 09:55 is 35 minutes old.
      atTime("2026-10-28T10:00:00.000Z");
      renderWith(scannedAt10(), new Date("2026-10-28T10:30:00.000Z").toUTCString());
      await screen.findByTestId("mtf-not-current");
      expect(document.body.textContent).not.toMatch(/Best bias/);
      expect(screen.getByTestId("mtf-not-current-reason").textContent).toMatch(/M5 newest bar is no longer current/);
    });

    it("with no server time, the age is reported as not re-checked, not as 'not current now', and no score or bias is shown", async () => {
      atTime("2026-10-28T10:01:00.000Z");
      renderWith(scannedAt10(), null);
      const block = await screen.findByTestId("mtf-not-current");
      const text = document.body.textContent ?? "";
      expect(text).not.toMatch(/Best bias/);
      expect(text).not.toMatch(/Alignment\s*82\/100/);
      expect(text).not.toMatch(/not current now|no longer current|DATA NOT CURRENT/);
      expect(block.textContent).toMatch(/NOT RE-CHECKED/);
      const times = screen.getAllByTestId("mtf-bar-time").map((e) => e.textContent);
      expect(times[0]).toBe("newest bar Wed 2026-10-28 09:55 UTC · current when scanned, not re-checked now");
      expect(screen.getByTestId("mtf-not-current-reason").textContent)
        .toMatch(/No server time came with this report, and this device's clock is not used to judge its age/);
    });
  });

  // Reports stored before bar times were recorded carry no freshness. Their
  // newest bar opened no later than the scan (createdAt), so the report's own
  // age on the server's clock is a lower bound on the bar's age.
  describe("a report stored before bar times were recorded", () => {
    const legacy = (createdAt: string) => report({
      lowerTrend: snap("UP", undefined, undefined),
      middleTrend: snap("UP", undefined, undefined),
      higherTrend: snap("UP", undefined, undefined),
      alignmentScore: 82, alignmentLabel: "STRONG_BULLISH_ALIGNMENT", conflictWarning: null, bestBias: "BUY",
      createdAt,
    });

    it("one scanned days ago shows no alignment score or best bias", async () => {
      // Generated Monday, opened Saturday.
      atTime("2026-10-31T10:00:00.000Z");
      renderWith(legacy("2026-10-26T10:00:00.000Z"));
      await screen.findByTestId("mtf-not-current");
      const text = document.body.textContent ?? "";
      expect(text).not.toMatch(/Best bias/);
      expect(text).not.toMatch(/Alignment\s*82\/100/);
      expect(text).not.toMatch(/STRONG BULLISH ALIGNMENT/);
      expect(screen.getByTestId("mtf-label").textContent).toBe("DATA NOT CURRENT");
      const reason = screen.getByTestId("mtf-not-current-reason").textContent ?? "";
      expect(reason).toMatch(/This scan is from Mon 2026-10-26 10:00 UTC/);
      expect(reason).toMatch(/M5, H1, H4 bar times were not recorded, and this report is older than two H4 bars/);
      expect(reason).toMatch(/Run the scan again for a current read/);
      expect(screen.getByTestId("mtf-legacy-freshness").textContent).toMatch(/stored before bar times were recorded/);
      expect(screen.getAllByTestId("mtf-bar-time").map((e) => e.textContent)).toEqual([
        "bar time not recorded", "bar time not recorded", "bar time not recorded",
      ]);
    });

    it("one scanned 30 minutes ago names only the timeframes it is provably old for", async () => {
      atTime("2026-10-26T10:30:00.000Z");
      renderWith(legacy("2026-10-26T10:00:00.000Z"));
      await screen.findByTestId("mtf-not-current");
      expect(document.body.textContent).not.toMatch(/Best bias/);
      expect(screen.getByTestId("mtf-not-current-reason").textContent)
        .toMatch(/Not a current read: M5 bar times were not recorded, and this report is older than two M5 bars\./);
    });

    it("one scanned minutes ago keeps its score, with the not-checked note", async () => {
      atTime("2026-10-26T10:03:00.000Z");
      renderWith(legacy("2026-10-26T10:00:00.000Z"));
      await screen.findByTestId("mtf-legacy-freshness");
      expect(screen.queryByTestId("mtf-not-current")).toBeNull();
      expect(document.body.textContent).toMatch(/Alignment\s*82\/100/);
    });

    it("with no server time, it is not shown as a current alignment", async () => {
      atTime("2026-10-26T10:03:00.000Z");
      renderWith(legacy("2026-10-26T10:00:00.000Z"), null);
      await screen.findByTestId("mtf-not-current");
      const text = document.body.textContent ?? "";
      expect(text).not.toMatch(/Best bias/);
      expect(text).not.toMatch(/Alignment\s*82\/100/);
      expect(screen.getByTestId("mtf-label").textContent).toBe("NOT RE-CHECKED");
      expect(screen.getByTestId("mtf-not-current-reason").textContent)
        .toMatch(/No server time came with this report, and this device's clock is not used to judge its age/);
    });
  });

  it("an older report without bar times says their age was not recorded", async () => {
    renderWith(report({
      lowerTrend: snap("UP", undefined, undefined),
      middleTrend: snap("UP", undefined, undefined),
      higherTrend: snap("UP", undefined, undefined),
      alignmentLabel: "STRONG_BULLISH_ALIGNMENT", conflictWarning: null, bestBias: "BUY",
    }));
    const note = await screen.findByTestId("mtf-legacy-freshness");
    expect(note.textContent).toMatch(/stored before bar times were recorded/);
    const times = screen.getAllByTestId("mtf-bar-time");
    expect(times.map((e) => e.textContent)).toEqual([
      "bar time not recorded", "bar time not recorded", "bar time not recorded",
    ]);
  });
});
