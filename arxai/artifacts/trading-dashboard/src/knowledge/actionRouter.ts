/**
 * Assistant Action Router.
 *
 * Classifies a free-text user message into a single safe action and
 * (optionally) a payload. Forbidden trading/safety actions are explicitly
 * mapped to a refusal.
 *
 * The router NEVER performs an action — it only returns the intent.
 * The caller (widget) is responsible for executing safe actions
 * (navigation, opening views) and rendering refusals.
 */
import type { AskContext } from "./answerEngine";
import { resolveRoute, ROUTE_KNOWLEDGE } from "./routeKnowledge";
import { checkSafetyRefusal } from "./safetyRefusal";

export type ActionKind =
  | "navigate"
  | "explain-page"
  | "explain-badges"
  | "diagnose-blockers"
  | "diagnose-readiness"
  | "open-help"
  | "open-report-issue"
  | "start-walkthrough"
  | "show-safest-next"
  | "show-checklist"
  | "answer"
  | "refuse";

export interface AssistantAction {
  kind: ActionKind;
  /** When kind === "navigate", the validated route to open. */
  route?: string;
  /** When kind === "start-walkthrough", the walkthrough id. */
  walkthroughId?: string;
  /** Human label for the assistant to echo. */
  label?: string;
  /** Reason for refusal, if kind === "refuse". */
  reason?: string;
}

export const SAFE_ACTION_KINDS: ActionKind[] = [
  "navigate", "explain-page", "explain-badges", "diagnose-blockers",
  "diagnose-readiness", "open-help", "open-report-issue", "start-walkthrough",
  "show-safest-next", "show-checklist", "answer",
];

/** Forbidden intents — explicit list for documentation + tests. */
export const FORBIDDEN_INTENTS = [
  "place-live-trade",
  "place-paper-trade-without-confirmation",
  "enable-live-trading",
  "disable-emergency-stop",
  "bypass-risk-controls",
  "force-mt5-execution",
  "change-broker-credentials",
  "reveal-secrets",
  "change-user-role",
  "override-readiness",
  "fake-heartbeat",
  "fake-broker-connection",
  "fake-account-status",
] as const;

