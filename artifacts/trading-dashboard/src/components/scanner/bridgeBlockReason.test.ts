import { describe, expect, it } from "vitest";
import { bridgeBlockReason, type BridgeBlockInput } from "./bridgeBlockReason";

const base: BridgeBlockInput = {
  connectionId: 41, heartbeatAgeSeconds: 20, accountType: "demo", eaVersionReported: "1.27",
  heartbeatFreshStrict: false, eaVersionAtLeast: true,
  eaInputs: { readOnlyMode: false, enableDemoExecution: true },
};

describe("bridgeBlockReason", () => {
  it("does not tell the user to fix probe artifacts or arming in EA inputs (old server payload)", () => {
    const r = bridgeBlockReason({
      ...base,
      bridgeBlockers: ["HEARTBEAT_STALE(20s)"],
      gateBlockers: ["USER_NOT_CONFIRMED", "NOT_VERIFIED_DEMO", "WRONG_EXECUTION_MODE"],
    }, false)!;
    expect(r).not.toContain("USER_NOT_CONFIRMED");
    expect(r).not.toContain("WRONG_EXECUTION_MODE");
    expect(r).toContain("HEARTBEAT_STALE(20s)");
    expect(r).toContain("Demo execution is not armed for your account — arm it in MT5 Setup → Demo Execution Control");
  });

  it("names arming, not EA inputs, when arming is the only blocker", () => {
    const r = bridgeBlockReason({ ...base, heartbeatFreshStrict: true, armed: false, gateBlockers: ["DEMO_EXECUTION_NOT_ARMED"] }, false)!;
    expect(r).toMatch(/not armed/);
    expect(r).not.toMatch(/EA → Inputs to fix/);
  });

  it("returns null when the server says the bridge is ready", () => {
    expect(bridgeBlockReason(base, true)).toBeNull();
  });
});
