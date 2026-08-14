/**
 * ARX Setup Checklist — 12 items the assistant can show + explain.
 *
 * Status is derived from live context. Items are NEVER auto-completed
 * just to look green; "complete" requires affirmative ctx evidence.
 */
import type { AskContext } from "./answerEngine";
import { resolveRoute } from "./routeKnowledge";

export type ChecklistStatus = "complete" | "incomplete" | "blocked" | "unavailable";

export interface ChecklistItem {
  id: string;
  title: string;
  status: ChecklistStatus;
  explanation: string;
  related?: { label: string; route: string };
  safeNextAction: string;
  blockerReason?: string;
}

interface Builder {
  id: string;
  title: string;
  build: (ctx: AskContext) => Omit<ChecklistItem, "id" | "title">;
}

const BADGES = (ctx: AskContext) => (ctx.safetyStatuses ?? []).map((b) => b.toUpperCase());
const has = (ctx: AskContext, re: RegExp) => BADGES(ctx).some((b) => re.test(b));

const BUILDERS: Builder[] = [
  {
    id: "app-status",
    title: "App status verified",
    build: (ctx) => ({
      status: BADGES(ctx).length > 0 ? "complete" : "incomplete",
      explanation: "ARX is rendering safety badges, which means the dashboard wired up correctly.",
      related: { label: "Dashboard", route: "/dashboard" },
      safeNextAction: "Skim the badges at the top of the dashboard to confirm safe-defaults.",
    }),
  },
  {
    id: "paper-only-understood",
    title: "Demo mode understood",
    build: (ctx) => ({
      status: ctx.tradingModeHint === "paper" || has(ctx, /PAPER\s*ONLY/) ? "complete" : "incomplete",
      explanation: "ARX is in demo mode — every order routes to your MT5 demo account. You can't lose real money in this mode.",
      related: { label: "Demo Trading", route: "/demo-trading" },
      safeNextAction: "Open Demo Trading and run a session to see how orders flow.",
    }),
  },
  {
    id: "simulator-understood",
    title: "Simulator mode understood",
    build: () => ({
      status: "incomplete",
      explanation: "Simulator generates synthetic candles every 5 seconds for demo purposes — not market data.",
      related: { label: "Replay Simulator", route: "/replay-simulator" },
      safeNextAction: "Run Replay against historical data to compare with synthetic.",
    }),
  },
  {
    id: "risk-reviewed",
    title: "Risk page reviewed",
    build: () => ({
      status: "incomplete",
      explanation: "Risk Governor enforces max-loss, lot size, and confidence thresholds before any order leaves ARX.",
      related: { label: "Risk Governor", route: "/risk-governor" },
      safeNextAction: "Open Risk Governor and review every active rule.",
    }),
  },
  {
    id: "readiness-reviewed",
    title: "Readiness reviewed",
    build: (ctx) => ({
      status: has(ctx, /AUTOPILOT\s*BLOCKED/) ? "blocked" : "incomplete",
      explanation: "Readiness gates govern whether the bot can move past demo.",
      related: { label: "Readiness Checklist", route: "/readiness-checklist" },
      safeNextAction: "Open Readiness Checklist and address the red gates one at a time.",
      blockerReason: has(ctx, /AUTOPILOT\s*BLOCKED/) ? "Autopilot is blocked by failing gates." : undefined,
    }),
  },
  {
    id: "mt5-bridge-checked",
    title: "MT5 bridge status checked",
    build: (ctx) => ({
      status: ctx.mt5Hint === "connected" ? "complete" : ctx.mt5Hint === "disconnected" ? "blocked" : "incomplete",
      explanation: "Confirm whether the bridge is configured (deferred), live (connected), or offline (disconnected).",
      related: { label: "MT5 Bridge", route: "/mt5-bridge" },
      safeNextAction: "Open MT5 Bridge and read the EA setup steps.",
      blockerReason: ctx.mt5Hint === "disconnected" ? "Bridge is offline — heartbeat missing." : undefined,
    }),
  },
  {
    id: "heartbeat-checked",
    title: "Heartbeat checked",
    build: (ctx) => ({
      status: ctx.mt5Hint === "connected" ? "complete" : ctx.mt5Hint === "disconnected" ? "blocked" : "incomplete",
      explanation: "A recent heartbeat is proof the EA is alive and using the right token.",
      related: { label: "MT5 Status", route: "/mt5-status" },
      safeNextAction: "Open MT5 Status and confirm the heartbeat timestamp is recent.",
      blockerReason: ctx.mt5Hint === "disconnected" ? "No recent heartbeat from EA." : undefined,
    }),
  },
  {
    id: "broker-state-understood",
    title: "Broker read-only / execution state understood",
    build: () => ({
      status: "incomplete",
      explanation: "Broker connection is read-only by default. Even if it shows account data, no order will be sent.",
      related: { label: "Broker Read-only", route: "/broker-readonly" },
      safeNextAction: "Open Broker Read-only and confirm the badge state.",
    }),
  },
  {
    id: "emergency-understood",
    title: "Emergency Stop understood",
    build: (ctx) => ({
      status: has(ctx, /EMERGENCY/) ? "blocked" : "incomplete",
      explanation: "The kill switch halts everything — demo, sim, and live. It always wins.",
      related: { label: "Emergency", route: "/emergency" },
      safeNextAction: "Open Emergency and read the procedure for engaging / clearing the kill switch.",
      blockerReason: has(ctx, /EMERGENCY/) ? "Emergency Stop currently active." : undefined,
    }),
  },
  // Phase 4: `paper-session-requirements` removed. Paper Trading was
  // retired as a product mode in Phases 2/3 and `/paper-trading` is no
  // longer mounted; the blockerCards `paper-session-blocked` consumer
  // was removed in the same phase.
  {
    id: "ai-features-understood",
    title: "Replay / Coach / Data features understood",
    build: () => ({
      status: "incomplete",
      explanation: "Replay tests strategies on historical data; Coach gives post-trade feedback; Data tracks data quality.",
      related: { label: "AI Coach", route: "/ai-coach" },
      safeNextAction: "Open AI Coach and run a debrief on a recent demo trade.",
    }),
  },
  {
    id: "report-issue-confirmed",
    title: "Report-issue path confirmed",
    build: () => ({
      status: "incomplete",
      explanation: "If anything misbehaves, you can submit feedback from the assistant or the Feedback Center.",
      related: { label: "Feedback Center", route: "/feedback-center" },
      safeNextAction: "Open Feedback Center to confirm where reports land.",
    }),
  },
];

export function buildSetupChecklist(ctx: AskContext): ChecklistItem[] {
  return BUILDERS.map((b) => {
    const item = b.build(ctx);
    // Validate referenced route exists; if not, mark unavailable.
    let status = item.status;
    let related = item.related;
    if (related) {
      const resolved = resolveRoute(related.route);
      if (!resolved) {
        related = undefined;
        if (status === "complete") status = "incomplete";
      } else {
        // Keep label in sync with the route registry title.
        related = { label: resolved.title ?? related.label, route: related.route };
      }
    }
    return { id: b.id, title: b.title, ...item, status, related };
  });
}

export function checklistProgress(items: ChecklistItem[]): { complete: number; total: number; percent: number } {
  const complete = items.filter((i) => i.status === "complete").length;
  const total = items.length;
  return { complete, total, percent: total === 0 ? 0 : Math.round((complete / total) * 100) };
}
