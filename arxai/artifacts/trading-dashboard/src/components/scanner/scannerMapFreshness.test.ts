import { describe, it, expect } from "vitest";
import { isScannerMapFresh, canUseScannerOpportunity, nextScannerMapFreshnessChange } from "./scannerMapFreshness";

describe("scanner map freshness", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  it("expires at the bounded snapshot age and tolerates only small clock skew", () => {
    expect(isScannerMapFresh(new Date(now - 30_000).toISOString(), now)).toBe(true);
    expect(isScannerMapFresh(new Date(now - 30_001).toISOString(), now)).toBe(false);
    expect(isScannerMapFresh(new Date(now + 5_000).toISOString(), now)).toBe(true);
    expect(isScannerMapFresh(new Date(now + 5_001).toISOString(), now)).toBe(false);
  });
  it("fails closed on missing or invalid clocks", () => {
    for (const stamp of [undefined, null, "", "not a date"]) expect(isScannerMapFresh(stamp, now)).toBe(false);
    expect(isScannerMapFresh(new Date(now).toISOString(), NaN)).toBe(false);
  });
});


it("requires the selected opportunity and its containing scan to be fresh and tradeable", () => {
  const now = Date.now();
  const row = { generatedAt: new Date(now).toISOString(), scanGeneratedAt: new Date(now).toISOString(), dataStatus: "live", tradeable: true };
  expect(canUseScannerOpportunity(row, now)).toBe(true);
  expect(canUseScannerOpportunity({ ...row, scanGeneratedAt: undefined }, now)).toBe(false);
  expect(canUseScannerOpportunity({ ...row, tradeable: false }, now)).toBe(false);
  expect(canUseScannerOpportunity({ ...row, dataStatus: "delayed" }, now)).toBe(false);
  expect(canUseScannerOpportunity({ ...row, generatedAt: undefined }, now)).toBe(false);
  expect(canUseScannerOpportunity({ ...row, scanGeneratedAt: new Date(now - 31_000).toISOString() }, now)).toBe(false);
});

describe("next freshness change", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  it("fires exactly when the fresh verdict flips", () => {
    const stamp = new Date(now - 10_000).toISOString();
    const next = nextScannerMapFreshnessChange(stamp, now)!;
    expect(next).toBe(now + 20_001);
    expect(isScannerMapFresh(stamp, next - 1)).toBe(true);
    expect(isScannerMapFresh(stamp, next)).toBe(false);
  });
  it("waits for a stamp ahead of the clock to enter the skew allowance, then expires it", () => {
    const stamp = new Date(now + 60_000).toISOString();
    const becomesFresh = nextScannerMapFreshnessChange(stamp, now)!;
    expect(becomesFresh).toBe(now + 55_000);
    expect(isScannerMapFresh(stamp, becomesFresh - 1)).toBe(false);
    expect(isScannerMapFresh(stamp, becomesFresh)).toBe(true);
    expect(nextScannerMapFreshnessChange(stamp, becomesFresh)).toBe(now + 90_001);
  });
  it("has nothing to schedule for expired, missing or invalid stamps", () => {
    expect(nextScannerMapFreshnessChange(new Date(now - 30_001).toISOString(), now)).toBeNull();
    for (const stamp of [undefined, null, "", "not a date"]) expect(nextScannerMapFreshnessChange(stamp, now)).toBeNull();
    expect(nextScannerMapFreshnessChange(new Date(now).toISOString(), NaN)).toBeNull();
  });
});
