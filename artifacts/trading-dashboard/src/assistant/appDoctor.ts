// App Doctor diagnosis engine.
// Pure: takes a RuntimeContext and returns ordered, plain-English diagnoses.
// Never recommends enabling live trading. Never asserts a fake heartbeat.
import { resolveRoute } from "@/knowledge/routeKnowledge";
import type { DoctorDiagnosis, RuntimeContext } from "./runtimeContextTypes";

const SAFE_NEXT_DEFAULT = "Continue in simulator/demo mode and verify the relevant diagnostic page below.";

function safeRoute(route: string | undefined): string | undefined {
  if (!route) return undefined;
  return resolveRoute(route) ? route : undefined;
}

function pushIf(out: DoctorDiagnosis[], cond: boolean, d: DoctorDiagnosis): void {
  if (cond) out.push(d);
}

export function diagnose(ctx: RuntimeContext): DoctorDiagnosis[] {
  const out: DoctorDiagnosis[] = [];

  // 1) Emergency Stop active (highest priority)
  pushIf(out, ctx.emergencyStopActive, {
    category: "safety-lock",
    id: "doc-emergency-stop",
    explanation: "The Emergency Stop is engaged. All trading activity is halted by design.",
    evidence: ["emergencyStopActive=true"],
    likelyCause: "Someone (or an automated guard) hit the kill switch.",
    safeNextStep: "Open the Emergency page to review the trigger, then clear it only if it's safe to resume.",
    relatedRoute: safeRoute("/emergency"),
    doNotDo: "Do not bypass or work around the kill switch.",
    liveTradingStillUnavailable: true,
    priority: 1,
  });

  // 2) Live trading lock (informational — the lock is correct, not a bug)
  pushIf(out, ctx.liveTradingDisabled, {
    category: "safety-lock",
    id: "doc-live-trading-disabled",
    explanation: "Live trading is disabled. ARX cannot send real broker orders right now.",
    evidence: ["LIVE TRADING DISABLED"],
    likelyCause: "Server-enforced safety lock. This is the expected default until every readiness gate passes and an operator clears it server-side.",
    safeNextStep: "Use simulator/demo mode for now. Open the Readiness Checklist to see what would still need to be cleared.",
    relatedRoute: safeRoute("/readiness-checklist"),
    doNotDo: "Do not attempt to flip this from the UI — it is server-enforced.",
    liveTradingStillUnavailable: true,
    priority: 2,
  });

  // 3) Missing MT5 heartbeat
  pushIf(out, !ctx.heartbeatPresent && (ctx.mt5BridgeConnected || ctx.bridge?.bridgeMode === "disconnected"), {
    category: "heartbeat",
    id: "doc-no-heartbeat",
    explanation: "I don't see a recent heartbeat from the MT5 EA.",
    evidence: [
      `bridgeMode=${ctx.bridge?.bridgeMode ?? "unknown"}`,
      `heartbeatAgeSeconds=${ctx.heartbeatAgeSeconds ?? "n/a"}`,
    ],
    likelyCause: "EA not running, MT5 terminal closed, WebRequest URL not allow-listed, or token mismatch.",
    safeNextStep: "Open MT5 Bridge and verify the EA is running and the token header matches. ARX cannot fake a heartbeat.",
    relatedRoute: safeRoute("/mt5-bridge"),
    doNotDo: "Do not assume the bridge is healthy — heartbeat is the source of truth.",
    liveTradingStillUnavailable: true,
    priority: 3,
  });

  // 4) Bridge deferred / disconnected
  pushIf(out, ctx.mt5Deferred || ctx.bridge?.bridgeMode === "disconnected", {
    category: "mt5-bridge",
    id: "doc-bridge-deferred",
    explanation: "The MT5 bridge is deferred or disconnected. ARX is in simulator mode.",
    evidence: [`bridgeMode=${ctx.bridge?.bridgeMode ?? "unknown"}`],
    likelyCause: "Bridge intentionally off, or EA never connected.",
    safeNextStep: "If you intend to connect MT5, open the MT5 Bridge page. Otherwise, simulator mode is the safe default.",
    relatedRoute: safeRoute("/mt5-bridge"),
    doNotDo: "Do not attempt to send live orders — they will be rejected by the safety layer.",
    liveTradingStillUnavailable: true,
    priority: 4,
  });

  // 5) Broker read-only
  pushIf(out, ctx.brokerReadOnly && ctx.mt5BridgeConnected, {
    category: "broker-mode",
    id: "doc-broker-readonly",
    explanation: "Broker is in read-only mode. ARX can read balance/positions but cannot place orders.",
    evidence: ["BROKER READ-ONLY"],
    likelyCause: "Read-only is the default after the bridge connects, until execution is explicitly enabled server-side.",
    safeNextStep: "Stay in read-only for verification. Execution gating is server-controlled.",
    relatedRoute: safeRoute("/broker-readonly"),
    doNotDo: "Do not attempt to relax read-only from the UI.",
    liveTradingStillUnavailable: true,
    priority: 5,
  });

  // 6) Readiness incomplete
  pushIf(out, ctx.readiness === "incomplete", {
    category: "readiness",
    id: "doc-readiness-incomplete",
    explanation: "One or more readiness gates are not green.",
    evidence: ["readiness=incomplete"],
    likelyCause: "A required check (data, risk, broker, bridge, or operator sign-off) is not satisfied.",
    safeNextStep: "Open the Readiness Checklist to see which gate is red and why.",
    relatedRoute: safeRoute("/readiness-checklist"),
    doNotDo: "Do not force-complete gates — they must pass on real state.",
    liveTradingStillUnavailable: true,
    priority: 6,
  });

  // 7) Backend / API failures
  const failedEndpoints = ctx.recentFailedEndpoints.slice(-5);
  pushIf(out, failedEndpoints.length > 0, {
    category: "backend-api",
    id: "doc-api-failures",
    explanation: `I noticed ${failedEndpoints.length} recent failed API call(s).`,
    evidence: failedEndpoints,
    likelyCause: "Server hiccup, transient network failure, or a permission gate returning 403.",
    safeNextStep: "Hard-refresh and retry. If the same endpoint keeps failing, open System Health to check service status.",
    relatedRoute: safeRoute("/system-health") ?? safeRoute("/help"),
    doNotDo: "Do not retry destructive requests blindly.",
    liveTradingStillUnavailable: true,
    priority: 7,
  });

  // 8) Recent navigation failures
  pushIf(out, ctx.recentNavigationFailures.length > 0, {
    category: "route-navigation",
    id: "doc-route-failure",
    explanation: "A recent route failed to load.",
    evidence: ctx.recentNavigationFailures.slice(-3),
    likelyCause: "Stale build, missing chunk, or a route renamed without updating links.",
    safeNextStep: "Hard-refresh. If it still fails, report it via 'Report an issue' — the route is captured automatically.",
    doNotDo: "Do not bookmark unstable URLs until verified.",
    liveTradingStillUnavailable: true,
    priority: 8,
  });

  // 9) UI overlap warnings (from buffer)
  const uiErrors = ctx.recentErrors.filter((e) => e.kind === "ui-overlap");
  pushIf(out, uiErrors.length > 0, {
    category: "ui-layout",
    id: "doc-ui-overlap",
    explanation: "I detected a UI overlap warning on this layout.",
    evidence: uiErrors.slice(-2).map((e) => e.message),
    likelyCause: "An overlay or fixed element is covering interactive content at this viewport size.",
    safeNextStep: "Try rotating, resizing, or scrolling. If the issue persists, report it with this page open.",
    doNotDo: "Do not click obscured controls blindly.",
    liveTradingStillUnavailable: true,
    priority: 9,
  });

  // 10) Missing knowledge fallback
  pushIf(out, ctx.missingKnowledgeFallbacks.length > 0, {
    category: "unknown",
    id: "doc-knowledge-gap",
    explanation: "The assistant did not have a confident answer for a recent question.",
    evidence: ctx.missingKnowledgeFallbacks.slice(-3),
    likelyCause: "The topic isn't in the knowledge base yet, or the phrasing didn't match.",
    safeNextStep: "Try rephrasing, or report it so the topic can be added to the knowledge base.",
    relatedRoute: safeRoute("/assistant-knowledge-console"),
    doNotDo: "Do not assume silence means safety — re-ask in different words.",
    liveTradingStillUnavailable: true,
    priority: 10,
  });

  // Always include simulator-mode explanation at low priority so users have it.
  pushIf(out, ctx.simulatorMode || ctx.paperOnly, {
    category: "simulator-mode",
    id: "doc-simulator-mode",
    explanation: "ARX is currently running in simulator/demo mode.",
    evidence: ctx.activeSafetyLocks,
    likelyCause: "This is the default until MT5 + readiness + operator sign-off are all green server-side.",
    safeNextStep: "Use simulator to validate strategies, signals, and dashboards. Nothing reaches a real broker.",
    relatedRoute: safeRoute("/demo-trading") ?? safeRoute("/dashboard"),
    doNotDo: "Do not interpret simulator P&L as real money.",
    liveTradingStillUnavailable: true,
    priority: 11,
  });

  return out.sort((a, b) => a.priority - b.priority);
}

