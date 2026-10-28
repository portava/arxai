import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { hasMatchingOverlayEvidence, useDerivedOverlayContext } from "./useDerivedOverlayContext";

afterEach(cleanup);
describe("derived overlay source changes", () => {
  it("remembers source identity across cached symbol/timeframe visits and keeps post-switch geometry capped", () => {
    const { result, rerender } = renderHook(({ scope, identity }) => useDerivedOverlayContext(scope, identity), {
      initialProps: { scope: "V75/M15", identity: "mt5/account-A" as string | null },
    });
    expect(result.current).toBe(false); // Legacy initial evidence remains unverified, unchanged.
    rerender({ scope: "EURUSD/M15", identity: "mt5/account-A" });
    rerender({ scope: "V75/H1", identity: "mt5/account-B" });
    expect(result.current).toBe(false);
    rerender({ scope: "V75/M15", identity: "mt5/account-A" });
    expect(result.current).toBe(false);
    rerender({ scope: "V75/M15", identity: null });
    rerender({ scope: "V75/M15", identity: "deriv_public/public" });
    expect(result.current).toBe(true);
    rerender({ scope: "V75/M15", identity: "deriv_public/public" });
    expect(result.current).toBe(true);
    rerender({ scope: "V75/M15", identity: "mt5/account-A" });
    expect(result.current).toBe(true); // A cached original response is not newly attested.
  });
  it("treats same-provider opaque account changes as a change", () => {
    const { result, rerender } = renderHook(({ identity }) => useDerivedOverlayContext("V75/M15", identity), {
      initialProps: { identity: "mt5/account-A" },
    });
    rerender({ identity: "mt5/account-B" });
    expect(result.current).toBe(true);
  });
  const expected = { symbol: "V75", timeframe: "M15", source: "mt5_broker", sourceIdentity: "account-A", lastClosedCandleAt: null };
  it("accepts an actual matching response attestation", () => {
    expect(hasMatchingOverlayEvidence(expected, { marketEvidence: expected })).toBe(true);
  });
  it.each([null, {}, { sourceIdentity: "account-A" }, { marketEvidence: { ...expected, symbol: "V25" } },
    { marketEvidence: { ...expected, timeframe: "H1" } }, { marketEvidence: { ...expected, source: "deriv_public" } },
    { marketEvidence: { ...expected, sourceIdentity: "account-B" } }])("refuses absent or different evidence even after a new request: %s", response => {
    expect(hasMatchingOverlayEvidence(expected, response)).toBe(false);
  });
});
