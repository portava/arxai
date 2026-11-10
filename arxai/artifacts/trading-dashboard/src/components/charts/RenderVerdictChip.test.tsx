// The chart's render self-check chip: only a measured 100 reads as verified;
// a measured FAIL shows the server's reason; anything else is "not verified".
import { describe, it, expect } from "vitest";
import { renderVerdictCopy } from "./RenderVerdictChip";

const NOW = 1_000_000;
const report = { receivedAt: NOW - 12_000, barsCompared: 300, displayMode: "ohlc" };

describe("renderVerdictCopy", () => {
  it("a measured 100 reads 'Render verified · N bars · Xs ago'", () => {
    const c = renderVerdictCopy({ status: "measured", score: 100, detail: "Renderer measured: …", report }, NOW);
    expect(c).toMatchObject({ tone: "verified", text: "Render verified · 300 bars · 12s ago" });
  });

  it("a Heikin Ashi pass is labelled as averaged, not tradable prices", () => {
    const c = renderVerdictCopy({ status: "measured", score: 100, detail: "ok", report: { ...report, displayMode: "heikinAshi" } }, NOW);
    expect(c.text).toContain("Heikin Ashi (averaged, not tradable prices)");
  });

  it("a measured FAIL shows the reason, never 'verified'", () => {
    const c = renderVerdictCopy({ status: "measured", score: 0, detail: "Renderer mismatch: 1 drawn bar(s) differ from the source.", report }, NOW);
    expect(c.tone).toBe("failed");
    expect(c.text).toBe("Render check failed · 12s ago: 1 drawn bar(s) differ from the source.");
  });

  it("absent / unbound / unavailable / no verdict are not verified", () => {
    for (const status of ["absent", "unbound", "unavailable"] as const) {
      const c = renderVerdictCopy({ status, detail: "why", report: null }, NOW);
      expect(c.tone).toBe("unverified");
      expect(c.text).toBe("Render not verified: why");
    }
    expect(renderVerdictCopy(null, NOW).tone).toBe("unverified");
  });
});