/** Returns the single highest-priority issue and a short list of safe alternates. */
export function fixFirst(ctx: RuntimeContext): { primary: DoctorDiagnosis | null; alternates: DoctorDiagnosis[] } {
  const all = diagnose(ctx);
  if (all.length === 0) return { primary: null, alternates: [] };
  return { primary: all[0] ?? null, alternates: all.slice(1, 4) };
}

/** Combine route knowledge + runtime state into a plain-English status report. */
export function explainAppStatus(ctx: RuntimeContext): {
  mode: string;
  canDo: string[];
  cannotDo: string[];
  whyLiveUnavailable: string;
  safestNextStep: string;
  nextRoute?: string;
} {
  const canDo: string[] = [
    "Browse every dashboard, scanner, and analytics page",
    "Run simulator/demo sessions and review P&L charts",
    "Read live read-only diagnostics if the bridge is connected",
  ];
  const cannotDo: string[] = [];
  if (ctx.liveTradingDisabled) cannotDo.push("Send real broker orders");
  if (ctx.brokerExecutionDisabled) cannotDo.push("Trigger broker execution from the UI");
  if (ctx.brokerReadOnly) cannotDo.push("Modify broker positions");
  if (!ctx.heartbeatPresent) cannotDo.push("Confirm an MT5 EA heartbeat");

  const whyLiveUnavailable = ctx.emergencyStopActive
    ? "Emergency Stop is engaged."
    : !ctx.heartbeatPresent
      ? "No confirmed MT5 EA heartbeat yet."
      : ctx.mt5Deferred
        ? "MT5 bridge is deferred."
        : ctx.brokerReadOnly
          ? "Broker is in read-only mode."
          : ctx.liveTradingDisabled
            ? "Server-enforced LIVE TRADING DISABLED lock is in place."
            : "All gates appear green from the client view, but execution remains server-gated.";

  const first = fixFirst(ctx).primary;
  return {
    mode: ctx.tradingMode.toUpperCase(),
    canDo,
    cannotDo,
    whyLiveUnavailable,
    safestNextStep: first?.safeNextStep ?? SAFE_NEXT_DEFAULT,
    ...(first?.relatedRoute ? { nextRoute: first.relatedRoute } : {}),
  };
}
