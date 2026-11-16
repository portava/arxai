/**
 * "Safest next step" engine.
 *
 * Returns a single, prioritized recommendation given live context, with a
 * justification and an explicit "what NOT to do" line. Live trading is
 * never the recommendation. Priority order matches docs/SAFETY_NOTES.md.
 */
import type { AskContext } from "./answerEngine";
import { resolveRoute } from "./routeKnowledge";

export interface SafestStep {
  id: string;
  step: string;
  why: string;
  openRoute: { label: string; route: string };
  doNot: string;
  liveStillUnavailable: true;
}

const CANDIDATES = [
  {
    id: "emergency",
    test: (c: AskContext) => (c.safetyStatuses ?? []).some((s) => /emergency/i.test(s)),
    step: "Investigate the Emergency Stop before touching anything else.",
    why: "Emergency Stop is the loudest safety control — leave it engaged until you understand why it tripped.",
    route: { label: "Emergency", route: "/emergency" },
    doNot: "Don't clear the kill switch just to make the badge disappear.",
  },
  {
    id: "live-disabled",
    test: (c: AskContext) =>
      (c.safetyStatuses ?? []).some((s) => /live[\s-]*trading[\s-]*disabled/i.test(s)),
    step: "Treat live trading as unavailable and stay in paper / simulator.",
    why: "Live trading is server-locked off until the bridge + router + readiness are all green.",
    route: { label: "Readiness Checklist", route: "/readiness-checklist" },
    doNot: "Don't ask the assistant to enable live trading — it has no power to do so.",
  },
  {
    id: "missing-heartbeat",
    test: (c: AskContext) => c.mt5Hint === "disconnected",
    step: "Check the MT5 Bridge heartbeat and EA log.",
    why: "Without a recent heartbeat ARX treats the bridge as absent (fail-closed).",
    route: { label: "MT5 Bridge", route: "/mt5-bridge" },
    doNot: "Don't fake heartbeat or push the system into thinking the bridge is alive.",
  },
  {
    id: "broker-readonly",
    test: (c: AskContext) => c.tradingModeHint === "broker-readonly",
    step: "Read the broker connection limitations on the Broker Read-only page.",
    why: "Read-only mode lets you inspect account state but blocks order send by design.",
    route: { label: "Broker Read-only", route: "/broker-readonly" },
    doNot: "Don't try to send a real order — it will be rejected and may produce false confidence.",
  },
  {
    id: "demo-blocked",
    test: (c: AskContext) => /\/(demo-trading)/.test(c.route),
    step: "Review demo-execution requirements on the Demo Trading page.",
    why: "Demo execution requires VERIFIED_DEMO + armed before commands can flow.",
    route: { label: "Demo Trading", route: "/demo-trading" },
    doNot: "Don't bypass demo prerequisites — they're the same discipline live trading requires.",
  },
  {
    id: "readiness",
    test: (c: AskContext) =>
      (c.safetyStatuses ?? []).some((s) => /readiness|autopilot/i.test(s)),
    step: "Open the Readiness Checklist and clear one failing gate at a time.",
    why: "Readiness gates are designed so you cannot start trading on a broken setup.",
    route: { label: "Readiness Checklist", route: "/readiness-checklist" },
    doNot: "Don't override any readiness item from the client — it has no effect server-side.",
  },
  {
    id: "confused-on-page",
    test: (c: AskContext) => !!c.pageTitle && c.recentExchanges?.length === 0,
    step: 'Use "What am I looking at?" to get a one-screen explanation of this page.',
    why: "When you land on an unfamiliar page, a grounded explanation prevents wrong assumptions.",
    route: { label: "Help Center", route: "/help" },
    doNot: "Don't rely on guesswork on unfamiliar pages.",
  },
  {
    id: "practice",
    test: () => true, // fallback
    step: "Practice in demo / simulator while finishing setup.",
    why: "The fastest safe path forward is reps in demo, not enabling more execution surface.",
    route: { label: "Demo Trading", route: "/demo-trading" },
    doNot: "Don't move to live until demo P&L, journal, and risk are all green.",
  },
] as const;

export function safestNextStep(ctx: AskContext): SafestStep {
  for (const c of CANDIDATES) {
    if (!c.test(ctx)) continue;
    if (!resolveRoute(c.route.route)) continue; // route-validate
    return {
      id: c.id,
      step: c.step,
      why: c.why,
      openRoute: c.route,
      doNot: c.doNot,
      liveStillUnavailable: true,
    };
  }
  // Fallback (should never hit because last candidate test === true)
  return {
    id: "practice",
    step: "Practice in demo mode.",
    why: "Default safe action.",
    openRoute: { label: "Demo Trading", route: "/demo-trading" },
    doNot: "Don't move to live until setup is complete.",
    liveStillUnavailable: true,
  };
}
