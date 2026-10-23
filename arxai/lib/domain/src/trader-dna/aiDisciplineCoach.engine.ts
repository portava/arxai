import type { BehaviorPatternHit, BehaviorPatternReport } from "./behaviorPattern.engine";
import type { OvertradeReport } from "./overtradeGuard.engine";
import type { RevengeTradeReport } from "./revengeTradingDetector.engine";
import type { SessionPerformanceReport } from "./sessionPerformance.engine";
import type { DnaSeverity, TraderProfile } from "./traderProfile.types";

export interface CoachMessage {
  id: string;                          // stable id for de-duping in the UI
  severity: DnaSeverity;
  topic:
    | "REVENGE"
    | "OVERTRADE"
    | "BEHAVIOR"
    | "SESSION"
    | "POSITIVE";
  headline: string;                    // short — fits in a toast
  detail: string;                      // longer — the explanation
  suggestedActions: string[];          // concrete, operator-actionable
  evidence: string[];
  createdAt: string;                   // ISO
}

export interface CoachReport {
  messages: CoachMessage[];
  overallTone: "ENCOURAGING" | "NEUTRAL" | "CAUTIONARY" | "URGENT";
}

// ── Generate coach messages from the various detector reports ─────────────
export function generateCoachReport(input: {
  profile: TraderProfile;
  patterns?: BehaviorPatternReport;
  overtrade?: OvertradeReport | null;
  revenge?: RevengeTradeReport | null;
  sessionPerformance?: SessionPerformanceReport | null;
  now?: Date;
}): CoachReport {
  const now = input.now ?? new Date();
  const messages: CoachMessage[] = [];

  // 1. Revenge trading is highest priority
  if (input.revenge?.detected) {
    messages.push(messageFromRevenge(input.revenge, now));
  }

  // 2. Overtrading
  if (input.overtrade?.detected) {
    messages.push(messageFromOvertrade(input.overtrade, now));
  }

  // 3. Each significant behavior pattern → its own coach message
  for (const hit of input.patterns?.hits ?? []) {
    messages.push(messageFromPattern(hit, now));
  }

  // 4. Session — tell trader where they win, where they don't
  if (input.sessionPerformance) {
    const m = messageFromSession(input.sessionPerformance, now);
    if (m) messages.push(m);
  }

  // 5. If nothing else fired and there are observed positive traits → reinforce
  if (messages.length === 0 && input.profile.traits.includes("DISCIPLINED")) {
    messages.push({
      id: `coach_${now.getTime()}_positive`,
      severity: "NONE", topic: "POSITIVE",
      headline: "Discipline holding",
      detail: "No behavioral red flags detected in the recent window. Stay with your plan.",
      suggestedActions: ["Keep position sizing constant", "Review your journal at session end"],
      evidence: [],
      createdAt: now.toISOString(),
    });
  }

  return { messages, overallTone: deriveTone(messages) };
}

// ── Per-source message builders ────────────────────────────────────────────

function messageFromRevenge(r: RevengeTradeReport, now: Date): CoachMessage {
  return {
    id: `coach_${now.getTime()}_revenge`,
    severity: r.severity, topic: "REVENGE",
    headline: "Revenge trading detected",
    detail: "Multiple entries followed a recent loss on the same symbol — including position sizes above the loss. This is a classic emotional response.",
    suggestedActions: [
      "Step away from the desk for at least 30 minutes.",
      r.cooldownUntil ? `System cooldown active until ${r.cooldownUntil}.` : "Activate manual cooldown.",
      "Re-read your loss before the next entry. Was the original setup invalid, or just unlucky?",
    ],
    evidence: r.evidence,
    createdAt: now.toISOString(),
  };
}

function messageFromOvertrade(r: OvertradeReport, now: Date): CoachMessage {
  return {
    id: `coach_${now.getTime()}_overtrade`,
    severity: r.severity, topic: "OVERTRADE",
    headline: `Overtrading — ${r.ratio.toFixed(1)}× baseline`,
    detail: `You've taken ${r.tradesToday} trades today. Your baseline is ${r.baseline.toFixed(1)}/day. Volume itself is rarely the edge.`,
    suggestedActions: [
      r.recommendBlock ? "Stop opening new positions for the rest of the session." : "Pause for 15 minutes before the next entry.",
      "Write a one-line setup thesis before any further entry.",
    ],
    evidence: r.evidence,
    createdAt: now.toISOString(),
  };
}

