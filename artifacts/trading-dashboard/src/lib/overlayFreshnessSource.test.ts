// Smart-layers overlay handshake: the "freshness" check measured how long ago
// the server rebuilt the read (rebuilt on every 45 s refetch), not how old the
// candles under the overlays are. Over a stale feed it always read PASS
// "Overlays are fresh." and the badge could say "verified". The chart panel now
// passes whether the source candles are live; an unreported fact is unknown.
import { describe, it, expect } from "vitest";
import { buildOverlayHandshake } from "@workspace/domain/smart-chart";
import { overlayBadgeLabel, unavailableOverlayChecks } from "./scannerResilience";

const base = {
  chartLoaded: true, chartSymbol: "EURUSD", signalSymbol: "EURUSD", signalExists: true,
  hasSufficientData: true, levelCount: 3, newsMapped: true, overlayAgeMs: 1_000,
};
const freshness = (h: ReturnType<typeof buildOverlayHandshake>) => h.checks.find((c) => c.key === "freshness")!;

describe("overlay handshake freshness judges the candles, not only the rebuild time", () => {
  it("a rebuild 1 s ago from candles that are not live is a WARN, never 'fresh' or 'verified'", () => {
    const h = buildOverlayHandshake({ ...base, sourceDataLive: false, sourceDataNote: "the signal's candles are delayed" });
    expect(freshness(h).status).toBe("WARN");
    expect(freshness(h).detail).not.toBe("Overlays are fresh.");
    expect(freshness(h).detail).toContain("the signal's candles are delayed");
    expect(overlayBadgeLabel(h.overallStatus, false, true, unavailableOverlayChecks(h.checks).length > 0)).not.toBe("verified");
  });

  it("source liveness not reported: the check is unknown, so the badge is only partially checked", () => {
    const h = buildOverlayHandshake({ ...base, sourceDataLive: null });
    expect(freshness(h).status).toBe("NOT_AVAILABLE");
    const unchecked = unavailableOverlayChecks(h.checks);
    expect(unchecked.map((c) => c.key)).toContain("freshness");
    expect(overlayBadgeLabel(h.overallStatus, false, true, unchecked.length > 0)).not.toBe("verified");
  });

  it("live candles rebuilt within 90 s pass and say so", () => {
    const h = buildOverlayHandshake({ ...base, sourceDataLive: true });
    expect(freshness(h).status).toBe("PASS");
    expect(freshness(h).detail).toContain("live candles");
  });

  it("an old rebuild is still judged by its age even when the candles were live", () => {
    expect(freshness(buildOverlayHandshake({ ...base, overlayAgeMs: 10 * 60_000, sourceDataLive: true })).status).toBe("FAIL");
  });
});
