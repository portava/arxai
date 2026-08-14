// AI chart-tool command contract + preview overlay mapping (Task #374).
//
// The bounded command contract is the ONLY way AI/Ruby drawings reach the
// renderer. These tests lock its safety properties:
//   - the runtime guard rejects arbitrary / malformed objects (no free-form
//     scripting), and accepts only well-formed commands
//   - a drawable preview maps to entry/SL/TP lines + risk/reward zones + an
//     invalidation marker, every overlay carrying source:"preview" and the
//     "Preview / Not executed" badge (a drawing, never an order)
//   - a refusal preview (no levels) draws NO order overlays — only a warning
//   - lifecycle helpers (isExpired / deriveStatus / canUseSetup) behave honestly

import { describe, it, expect } from "vitest";
import {
  isValidAiChartCommand,
  setupPreviewToCommands,
  aiChartCommandsToOverlays,
} from "./ai-chart-commands";
import {
  isExpired,
  deriveStatus,
  hasDrawableLevels,
  canUseSetup,
  type SetupPreview,
} from "./setup-preview";

function mkPreview(over: Partial<SetupPreview> = {}): SetupPreview {
  const now = Date.parse("2026-01-01T12:00:00Z");
  return {
    previewId: "preview-abc",
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    timeframe: "M5",
    side: "BUY",
    setupType: "Trend continuation",
    levels: { entry: 1.1, sl: 1.09, tp: 1.12, secondaryTp: null, invalidation: 1.09 },
    rewardToRisk: 2,
    riskAmount: null,
    potentialReward: null,
    confidence: { label: "High", score: 0.85 },
    verdict: "tradeable",
    refusalReason: null,
    dataFreshness: { basis: "VERIFIED", trustLine: "Chart Truth 88." },
    providerSource: { assetClass: "forex", composite: false, label: "broker-routed quote" },
    bridgeStatus: null,
    allocationKnown: true,
    scannerScore: null,
    flameStage: null,
    runOnQuality: null,
    riskScore: null,
    governanceOutcome: null,
    explanation: ["A long idea near 1.1, stop 1.09, target 1.12."],
    invalidationNote: "Close under 1.09 breaks this idea.",
    createdBy: "ruby",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 90_000).toISOString(),
    status: "preview",
    ...over,
  };
}

describe("isValidAiChartCommand — bounded contract guard", () => {
  it("rejects non-objects and unknown types", () => {
    expect(isValidAiChartCommand(null)).toBe(false);
    expect(isValidAiChartCommand(42)).toBe(false);
    expect(isValidAiChartCommand("DRAW_ENTRY_SL_TP")).toBe(false);
    expect(isValidAiChartCommand({ type: "EXECUTE_TRADE" })).toBe(false);
    expect(isValidAiChartCommand({})).toBe(false);
  });

  it("rejects a DRAW_ENTRY_SL_TP with NaN / missing fields", () => {
    expect(
      isValidAiChartCommand({
        type: "DRAW_ENTRY_SL_TP",
        previewId: "p",
        symbol: "EURUSD",
        timeframe: "M5",
        side: "BUY",
        entry: Number.NaN,
        sl: 1.09,
        tp: 1.12,
        confidence: 0.8,
      }),
    ).toBe(false);
    expect(
      isValidAiChartCommand({
        type: "DRAW_ENTRY_SL_TP",
        previewId: "p",
        symbol: "EURUSD",
        timeframe: "M5",
        side: "SIDEWAYS",
        entry: 1.1,
        sl: 1.09,
        tp: 1.12,
        confidence: 0.8,
      }),
    ).toBe(false);
  });

  it("accepts a well-formed DRAW_ENTRY_SL_TP and CLEAR_PREVIEW", () => {
    expect(
      isValidAiChartCommand({
        type: "DRAW_ENTRY_SL_TP",
        previewId: "p",
        symbol: "EURUSD",
        timeframe: "M5",
        side: "BUY",
        entry: 1.1,
        sl: 1.09,
        tp: 1.12,
        confidence: 0.8,
      }),
    ).toBe(true);
    expect(isValidAiChartCommand({ type: "CLEAR_PREVIEW" })).toBe(true);
  });

  it("rejects a DRAW_ZONE with an invalid severity", () => {
    expect(
      isValidAiChartCommand({
        type: "DRAW_ZONE",
        previewId: "p",
        symbol: "EURUSD",
        timeframe: "M5",
        priceMin: 1.09,
        priceMax: 1.1,
        severity: "explosive",
        label: "Risk",
      }),
    ).toBe(false);
  });
});