// ── Pattern table ─────────────────────────────────────────────────────────
const NAV_HINTS: { pattern: RegExp; route: string; label: string }[] = [
  { pattern: /\b(open|take me to|go to|show me|where is)\s+(the\s+)?risk\b/i, route: "/risk-governor", label: "Risk Governor" },
  { pattern: /\b(open|take me to|go to|show me)\s+(the\s+)?(trade|trade ticket|ticket)\b/i, route: "/manual-trade-ticket", label: "Trade" },
  { pattern: /\b(open|take me to|go to|show me)\s+(the\s+)?(ai|coach)\b/i, route: "/ai-coach", label: "AI Coach" },
  { pattern: /\b(open|take me to|go to|show me|where is)\s+(the\s+)?(help|help center)\b/i, route: "/help", label: "Help Center" },
  { pattern: /\b(open|take me to|go to|show me|where is)\s+(the\s+)?mt5(\s+bridge)?\b/i, route: "/mt5-bridge", label: "MT5 Bridge" },
  { pattern: /\b(open|take me to|go to|show me|where is)\s+(the\s+)?(replay|market replay)\b/i, route: "/replay-simulator", label: "Replay Simulator" },
  { pattern: /\b(open|take me to|go to|show me|where is|where (do|can) i (see|find|view))\s+(the\s+)?(my\s+)?data\b/i, route: "/data-import", label: "Data Import" },
  { pattern: /\b(open|take me to|go to|show me|where is)\s+(the\s+)?broker(\s+settings)?\b/i, route: "/broker-readonly", label: "Broker" },
  { pattern: /\b(open|take me to|go to|show me|where is)\s+(the\s+)?readiness\b/i, route: "/readiness-checklist", label: "Readiness Checklist" },
  { pattern: /\b(open|take me to|go to|show me|where is)\s+(the\s+)?(emergency|kill switch)\b/i, route: "/emergency", label: "Emergency" },
  // Paper Trading voice/text-command route removed (Phase 3 — feature retired).
  { pattern: /\b(open|take me to|go to|show me|where is)\s+(the\s+)?(journal)\b/i, route: "/journal", label: "Journal" },
  { pattern: /\b(open|take me to|go to|show me|where is)\s+(the\s+)?(strategy|strategy lab)\b/i, route: "/strategy-lab", label: "Strategy Lab" },
  { pattern: /\b(open|take me to|go to|show me)\s+(the\s+)?(more|menu)\b/i, route: "/", label: "More menu" },
  { pattern: /\b(report|file|submit)\s+(an\s+)?(issue|bug|feedback)\b/i, route: "/feedback-center", label: "Report an issue" },
  { pattern: /\bwhere (do i|can i) (check|see) (the\s+)?heartbeat\b/i, route: "/mt5-status", label: "MT5 Status" },
  { pattern: /\b(open|take me to|go to|show me)\s+(the\s+)?(status (command )?center|arx status|command center)\b/i, route: "/status-command-center", label: "ARX Status Command Center" },
  { pattern: /\b(start safe setup|guided setup|safe setup wizard|run safe setup)\b/i, route: "/status-command-center", label: "ARX Status Command Center" },
  { pattern: /\b(explain (my )?readiness score|what'?s my readiness|active blockers?|explain blockers?)\b/i, route: "/status-command-center", label: "ARX Status Command Center" },
];

const INTENT_RULES: { kind: ActionKind; pattern: RegExp; label?: string; walkthroughId?: string }[] = [
  { kind: "explain-page", pattern: /\b(what (am i looking at|is this page|does this page do)|explain (this|the) page)\b/i, label: "Explain this page" },
  { kind: "explain-badges", pattern: /\bexplain (?:(?:current|status|these|the|my) )*badges?\b|\bwhat do (these|the|current|my) badges mean\b/i, label: "Explain badges" },
  { kind: "diagnose-blockers", pattern: /\b(why am i blocked|why is this blocked|why can.?t i|what.?s blocking me)\b/i, label: "Diagnose blockers" },
  { kind: "diagnose-readiness", pattern: /\b(check|run|show)\s+readiness\b|\breadiness (status|check)\b/i, label: "Check readiness" },
  { kind: "show-safest-next", pattern: /\b(what should i do next|safest (next )?step|what.?s next|what should i fix first|fix first)\b/i, label: "Show safest next step" },
  // Walkthroughs must be tested BEFORE the generic show-checklist pattern.
  { kind: "start-walkthrough", pattern: /\bguide me through (paper)\b/i, label: "Walkthrough", walkthroughId: "wt-paper-session" },
  { kind: "start-walkthrough", pattern: /\bguide me through (mt5|bridge)\b/i, label: "Walkthrough", walkthroughId: "wt-connect-mt5" },
  { kind: "start-walkthrough", pattern: /\bhelp me understand (live trading disabled|live disabled)\b/i, label: "Walkthrough", walkthroughId: "wt-why-live-disabled" },
  { kind: "show-checklist", pattern: /\b(setup|onboarding) checklist\b|\bshow checklist\b|\bguide me through (setup)\b/i, label: "Setup checklist" },
  { kind: "open-help", pattern: /\b(open|show)\s+(the\s+)?help (center)?\b/i, label: "Help Center" },
  { kind: "open-report-issue", pattern: /\b(report|file|submit) (an\s+)?(issue|bug|feedback)\b/i, label: "Report an issue" },
];

export function classifyAction(question: string, ctx: AskContext): AssistantAction {
  const q = question.trim();
  if (!q) return { kind: "answer" };

  // 1) Forbidden FIRST — never let a refusal be hijacked by a navigation hint.
  const refusal = checkSafetyRefusal(q, ctx);
  if (refusal) {
    return { kind: "refuse", reason: refusal.sourceId, label: "Safety refusal" };
  }

  // 2) Explicit intent rules.
  for (const r of INTENT_RULES) {
    if (r.pattern.test(q)) {
      if (r.kind === "start-walkthrough" && r.walkthroughId) {
        return { kind: "start-walkthrough", walkthroughId: r.walkthroughId, label: r.label };
      }
      return { kind: r.kind, label: r.label };
    }
  }

  // 3) Navigation hints (validated against route registry).
  for (const n of NAV_HINTS) {
    if (n.pattern.test(q)) {
      const target = resolveRoute(n.route) ? n.route : closestRoute(n.route);
      if (target) return { kind: "navigate", route: target, label: n.label };
    }
  }

  // 4) Default — let the answer engine handle it as a knowledge query.
  return { kind: "answer" };
}

/** Pick the closest existing route by prefix, never inventing. */
export function closestRoute(wanted: string): string | undefined {
  if (resolveRoute(wanted)) return wanted;
  const lower = wanted.toLowerCase();
  // exact prefix segment match first
  const all = ROUTE_KNOWLEDGE.map((r) => r.route);
  const seg = lower.split("/").filter(Boolean)[0];
  if (seg) {
    const hit = all.find((r) => r.toLowerCase().startsWith(`/${seg}`));
    if (hit) return hit;
  }
  return undefined;
}
