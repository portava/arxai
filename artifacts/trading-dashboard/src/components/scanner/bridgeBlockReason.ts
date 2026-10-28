// Plain-English reason the demo bridge is not dispatch-ready, built from
// GET /api/me/demo-bridge-debug. Each blocker is pointed at the place it is
// actually fixed: arming is MT5 Setup → Demo Execution Control; heartbeat,
// account type, EA version and EA inputs are on the MT5 side.
//
// USER_NOT_CONFIRMED is dropped: the debug endpoint probes the gate without
// an order to confirm, so older servers always include it. WRONG_EXECUTION_MODE
// (older servers) and DEMO_EXECUTION_NOT_ARMED both mean "not armed".

export type BridgeBlockInput = {
  connectionId: number | null;
  heartbeatAgeSeconds: number | null;
  accountType: string | null;
  eaVersionReported: string | null;
  heartbeatFreshStrict?: boolean;
  eaVersionAtLeast?: boolean;
  bridgeBlockers?: string[];
  gateBlockers?: string[];
  armed?: boolean | null;
  eaInputs: { readOnlyMode: boolean | null; enableDemoExecution: boolean | null };
};

const PROBE_ONLY = new Set(["USER_NOT_CONFIRMED"]);
const NOT_ARMED = new Set(["DEMO_EXECUTION_NOT_ARMED", "WRONG_EXECUTION_MODE"]);
const ARMING_TEXT =
  "Demo execution is not armed for your account — arm it in MT5 Setup → Demo Execution Control (this is not an EA input).";

export function bridgeBlockReason(bridge: BridgeBlockInput | null, bridgeReady: boolean): string | null {
  if (bridgeReady) return null;
  if (!bridge || bridge.connectionId == null) return "No demo bridge connected. Open MT5 Setup and attach the ARX EA to a demo account.";
  const all = [...(bridge.bridgeBlockers ?? []), ...(bridge.gateBlockers ?? [])].filter((b) => !PROBE_ONLY.has(b));
  const notArmed = bridge.armed === false || all.some((b) => NOT_ARMED.has(b));
  const bridgeSide = Array.from(new Set(all.filter((b) => !NOT_ARMED.has(b))));
  if (bridgeSide.length > 0) {
    const head = `Bridge not dispatch-ready: ${bridgeSide.join(", ")}. Check the EA on your MT5 chart (MT5 → EA → Inputs, reattach if the heartbeat is stale).`;
    return notArmed ? `${head} ${ARMING_TEXT}` : head;
  }
  if (notArmed) return ARMING_TEXT;
  if (bridge.heartbeatFreshStrict === false) return `Bridge heartbeat stale (${bridge.heartbeatAgeSeconds ?? "?"}s ≥ 15s strict window). Reattach the EA on the MT5 chart.`;
  if (bridge.accountType !== "demo" && bridge.accountType !== "contest") return `Bridge account type is "${bridge.accountType ?? "unknown"}" — must be DEMO.`;
  if (bridge.eaVersionAtLeast === false) return `EA version "${bridge.eaVersionReported ?? "unknown"}" is below the required 1.27. Open MT5 Setup and refresh/attach the active EA.`;
  if (bridge.eaInputs.readOnlyMode === true) return "Selected bridge is read-only. In MT5 → EA → Inputs, set ReadOnlyMode=false.";
  if (bridge.eaInputs.enableDemoExecution === false) return "Selected bridge has EnableDemoExecution=false. In MT5 → EA → Inputs, set EnableDemoExecution=true.";
  return "Selected bridge is not dispatch-ready. Open MT5 Setup for details.";
}