describe("setupPreviewToCommands + aiChartCommandsToOverlays", () => {
  it("maps a drawable preview to entry/SL/TP lines + risk/reward zones + invalidation marker", () => {
    const preview = mkPreview();
    const cmds = setupPreviewToCommands(preview);
    expect(cmds.some((c) => c.type === "DRAW_ENTRY_SL_TP")).toBe(true);
    expect(cmds.some((c) => c.type === "DRAW_MARKER")).toBe(true);

    const overlays = aiChartCommandsToOverlays(cmds);
    const roles = overlays.map((o) => o.metadata?.role);
    expect(roles).toContain("entry");
    expect(roles).toContain("sl");
    expect(roles).toContain("tp");
    expect(roles).toContain("risk-zone");
    expect(roles).toContain("reward-zone");
    expect(roles).toContain("marker");

    // Every overlay is a preview, never an executed order.
    expect(overlays.every((o) => o.source === "preview")).toBe(true);
    expect(
      overlays.every((o) => o.metadata?.badge === "Preview / Not executed"),
    ).toBe(true);

    // The entry line carries the real entry price + side.
    const entry = overlays.find((o) => o.metadata?.role === "entry");
    expect(entry?.price).toBe(1.1);
    expect(entry?.metadata?.side).toBe("BUY");
  });

  it("draws a secondary target only when present", () => {
    const withTp2 = mkPreview({
      levels: { entry: 1.1, sl: 1.09, tp: 1.12, secondaryTp: 1.14, invalidation: 1.09 },
    });
    const overlays = aiChartCommandsToOverlays(setupPreviewToCommands(withTp2));
    expect(overlays.some((o) => o.metadata?.role === "tp2")).toBe(true);

    const noTp2 = aiChartCommandsToOverlays(setupPreviewToCommands(mkPreview()));
    expect(noTp2.some((o) => o.metadata?.role === "tp2")).toBe(false);
  });

  it("a refusal preview (no levels) draws NO order overlays — only a warning command", () => {
    const refused = mkPreview({
      side: null,
      levels: null,
      verdict: "refused",
      refusalReason: "The chart feed isn't confirmed yet.",
    });
    const cmds = setupPreviewToCommands(refused);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.type).toBe("DRAW_WARNING");
    // DRAW_WARNING is panel-level → emits no chart overlays.
    expect(aiChartCommandsToOverlays(cmds)).toHaveLength(0);
  });

  it("drops invalid commands defensively", () => {
    const overlays = aiChartCommandsToOverlays([
      { type: "EXECUTE_TRADE", symbol: "EURUSD" },
      null,
      { type: "DRAW_ENTRY_SL_TP", entry: Number.NaN },
    ]);
    expect(overlays).toHaveLength(0);
  });
});

describe("setup-preview lifecycle helpers", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");

  it("isExpired flips at the server expiry", () => {
    const p = mkPreview();
    expect(isExpired(p, now)).toBe(false);
    expect(isExpired(p, now + 91_000)).toBe(true);
  });

  it("deriveStatus keeps confirmed/discarded, ages un-acted to stale", () => {
    const p = mkPreview();
    expect(deriveStatus(p, "preview", now)).toBe("preview");
    expect(deriveStatus(p, "preview", now + 91_000)).toBe("stale");
    expect(deriveStatus(p, "user_confirmed", now + 91_000)).toBe("user_confirmed");
    expect(deriveStatus(p, "discarded", now + 91_000)).toBe("discarded");
  });

  it("hasDrawableLevels / canUseSetup gate honestly", () => {
    const good = mkPreview();
    expect(hasDrawableLevels(good)).toBe(true);
    expect(canUseSetup(good, "preview")).toBe(true);
    expect(canUseSetup(good, "stale")).toBe(false);
    expect(canUseSetup(good, "discarded")).toBe(false);

    const refused = mkPreview({ side: null, levels: null, verdict: "refused" });
    expect(hasDrawableLevels(refused)).toBe(false);
    expect(canUseSetup(refused, "preview")).toBe(false);
  });
});
