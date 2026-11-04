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

// bridgeMode "unknown": /api/mt5/diagnostic-summary could not read the EA
// connection. runtimeContext keeps mt5Deferred (fail-closed), but the blocker
// card said "MT5 Deferred" / "MT5 bridge is intentionally deferred", a state
// nobody observed.
describe("MT5 deferred card", () => {
  it("an EA connection that could not be read is named unknown, not intentionally deferred", () => {
    const ctx = collectRuntimeContext({
      route: "/status-command-center",
      bridge: { ...disconnected, bridgeMode: "unknown", lastHeartbeatAt: null, heartbeatAgeSeconds: null },
      bridgeStatus: "loaded",
    });
    expect(ctx.mt5Deferred).toBe(true); // still fail-closed
    const card = buildBlockerCards(ctx, []).find((c) => c.kind === "mt5-deferred")!;
    expect(card).toBeTruthy();
    expect(card.title).not.toMatch(/MT5 deferred/i);
    expect(card.title).toMatch(/unknown/i);
    expect(card.why).not.toMatch(/intentionally/i);
    expect(card.why).toMatch(/could not be read/);
    expect(card.why).toMatch(/treated as deferred for safety/);
    expect(card.doNotDo).toMatch(/connected/);
  });

  it("a bridge the server read as deferred keeps the deferred card, without 'unknown bridge state'", () => {
    const ctx = collectRuntimeContext({
      route: "/status-command-center",
      bridge: { ...disconnected, bridgeMode: "deferred" },
      bridgeStatus: "loaded",
    });
    const card = buildBlockerCards(ctx, []).find((c) => c.kind === "mt5-deferred")!;
    expect(card.title).toBe("MT5 Deferred");
    expect(card.why).not.toMatch(/unknown/i);
    expect(card.why).toMatch(/no MT5 bridge token is active/i);
  });
});
