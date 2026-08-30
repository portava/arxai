/**
 * Blocker cards for the Status Command Center.
 *
 * Composes from RuntimeContext + checklist + recent failed endpoints.
 * Every blocker has: severity, what it blocks, why it's active,
 * whether it's protective (lock) or an error, how to check it,
 * a safe next step, and an optional related-route button.
 */
import { resolveRoute } from "@/knowledge/routeKnowledge";
import { isNormalUserAllowedPath } from "@/lib/routeAccess";
import type { RuntimeContext } from "@/assistant/runtimeContextTypes";
import type { ChecklistItem } from "@/knowledge/setupChecklist";

export type BlockerKind =
  | "emergency-stop"
  | "live-trading-disabled"
  | "broker-execution-disabled"
  | "mt5-deferred"
  | "simulator-mode"
  | "broker-readonly"
  | "missing-heartbeat"
  | "bridge-disconnected"
  | "readiness-incomplete"
  | "autopilot-blocked"
  | "permission-missing"
  | "failed-api-endpoint"
  | "ui-layout-issue"
  | "missing-knowledge";

export type BlockerSeverity = "info" | "attention" | "blocker";
export type BlockerNature = "protective" | "error";

export interface BlockerCard {
  kind: BlockerKind;
  title: string;
  severity: BlockerSeverity;
  nature: BlockerNature;
  blocks: string;
  why: string;
  howToCheck: string;
  safeNextStep: string;
  doNotDo: string;
  relatedRoute?: { label: string; route: string };
  evidence: string[];
}

// RANK 51 — same defect as setupWizard.safeRoute: resolveRoute() validates
// against the assistant's DOCUMENTATION registry, not App.tsx's routes and not
// the trader allowlist. Every blocker card's "Open …" button pointed at an
// admin-only surface, so the fix-first affordance on the ARX Status page was
// un-followable for the exact audience it was built for. A card whose target is
// unreachable now renders with NO button rather than a silent redirect.
function withRoute(label: string, route: string | undefined): BlockerCard["relatedRoute"] {
  if (!route) return undefined;
  if (!isNormalUserAllowedPath(route)) return undefined;
  const rk = resolveRoute(route);
  return rk ? { label, route } : undefined;
}

