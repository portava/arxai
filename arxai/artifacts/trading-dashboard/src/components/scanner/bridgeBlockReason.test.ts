import { describe, expect, it } from "vitest";
import { EA_MIN_DEMO_VERSION } from "@workspace/domain/safety-contracts/executionMode";
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

describe("bridgeBlockReason — EA minimum and unevaluated gate", () => {
  it("quotes the dispatch gate's EA minimum (EA_MIN_DEMO_VERSION), not a hardcoded one", () => {
    const r = bridgeBlockReason({
      ...base, heartbeatFreshStrict: true, eaVersionAtLeast: false, eaVersionReported: "1.25",
      bridgeBlockers: [], gateBlockers: [],
    }, false)!;
    expect(r).toContain(`below the required ${EA_MIN_DEMO_VERSION}`);
    expect(r).not.toContain("1.27");
  });

  it("does not narrate unmeasured gate defaults as a stale heartbeat or an old EA", () => {
    const r = bridgeBlockReason({
      ...base, heartbeatAgeSeconds: 3, eaVersionReported: "1.26",
      gateEvaluated: false, bridgeReady: null, heartbeatFreshStrict: null, eaVersionAtLeast: null,
      bridgeBlockers: [], gateBlockers: [],
    }, false)!;
    expect(r).not.toMatch(/stale/i);
    expect(r).not.toMatch(/below the required/);
    expect(r).toMatch(/could not be evaluated/);
  });
});
