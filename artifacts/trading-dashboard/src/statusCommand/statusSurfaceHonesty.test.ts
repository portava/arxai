// RANK 4 (review pass) — guard for the ARX Status surface.
//
// THE DEFECT THIS PINS
//   The help system (api-server onboarding/help.ts, whyBlocked.ts, routes/
//   help.ts) was rewritten so it stops asserting "ARX cannot place orders".
//   The SAME unconditional claims survived one layer over, in the three
//   builders that compose /status-command-center — a page in NORMAL_USER_EXACT
//   that every human trader can open:
//
//     setupWizard.ts     shortExplanation: "Broker is read-only by default.
//                        You can see balance/positions, but ARX cannot send
//                        orders."                          (constant string)
//     setupChecklist.ts  explanation: "Broker connection is read-only by
//                        default. Even if it shows account data, no order will
//                        be sent."                         (build: () => — no ctx)
//     setupChecklist.ts  explanation: "ARX is in demo mode — ... You can't lose
//                        real money in this mode."         (printed even when
//                        the item's own status computes to "incomplete")
//     readinessScore.ts  summary: "Bridge connected — broker remains read-only
//                        by default."                      (for ANY connected
//                        bridge, read-only or not)
//
//   In each case only the sibling status/statusText field was ctx-derived, so
//   the page could print "Broker is NOT read-only — investigate." directly
//   under a sentence swearing ARX cannot send orders.
//
// WHAT THIS ASSERTS
//   1. Given a ctx that says LIVE and NOT read-only, no builder emits a
//      sentence claiming execution is impossible.
//   2. Given a ctx that says read-only / demo, the protective wording IS
//      emitted — so the guard cannot be satisfied by deleting the copy, only
//      by making it conditional.
//   3. Every "Open <page>" instruction names a destination the item actually
//      links to, or names no page at all. (The rank-51 fix retargeted the
//      links to allowlisted routes but left the prose pointing at the old,
//      un-allowlisted pages, so the button and the sentence disagreed.)

import { describe, it, expect } from "vitest";
import type { RuntimeContext } from "@/assistant/runtimeContextTypes";
import type { AskContext } from "@/knowledge/answerEngine";
import { buildSetupWizard } from "./setupWizard";
import { buildBlockerCards } from "./blockerCards";
import { computeReadinessScore } from "./readinessScore";
import { buildSetupChecklist } from "@/knowledge/setupChecklist";
import { isNormalUserAllowedPath } from "@/lib/routeAccess";

function baseCtx(over: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    capturedAt: "2026-01-01T00:00:00.000Z",
    route: "/status-command-center",
    pageTitle: "ARX Status",
    viewport: "desktop",
    visibleElements: [],
    visibleBadges: [],
    activeSafetyLocks: [],
    disabledControls: [],
    selectedSymbol: null,
    tradingMode: "live",
    paperOnly: false,
    simulatorMode: false,
    liveTradingDisabled: false,
    brokerExecutionDisabled: false,
    brokerReadOnly: false,
    mt5Deferred: false,
    mt5BridgeConnected: true,
    heartbeatPresent: true,
    heartbeatAgeSeconds: 5,
    emergencyStopActive: false,
    readiness: "ready",
    serverRoleHint: "user",
    recentErrors: [],
    recentFailedEndpoints: [],
    recentNavigationFailures: [],
    recentAssistantQuestions: [],
    missingKnowledgeFallbacks: [],
    health: null,
    bridge: {
      bridgeMode: "connected",
      heartbeatPresent: true,
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
      heartbeatAgeSeconds: 5,
      brokerExecutionEnabled: true,
      brokerReadOnly: false,
      liveTradingEnabled: true,
      paperOnly: false,
      safestNextStep: "",
      reason: "",
      fetchedAt: "2026-01-01T00:00:00.000Z",
    },
    ...over,
  };
}

const LIVE_CTX = baseCtx();
const READONLY_CTX = baseCtx({
  tradingMode: "broker-readonly",
  brokerReadOnly: true,
  brokerExecutionDisabled: true,
  liveTradingDisabled: true,
  paperOnly: true,
  activeSafetyLocks: ["BROKER READ-ONLY", "LIVE TRADING DISABLED"],
  bridge: { ...baseCtx().bridge!, brokerReadOnly: true, brokerExecutionEnabled: false, liveTradingEnabled: false, paperOnly: true },
});

const askLive: AskContext = { route: "/status-command-center", tradingModeHint: "live", safetyStatuses: [] };
const askReadOnly: AskContext = {
  route: "/status-command-center",
  tradingModeHint: "broker-readonly",
  safetyStatuses: ["BROKER READ-ONLY", "PAPER ONLY"],
};

// Sentences that assert execution is impossible. Each must never appear when
// ctx says the account is live and not read-only.
const ABSOLUTE_DENIALS = [
  /ARX cannot send orders/i,
  /no order will be sent/i,
  /you can'?t lose real money/i,
  /cannot lose real money/i,
  /broker remains read-only by default/i,
  /nothing reaches a real broker/i,
  /without touching a real broker/i,
];

function wizardStrings(ctx: RuntimeContext): string[] {
  return buildSetupWizard(ctx).flatMap((s) => [s.shortExplanation, s.statusText, s.completionCondition]);
}

function checklistStrings(ctx: AskContext): string[] {
  return buildSetupChecklist(ctx).flatMap((i) => [i.explanation, i.safeNextAction, i.blockerReason ?? ""]);
}

function readinessStrings(ctx: RuntimeContext, ask: AskContext): string[] {
  return computeReadinessScore(ctx, buildSetupChecklist(ask)).sections.map((s) => s.summary);
}

