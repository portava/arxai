/**
 * Status Command Center, "Bridge Disconnected" card. Its safe next step said
 * "ARX stays in simulator/demo mode meanwhile" whatever the account mode. The
 * card reads only /api/mt5/diagnostic-summary, whose bridgeMode is the
 * caller's own EA connection and which never reads the account mode: an armed
 * Live Shared trader trades through the shared master, not their own EA, so
 * the sentence was untrue for them and unverified for everyone. The step now
 * says what a disconnected EA stops and that the mode is read elsewhere.
 */
import { describe, it, expect } from "vitest";
import { collectRuntimeContext } from "@/assistant/runtimeContext";
import type { BridgeDiagnosticSummary } from "@/assistant/runtimeContextTypes";
import { buildBlockerCards } from "./blockerCards";

const disconnected: BridgeDiagnosticSummary = {
  bridgeMode: "disconnected",
  heartbeatPresent: false,
  heartbeatScope: "your_connection",
  lastHeartbeatAt: "2026-11-03T08:00:00.000Z",
  heartbeatAgeSeconds: 3600,
  brokerExecutionEnabled: false,
  brokerReadOnly: true,
  liveTradingEnabled: false,
  paperOnly: true,
  executionPostureMeasured: false,
  executionPostureNote: "Fixed values, not readings of the execution gates.",
  safestNextStep: "",
  reason: "",
  fetchedAt: "2026-11-03T09:00:00.000Z",
};

describe("Bridge Disconnected card", () => {
  it("does not claim ARX stays in simulator/demo mode; it says the mode is not read here", () => {
    const ctx = collectRuntimeContext({ route: "/status-command-center", bridge: disconnected, bridgeStatus: "loaded" });
    const card = buildBlockerCards(ctx, []).find((c) => c.kind === "bridge-disconnected");
    expect(card).toBeTruthy();
    expect(card!.safeNextStep).not.toMatch(/simulator\/demo mode/i);
    expect(card!.safeNextStep).toMatch(/Restore the EA/);
    expect(card!.safeNextStep).toMatch(/nothing is sent through this MT5 EA bridge/);
    expect(card!.safeNextStep).toMatch(/does not read your account mode/);
    expect(card!.safeNextStep).toMatch(/Live Shared account trades through the shared master/);
  });
});