function messageFromPattern(hit: BehaviorPatternHit, now: Date): CoachMessage {
  const map: Record<string, { headline: string; detail: string; actions: string[] }> = {
    OVERTRADING: {
      headline: "Trade frequency above baseline",
      detail: "Your recent trade count exceeds your usual rhythm.",
      actions: ["Slow down — wait for your highest-grade setup", "Re-check session filter is on"],
    },
    FOMO_CHASING: {
      headline: "Chasing extended moves",
      detail: "Your stops have been wider than usual, suggesting late entries on extended candles.",
      actions: ["Skip a setup unless you can place SL within 1× ATR", "Wait for a pullback before entering"],
    },
    EARLY_EXIT: {
      headline: "Closing winners too early",
      detail: "You're exiting profitable trades between 0.2 and 0.7R most of the time, leaving the bulk of expected R on the table.",
      actions: ["Define exit at entry and don't move it forward", "Use trail-by-1R after 2R hit"],
    },
    RUNNER_CUTTING: {
      headline: "Losers larger than winners",
      detail: "Average loss magnitude exceeds average win — your R distribution is skewed against you.",
      actions: ["Honour stop losses without manual extension", "Audit any trade where you moved SL further from entry"],
    },
    OVERSIZED_BETS: {
      headline: "Position sizing creeping up",
      detail: "Recent lots are above your baseline — even small drawdowns will hurt disproportionately.",
      actions: ["Reset lot calculator to use account % risk, not fixed lots", "Roll back to baseline lot for the next 5 trades"],
    },
  };
  const entry = map[hit.pattern] ?? {
    headline: `Pattern: ${hit.pattern}`,
    detail: `Detected with ${hit.confidence}% confidence`,
    actions: ["Review the evidence below and consider a cool-off"],
  };
  return {
    id: `coach_${now.getTime()}_${hit.pattern}`,
    severity: hit.severity, topic: "BEHAVIOR",
    headline: entry.headline, detail: entry.detail, suggestedActions: entry.actions,
    evidence: hit.evidence,
    createdAt: now.toISOString(),
  };
}

function messageFromSession(r: SessionPerformanceReport, now: Date): CoachMessage | null {
  if (r.preferred.length === 0 && r.avoided.length === 0) return null;
  const parts: string[] = [];
  if (r.preferred.length) parts.push(`Strong: ${r.preferred.join(", ")}`);
  if (r.avoided.length)   parts.push(`Weak: ${r.avoided.join(", ")}`);
  return {
    id: `coach_${now.getTime()}_session`,
    severity: r.avoided.length > 0 ? "MEDIUM" : "LOW",
    topic: "SESSION",
    headline: "Session performance differs by window",
    detail: parts.join(" · "),
    suggestedActions: [
      r.preferred.length ? `Concentrate trading in ${r.preferred.join(", ")}` : "Build a sample of 5+ trades per session",
      r.avoided.length ? `Apply tighter filters in ${r.avoided.join(", ")}` : "Keep collecting data",
    ],
    evidence: r.bySession.map(
      (p) => `${p.session}: ${p.tradeCount}T  WR ${(p.winRate * 100).toFixed(0)}%  PF ${isFinite(p.profitFactor) ? p.profitFactor.toFixed(2) : "∞"}  net ${p.netPnL.toFixed(2)}`,
    ),
    createdAt: now.toISOString(),
  };
}

function deriveTone(messages: CoachMessage[]): CoachReport["overallTone"] {
  if (messages.some((m) => m.severity === "CRITICAL")) return "URGENT";
  if (messages.some((m) => m.severity === "HIGH")) return "CAUTIONARY";
  if (messages.length === 0 || messages.every((m) => m.topic === "POSITIVE")) return "ENCOURAGING";
  return "NEUTRAL";
}
