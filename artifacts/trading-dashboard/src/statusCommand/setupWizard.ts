/**
 * Safe Setup Wizard — 11 read-only steps.
 * Each step states current status, what to check, and an optional related route.
 * The wizard NEVER enables live trading or changes broker/MT5 state.
 */
import { resolveRoute } from "@/knowledge/routeKnowledge";
import { isNormalUserAllowedPath } from "@/lib/routeAccess";
import type { RuntimeContext } from "@/assistant/runtimeContextTypes";

export type WizardStepStatus = "complete" | "attention" | "blocked" | "info";

export interface WizardStep {
  id: string;
  title: string;
  shortExplanation: string;
  currentStatus: WizardStepStatus;
  statusText: string;
  pageRoute?: string;
  pageLabel?: string;
  assistantQuestion: string;
  /** Plain-English completion condition. */
  completionCondition: string;
}

// RANK 51 — safeRoute only ever asked "is this route DOCUMENTED?".
//
// resolveRoute() consults ROUTE_KNOWLEDGE, which is the assistant's
// documentation registry — not App.tsx's route table and not the trader route
// allowlist. So a step could name a route that is documented, has no <Route>
// at all (/dashboard: the dashboard lives at "/"), and is on no allowlist —
// and safeRoute would happily return it. 9 of the 10 wizard steps targeted such
// a route, and their audience is precisely the new or pending trader following
// the wizard, so the advertised onboarding path could not be completed.
//
// It now requires the route to be reachable by a human trader as well as
// documented. The page additionally re-checks each surviving route against the
// VIEWER's own tier before rendering the link (status-command-center.tsx), so a
// pending trader is never handed an approved-only destination.
function safeRoute(route: string): { route: string; label: string } | undefined {
  const r = resolveRoute(route);
  if (!r) return undefined;
  if (!isNormalUserAllowedPath(route)) return undefined;
  return { route, label: r.title };
}

