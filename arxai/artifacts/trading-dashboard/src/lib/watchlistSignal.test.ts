import { describe, expect, it } from "vitest";
import { watchlistSignalBadge } from "./watchlistSignal";

describe("watchlist signal badge", () => {
  it("shows a current scan with its bar time", () => {
    const b = watchlistSignalBadge({ signal: "BUY", confidence: 72, signalStatus: "OK", signalAsOf: "2026-10-27T14:05:00.000Z" });
    expect(b).toEqual({ kind: "signal", direction: "BUY", text: "BUY 72%", title: "Strategy scan of 1m bars up to 2026-10-27 14:05 UTC" });
  });
  it("no data is 'No data', never 'WAIT 0%'", () => {
    expect(watchlistSignalBadge({ signal: null, confidence: null, signalStatus: "NO_DATA" })?.text).toBe("No data");
  });
  it("stale bars are 'Stale data'", () => {
    expect(watchlistSignalBadge({ signal: null, signalStatus: "STALE_DATA", signalAsOf: "2026-10-25T21:59:00.000Z" })?.text).toBe("Stale data");
  });
  it("a signal without a status is downgraded, not shown", () => {
    expect(watchlistSignalBadge({ signal: "SELL", confidence: 80 })).toEqual(expect.objectContaining({ kind: "status", text: "Unverified" }));
  });
});
