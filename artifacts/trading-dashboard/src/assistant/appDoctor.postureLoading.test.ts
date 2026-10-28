/**
 * App Doctor: while the first /api/mt5/diagnostic-summary read is still in
 * flight nothing has failed. The status report must not say the posture
 * "could not be read" (diagnose() already waits for bridgeStatus
 * "unavailable" before it emits doc-posture-unknown).
 */
import { describe, it, expect } from "vitest";
import { collectRuntimeContext } from "./runtimeContext";
import { diagnose, explainAppStatus } from "./appDoctor";

describe("explainAppStatus while the posture read is loading", () => {
  it("says the posture is still loading, not that it could not be read", () => {
    const ctx = collectRuntimeContext({ route: "/", bridge: null, bridgeStatus: "loading" });
    expect(diagnose(ctx).some((d) => d.id === "doc-posture-unknown")).toBe(false);
    const why = explainAppStatus(ctx).whyLiveUnavailable;
    expect(why).not.toMatch(/could not be read/i);
    expect(why).toMatch(/still loading/i);
  });

  it("still says it could not be read once the read has failed", () => {
    const ctx = collectRuntimeContext({ route: "/", bridge: null, bridgeStatus: "unavailable" });
    expect(diagnose(ctx).some((d) => d.id === "doc-posture-unknown")).toBe(true);
    expect(explainAppStatus(ctx).whyLiveUnavailable).toMatch(/could not be read/i);
  });
});