function blockerStrings(ctx: RuntimeContext, ask: AskContext): string[] {
  return buildBlockerCards(ctx, buildSetupChecklist(ask)).flatMap((c) => [c.blocks, c.why, c.howToCheck, c.safeNextStep, c.doNotDo]);
}

describe("a live, execution-enabled account is never told ARX cannot trade", () => {
  const surfaces: [string, string[]][] = [
    ["setup wizard", wizardStrings(LIVE_CTX)],
    ["setup checklist", checklistStrings(askLive)],
    ["readiness score", readinessStrings(LIVE_CTX, askLive)],
    ["blocker cards", blockerStrings(LIVE_CTX, askLive)],
  ];

  for (const [name, strings] of surfaces) {
    it(`${name} emits no absolute denial of execution`, () => {
      const offenders = strings.filter((s) => ABSOLUTE_DENIALS.some((re) => re.test(s)));
      expect(
        offenders,
        `${name} told a LIVE, non-read-only account that ARX cannot trade. ` +
          "Derive the sentence from ctx, the way the sibling status field already is.",
      ).toEqual([]);
    });
  }
});

describe("the protective wording is still emitted when it is true", () => {
  it("a read-only account is told this connection is read-only right now", () => {
    const all = [
      ...wizardStrings(READONLY_CTX),
      ...checklistStrings(askReadOnly),
      ...readinessStrings(READONLY_CTX, askReadOnly),
    ].join("\n");
    expect(all).toMatch(/read-only right now/i);
  });

  it("a demo account is told no real money is at risk", () => {
    const demoAsk: AskContext = { route: "/", tradingModeHint: "paper", safetyStatuses: ["PAPER ONLY"] };
    expect(checklistStrings(demoAsk).join("\n")).toMatch(/no real money is at risk/i);
  });

  it("a live account is warned that execution is possible", () => {
    const all = [...wizardStrings(LIVE_CTX), ...checklistStrings(askLive), ...readinessStrings(LIVE_CTX, askLive)].join("\n");
    expect(all).toMatch(/NOT read-only/);
  });
});

describe("instruction prose names the page the item actually links to", () => {
  // The rank-51 fix retargeted every link to an allowlisted route but left the
  // prose naming /demo-trading, /readiness-checklist, /broker-readonly,
  // /replay-simulator, /mt5-bridge, /mt5-status, /system-health and
  // /feedback-center — none of which is on either human-trader allowlist.
  const DEAD_PAGE_NAMES = [
    "Demo Trading",
    "Readiness Checklist",
    "Broker Read-only",
    "Replay Simulator",
    "MT5 Bridge",
    "MT5 Status",
    "System Health",
    "Feedback Center",
    "Risk Governor and review",
    "Risk Governor and read",
    "Knowledge Console to confirm",
  ];

  const named = (s: string) => DEAD_PAGE_NAMES.filter((n) => s.includes(n));

  it("wizard steps name no unreachable destination", () => {
    const bad = buildSetupWizard(LIVE_CTX)
      .flatMap((s) => [s.shortExplanation, s.completionCondition])
      .flatMap((s) => named(s));
    expect(bad).toEqual([]);
  });

  it("checklist next-actions name no unreachable destination", () => {
    const bad = buildSetupChecklist(askLive).map((i) => i.safeNextAction).flatMap((s) => named(s));
    expect(bad).toEqual([]);
  });

  it("blocker cards' how-to-check names no unreachable destination", () => {
    const bad = buildBlockerCards(READONLY_CTX, buildSetupChecklist(askReadOnly))
      .map((c) => c.howToCheck)
      .flatMap((s) => named(s));
    expect(bad).toEqual([]);
  });

  it("every route a status surface links to is on the human-trader allowlist", () => {
    const routes = [
      ...buildSetupWizard(LIVE_CTX).map((s) => s.pageRoute),
      ...buildSetupChecklist(askLive).map((i) => i.related?.route),
      ...buildBlockerCards(READONLY_CTX, buildSetupChecklist(askReadOnly)).map((c) => c.relatedRoute?.route),
    ].filter((r): r is string => typeof r === "string" && r.length > 0);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((r) => !isNormalUserAllowedPath(r))).toEqual([]);
  });
});

describe("Emergency Stop is a real three-state read, never a fabricated 'off'", () => {
  // emergencyStopActive is now boolean | null: true = engaged, false =
  // confirmed off (read from /api/system/status), null = the read failed.
  it("an unreadable Emergency Stop is reported as unknown, never as off", () => {
    const unknownCtx = baseCtx({ emergencyStopActive: null });
    const wizard = buildSetupWizard(unknownCtx).find((s) => s.id === "wz-emergency");
    expect(wizard?.statusText).toMatch(/unknown/i);
    expect(wizard?.statusText).not.toMatch(/not engaged/i);
    const cards = buildBlockerCards(unknownCtx, buildSetupChecklist(askLive));
    expect(cards.some((c) => c.kind === "emergency-stop-unknown")).toBe(true);
    expect(cards.some((c) => c.kind === "emergency-stop")).toBe(false);
  });

  it("a confirmed-off Emergency Stop reads as not engaged, and engaged as blocked", () => {
    const offWizard = buildSetupWizard(baseCtx({ emergencyStopActive: false })).find((s) => s.id === "wz-emergency");
    expect(offWizard?.statusText).toMatch(/not engaged/i);
    const onCtx = baseCtx({ emergencyStopActive: true });
    const onWizard = buildSetupWizard(onCtx).find((s) => s.id === "wz-emergency");
    expect(onWizard?.currentStatus).toBe("blocked");
    expect(buildBlockerCards(onCtx, buildSetupChecklist(askLive)).some((c) => c.kind === "emergency-stop")).toBe(true);
  });
});