export function buildSetupWizard(ctx: RuntimeContext): WizardStep[] {
  const steps: WizardStep[] = [];
  const r = (path: string, fallbackLabel: string) => {
    const x = safeRoute(path);
    return x ?? { route: undefined as unknown as string, label: fallbackLabel };
  };

  // 1. Understand current ARX mode
  {
    const mode = ctx.tradingMode;
    const known = mode !== "unknown";
    const x = r("/", "Cockpit");
    steps.push({
      id: "wz-mode",
      title: "Understand the current ARX mode",
      shortExplanation: "ARX runs in demo, simulator, broker-readonly, or live mode. The current mode is shown on every page.",
      currentStatus: known ? "complete" : "attention",
      statusText: `Current mode: ${mode.toUpperCase()}`,
      pageRoute: x.route, pageLabel: x.label,
      assistantQuestion: "Explain my current ARX mode",
      completionCondition: "You can read the current mode from the page header.",
    });
  }

  // 2. Review active safety locks
  {
    const locks = ctx.activeSafetyLocks;
    steps.push({
      id: "wz-locks",
      title: "Review active safety locks",
      shortExplanation: "Safety locks are protective. They keep ARX from sending real orders until every gate is verified server-side.",
      currentStatus: locks.length > 0 ? "info" : "attention",
      statusText: locks.length > 0 ? `Active locks: ${locks.join(", ")}` : "No safety locks detected from the client view.",
      assistantQuestion: "Explain my active safety locks",
      completionCondition: "You can name the locks and why each is on.",
    });
  }

  // 3. Check simulator/demo mode
  {
    const ok = ctx.paperOnly || ctx.simulatorMode;
    const x = r("/mt5-setup", "MT5 Setup");
    steps.push({
      id: "wz-demo-sim",
      title: "Check simulator / demo mode",
      shortExplanation: "Simulator/demo is the safe practice surface. Nothing reaches a real broker.",
      currentStatus: ok ? "complete" : "attention",
      statusText: ok ? "Demo/simulator mode is active." : "Demo/simulator not detected.",
      pageRoute: x.route, pageLabel: x.label,
      assistantQuestion: "Where do I practice in demo?",
      completionCondition: "Demo Trading is open and you've reviewed the execution controls.",
    });
  }

  // 4. Check MT5 bridge status
  {
    const mode = ctx.bridge?.bridgeMode ?? "unknown";
    const x = r("/mt5-setup", "MT5 Setup");
    steps.push({
      id: "wz-mt5",
      title: "Check MT5 bridge status",
      shortExplanation: "The bridge is deferred by default. Even if connected, broker stays read-only until execution is cleared server-side.",
      currentStatus: mode === "connected" ? "complete" : mode === "deferred" ? "info" : "attention",
      statusText: `Bridge mode: ${mode}`,
      pageRoute: x.route, pageLabel: x.label,
      assistantQuestion: "Explain the MT5 bridge status",
      completionCondition: "You know the current bridge mode and what it means.",
    });
  }

  // 5. Check heartbeat
  {
    const present = ctx.heartbeatPresent;
    const x = r("/mt5-setup", "MT5 Setup");
    steps.push({
      id: "wz-heartbeat",
      title: "Check heartbeat",
      shortExplanation: "A recent EA heartbeat is the only proof the bridge is alive.",
      currentStatus: present ? "complete" : ctx.mt5Deferred ? "info" : "blocked",
      statusText: present ? `Heartbeat present (${ctx.heartbeatAgeSeconds ?? "?"}s ago)` : ctx.mt5Deferred ? "Heartbeat not expected — bridge deferred." : "No recent heartbeat.",
      pageRoute: x.route, pageLabel: x.label,
      assistantQuestion: "Where do I check the heartbeat?",
      completionCondition: "You've opened MT5 Status and confirmed the heartbeat timestamp.",
    });
  }

  // 6. Review broker mode
  {
    const x = r("/mt5-setup", "MT5 Setup");
    steps.push({
      id: "wz-broker-mode",
      title: "Review broker mode",
      shortExplanation: "Broker is read-only by default. You can see balance/positions, but ARX cannot send orders.",
      currentStatus: ctx.brokerReadOnly ? "info" : "attention",
      statusText: ctx.brokerReadOnly ? "Broker is read-only." : "Broker is NOT read-only — investigate.",
      pageRoute: x.route, pageLabel: x.label,
      assistantQuestion: "Explain broker read-only mode",
      completionCondition: "You understand what read-only allows and prevents.",
    });
  }

  // 7. Review readiness
  {
    const x = r("/status-command-center", "ARX Status");
    steps.push({
      id: "wz-readiness",
      title: "Review readiness",
      shortExplanation: "Readiness gates govern whether the bot can move past demo.",
      currentStatus: ctx.readiness === "ready" ? "complete" : ctx.readiness === "incomplete" ? "attention" : "info",
      statusText: `Readiness: ${ctx.readiness}`,
      pageRoute: x.route, pageLabel: x.label,
      assistantQuestion: "What's blocking readiness?",
      completionCondition: "You've opened Readiness Checklist and reviewed every gate.",
    });
  }

  // 8. Review risk controls
  {
    const x = r("/risk-command-center", "Risk Command Center");
    steps.push({
      id: "wz-risk",
      title: "Review risk controls",
      shortExplanation: "Risk Governor enforces max-loss, lot size, and confidence thresholds before any order leaves ARX.",
      currentStatus: "attention",
      statusText: "Manual review required.",
      pageRoute: x.route, pageLabel: x.label,
      assistantQuestion: "Explain my risk controls",
      completionCondition: "You've opened Risk Governor and read every active rule.",
    });
  }

  // 9. Confirm Emergency Stop behavior
  {
    const x = r("/emergency", "Emergency");
    steps.push({
      id: "wz-emergency",
      title: "Confirm Emergency Stop behavior",
      shortExplanation: "The kill switch halts everything — demo, simulator, and live. It always wins.",
      currentStatus: ctx.emergencyStopActive ? "blocked" : "info",
      statusText: ctx.emergencyStopActive ? "Emergency Stop is ENGAGED." : "Emergency Stop not engaged.",
      pageRoute: x.route, pageLabel: x.label,
      assistantQuestion: "Explain Emergency Stop",
      completionCondition: "You've read the Emergency procedure for engaging and clearing.",
    });
  }

  // 10. Practice only in demo/simulator
  {
    const x = r("/mt5-setup", "MT5 Setup");
    steps.push({
      id: "wz-practice",
      title: "Practice only in demo/simulator",
      shortExplanation: "Run sessions, validate strategies, and review P&L charts — all without touching a real broker.",
      currentStatus: "info",
      statusText: "Practice surface ready in demo/simulator.",
      pageRoute: x.route, pageLabel: x.label,
      assistantQuestion: "Guide me through demo",
      completionCondition: "You've run at least one demo session.",
    });
  }

  // 11. Report unresolved issues
  {
    const x = r("/help", "Help Center");
    steps.push({
      id: "wz-report",
      title: "Report unresolved issues",
      shortExplanation: "If anything misbehaves, report it from the floating assistant or the Feedback Center. Safe diagnostic context auto-attaches.",
      currentStatus: "info",
      statusText: "Reporting available.",
      pageRoute: x.route, pageLabel: x.label,
      assistantQuestion: "Where do I report an issue?",
      completionCondition: "You've confirmed where reports land.",
    });
  }

  return steps;
}