export function buildBlockerCards(ctx: RuntimeContext, checklist: ChecklistItem[]): BlockerCard[] {
  const out: BlockerCard[] = [];

  if (ctx.emergencyStopActive) {
    out.push({
      kind: "emergency-stop",
      title: "Emergency Stop active",
      severity: "blocker", nature: "protective",
      blocks: "All trading and autopilot actions across demo, simulator, and live.",
      why: "Someone (or an automated guard) engaged the kill switch.",
      howToCheck: "Open the Emergency page and read the trigger reason.",
      safeNextStep: "Investigate the trigger before clearing it.",
      doNotDo: "Do not clear the kill switch just to silence the badge.",
      relatedRoute: withRoute("Open Emergency", "/emergency"),
      evidence: ["emergencyStopActive=true"],
    });
  }

  if (ctx.liveTradingDisabled) {
    out.push({
      kind: "live-trading-disabled",
      title: "Live Trading Disabled",
      severity: "info", nature: "protective",
      blocks: "Sending real broker orders.",
      why: "Server-enforced safety lock — the default until every readiness gate is green and an operator clears it server-side.",
      howToCheck: "Open ARX Status to see which readiness gates remain.",
      safeNextStep: "Continue in simulator/demo mode.",
      doNotDo: "Do not attempt to flip this from the UI — it is server-enforced.",
      relatedRoute: withRoute("Open ARX Status", "/status-command-center"),
      evidence: ["LIVE TRADING DISABLED"],
    });
  }

  if (ctx.brokerExecutionDisabled) {
    out.push({
      kind: "broker-execution-disabled",
      title: "Broker Execution Disabled",
      severity: "info", nature: "protective",
      blocks: "Triggering broker execution from the UI.",
      why: "Execution gating is server-controlled and stays off until explicitly cleared server-side.",
      howToCheck: "Open MT5 Setup and review the broker mode badge.",
      safeNextStep: "Stay in read-only mode and reconcile positions.",
      doNotDo: "Do not attempt to enable execution from the UI.",
      relatedRoute: withRoute("Open MT5 Setup", "/mt5-setup"),
      evidence: ["brokerExecutionDisabled=true"],
    });
  }

  if (ctx.mt5Deferred) {
    out.push({
      kind: "mt5-deferred",
      title: "MT5 Deferred",
      severity: "info", nature: "protective",
      blocks: "MT5 EA bridge calls. ARX runs in simulator/demo mode.",
      why: "MT5 bridge is intentionally deferred (no token configured or unknown bridge state).",
      howToCheck: "Open MT5 Setup to read the EA setup steps.",
      safeNextStep: "If you intend to connect MT5, configure the bridge server-side. Otherwise, simulator is the safe default.",
      doNotDo: "Do not assume MT5 is connected — heartbeat is the source of truth.",
      relatedRoute: withRoute("Open MT5 Setup", "/mt5-setup"),
      evidence: [`bridgeMode=${ctx.bridge?.bridgeMode ?? "unknown"}`],
    });
  }

  if (ctx.simulatorMode) {
    out.push({
      kind: "simulator-mode",
      title: "Simulator Mode",
      severity: "info", nature: "protective",
      blocks: "Real market data and real broker execution.",
      why: "ARX is running synthetic candles for demo / replay.",
      howToCheck: "Open Testing Lab to compare with historical data.",
      safeNextStep: "Use simulator to validate strategies and dashboards. P&L is not real.",
      doNotDo: "Do not interpret simulator P&L as real money.",
      relatedRoute: withRoute("Open Testing Lab", "/testing-lab"),
      evidence: ["SIMULATOR MODE"],
    });
  }

  if (ctx.brokerReadOnly && ctx.mt5BridgeConnected) {
    out.push({
      kind: "broker-readonly",
      title: "Broker Read-Only",
      severity: "info", nature: "protective",
      blocks: "Modifying broker positions or sending orders.",
      why: "Read-only is the default after the bridge connects, until execution is cleared server-side.",
      howToCheck: "Open MT5 Setup and confirm the broker mode badge.",
      safeNextStep: "Stay read-only and reconcile balance/positions against the broker terminal.",
      doNotDo: "Do not attempt to relax read-only from the UI.",
      relatedRoute: withRoute("Open MT5 Setup", "/mt5-setup"),
      evidence: ["BROKER READ-ONLY"],
    });
  }

  if (!ctx.heartbeatPresent && !ctx.mt5Deferred) {
    out.push({
      kind: "missing-heartbeat",
      title: "Missing Heartbeat",
      severity: "blocker", nature: "error",
      blocks: "Confirming the MT5 EA is alive.",
      why: "No recent heartbeat. EA may be stopped, MT5 closed, WebRequest URL not allow-listed, or token mismatch.",
      howToCheck: "Open MT5 Setup to verify EA + token + URL allow-list.",
      safeNextStep: "Bring the EA back online server-side. ARX cannot fake a heartbeat.",
      doNotDo: "Do not assume the bridge is healthy without a fresh heartbeat.",
      relatedRoute: withRoute("Open MT5 Setup", "/mt5-setup"),
      evidence: [`heartbeatPresent=false`, `bridgeMode=${ctx.bridge?.bridgeMode ?? "unknown"}`],
    });
  }

  if (ctx.bridge?.bridgeMode === "disconnected") {
    out.push({
      kind: "bridge-disconnected",
      title: "Bridge Disconnected",
      severity: "blocker", nature: "error",
      blocks: "All bridge-mediated MT5 actions.",
      why: "Bridge token is configured server-side, but no EA is connecting.",
      howToCheck: "Open MT5 Setup and verify EA + token header + WebRequest allow-list.",
      safeNextStep: "Restore the EA server-side. ARX stays in simulator/demo mode meanwhile.",
      doNotDo: "Do not retry MT5 actions until the EA reports in.",
      relatedRoute: withRoute("Open MT5 Setup", "/mt5-setup"),
      evidence: [`bridgeMode=disconnected`],
    });
  }

  if (ctx.readiness === "incomplete") {
    out.push({
      kind: "readiness-incomplete",
      title: "Readiness Incomplete",
      severity: "attention", nature: "protective",
      blocks: "Moving past demo. Live trading remains unavailable regardless.",
      why: "One or more readiness gates (data, risk, broker, bridge, sign-off) are not green.",
      howToCheck: "Open ARX Status and address the readiness gates one at a time.",
      safeNextStep: "Resolve gates as legitimate state changes — do not force-complete.",
      doNotDo: "Do not force-complete gates to look ready.",
      relatedRoute: withRoute("Open ARX Status", "/status-command-center"),
      evidence: ["readiness=incomplete"],
    });
  }

  // Phase 4: `paper-session-blocked` blocker removed. Paper Trading was
  // retired as a product mode; the `/paper-trading` route was unmounted
  // in Phase 3 so this blocker pointed at a dead route. The companion
  // `paper-session-requirements` checklist item was also removed.

  // Autopilot blockers (drawn from active safety locks badges if surfaced)
  if (ctx.activeSafetyLocks.some((l) => /AUTOPILOT\s*BLOCKED/i.test(l))) {
    out.push({
      kind: "autopilot-blocked",
      title: "Autopilot Blocked",
      severity: "blocker", nature: "protective",
      blocks: "Autopilot from running until the failing readiness gate is fixed.",
      why: "A required readiness gate is failing.",
      howToCheck: "Open ARX Status and inspect the red readiness gates.",
      safeNextStep: "Fix the failing gate; autopilot will unblock when readiness is green.",
      doNotDo: "Do not bypass autopilot gating.",
      relatedRoute: withRoute("Open ARX Status", "/status-command-center"),
      evidence: ["AUTOPILOT BLOCKED"],
    });
  }

  if (ctx.serverRoleHint === "unknown") {
    out.push({
      kind: "permission-missing",
      title: "Permission unknown",
      severity: "attention", nature: "protective",
      blocks: "Some admin/tester features may be hidden until the server resolves your role.",
      why: "The server has not provided a role hint yet.",
      howToCheck: "Sign in (or refresh) and re-open this page.",
      safeNextStep: "Continue using public features. Permissions remain server-enforced.",
      doNotDo: "Do not assume admin access from the client view.",
      evidence: ["serverRoleHint=unknown"],
    });
  }

  const failed = ctx.recentFailedEndpoints.slice(-5);
  if (failed.length > 0) {
    out.push({
      kind: "failed-api-endpoint",
      title: `Failed API call${failed.length > 1 ? "s" : ""}`,
      severity: failed.length >= 3 ? "blocker" : "attention",
      nature: "error",
      blocks: "Pages that depend on the failing endpoint(s).",
      why: "Recent network errors or 4xx/5xx responses.",
      howToCheck: "Open ARX Status and confirm the service is up.",
      safeNextStep: "Hard-refresh; if it persists, report the issue (the safe context is auto-attached).",
      doNotDo: "Do not retry destructive requests blindly.",
      relatedRoute: withRoute("Open ARX Status", "/status-command-center"),
      evidence: failed,
    });
  }

  const uiOverlap = ctx.recentErrors.filter((e) => e.kind === "ui-overlap");
  if (uiOverlap.length > 0) {
    out.push({
      kind: "ui-layout-issue",
      title: "UI overlap detected",
      severity: "attention", nature: "error",
      blocks: "Tapping/clicking obscured controls at this viewport.",
      why: "An overlay or fixed element is covering interactive content.",
      howToCheck: "Try rotating, resizing, or scrolling.",
      safeNextStep: "Report the issue with this page open.",
      doNotDo: "Do not click obscured controls blindly.",
      evidence: uiOverlap.slice(-2).map((e) => e.message),
    });
  }

  if (ctx.missingKnowledgeFallbacks.length > 0) {
    out.push({
      kind: "missing-knowledge",
      title: "Assistant knowledge gap",
      severity: "info", nature: "error",
      blocks: "Quick assistant answers on a recent topic.",
      why: "The topic is not in the knowledge base yet, or phrasing didn't match.",
      // The Knowledge Console (/assistant-knowledge-console) is an operator
      // surface and is on neither trader allowlist, so withRoute() correctly
      // drops the button — but the instruction used to name it anyway, sending
      // a trader after a page they cannot open. There is nothing for them to
      // check here; say so.
      howToCheck: "Nothing to check on your side — the topic simply is not covered yet.",
      safeNextStep: "Re-ask in different words, or report it so the topic gets added.",
      doNotDo: "Do not assume silence means safety.",
      relatedRoute: withRoute("Open Knowledge Console", "/assistant-knowledge-console"),
      evidence: ctx.missingKnowledgeFallbacks.slice(-3),
    });
  }

  // Stable order: severity (blocker > attention > info) → title
  const sevRank = { blocker: 0, attention: 1, info: 2 } as const;
  return out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.title.localeCompare(b.title));
}
