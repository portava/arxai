// Regression test — providerInfo() (Task #331's provider-aware feed chip) maps a
// backend feed `source` id to an honest label + trust tier + trustNote. This is
// a trust/honesty surface: the chip must never mislabel WHERE the bars came from
// (e.g. dress a third-party fallback up as your broker, or a synthetic feed as
// real broker bars). These assertions call the real function and inspect its
// output — behavioural, not a source-scan, so a future refactor that silently
// breaks the mapping fails the build.

import { describe, it, expect } from "vitest";
import { providerInfo } from "./feed-confidence.js";

describe("providerInfo — provider label + trust tier mapping", () => {
  it("maps mt5_broker to the highest-trust broker tier", () => {
    const info = providerInfo("mt5_broker");
    expect(info.label).toBe("MT5 broker");
    expect(info.tier).toBe("broker");
    // trustNote must convey broker-primary / highest-trust honesty cues.
    expect(info.trustNote).toMatch(/broker/i);
    expect(info.trustNote).toMatch(/primary|highest-trust/i);
  });

  it("maps deriv to the synthetic tier (never broker)", () => {
    const info = providerInfo("deriv");
    expect(info.label).toBe("Deriv");
    expect(info.tier).toBe("synthetic");
    // trustNote must say it's synthetic and explicitly NOT broker bars.
    expect(info.trustNote).toMatch(/synthetic/i);
    expect(info.trustNote).toMatch(/not your broker|not.*broker/i);
  });

  it("maps a named assistant_real provider to its pretty name on the thirdParty tier", () => {
    const info = providerInfo("assistant_real:twelve_data");
    expect(info.label).toBe("TwelveData");
    expect(info.tier).toBe("thirdParty");
    // The named-provider note should mention the provider by name AND flag it
    // as a fallback that may be delayed / differ from the broker.
    expect(info.trustNote).toContain("TwelveData");
    expect(info.trustNote).toMatch(/fallback/i);
    expect(info.trustNote).toMatch(/delayed|differ/i);
  });

  it("collapses a multi-provider composite to the generic 'Third-party data' label", () => {
    const info = providerInfo(
      "assistant_real:composite(twelve_data,polygon,alpha_vantage)",
    );
    expect(info.label).toBe("Third-party data");
    expect(info.tier).toBe("thirdParty");
    // trustNote must flag it as a fallback that may be delayed / differ.
    expect(info.trustNote).toMatch(/third-party|fallback/i);
    expect(info.trustNote).toMatch(/delayed|differ/i);
  });

  it("resolves a single-provider composite to that provider's pretty name", () => {
    const info = providerInfo("assistant_real:composite(polygon)");
    expect(info.label).toBe("Polygon");
    expect(info.tier).toBe("thirdParty");
  });

  it("returns the explicit 'No feed' / none state for null and undefined", () => {
    for (const empty of [null, undefined] as const) {
      const info = providerInfo(empty);
      expect(info.label).toBe("No feed");
      expect(info.tier).toBe("none");
      // trustNote must say no source is serving — never imply a live feed.
      expect(info.trustNote).toMatch(/no .*source|not .*serving/i);
    }
  });

  it("surfaces an unknown source verbatim and degrades it to fallback-grade trust", () => {
    const info = providerInfo("some_new_provider");
    expect(info.label).toBe("some_new_provider");
    expect(info.tier).toBe("thirdParty");
    expect(info.trustNote.trim().length).toBeGreaterThan(0);
  });

  it("never labels a non-broker source as the broker tier (honesty floor)", () => {
    const nonBroker = [
      "deriv",
      "assistant_real:twelve_data",
      "assistant_real:composite(twelve_data,polygon)",
      "some_new_provider",
      null,
    ];
    for (const source of nonBroker) {
      expect(providerInfo(source).tier).not.toBe("broker");
    }
  });
});
