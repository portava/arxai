import type { PermissionVerdict } from "@workspace/domain/safety-permission";

export interface PermissionExplanation {
  headline: string;
  detail: string;
  recommendation: string;
}

/**
 * Turns a structured PermissionVerdict into plain-language coach copy.
 * Pure function — no I/O, deterministic on input.
 *
 * Integrates with existing aiCoach.ts (which explains *closed* trades) by
 * covering the *pre-trade* explanation surface.
 */
export function explainPermission(verdict: PermissionVerdict): PermissionExplanation {
  // LOCKED — pick the most actionable blocker as the headline.
  if (verdict.status === "LOCKED") {
    const top = pickTopBlocker(verdict);
    const headline = top.headline;
    const detail = verdict.blockers.length > 1
      ? `${verdict.blockers.length} reasons trading is paused right now: ${verdict.blockers.join(" · ")}`
      : verdict.blockers[0] ?? "Trading is currently locked by the safety system.";
    return { headline, detail, recommendation: top.recommendation };
  }

  if (verdict.status === "CAUTION") {
    const headline = "Caution — review before placing a trade.";
    const detail = verdict.warnings.length > 0
      ? verdict.warnings.join(" · ")
      : "One or more risk warnings are active.";
    const recommendation = "Reduce size, wait for a cleaner setup, or take a short break.";
    return { headline, detail, recommendation };
  }

  if (verdict.status === "LIVE_TRADING_DISABLED") {
    return {
      headline: "Live trading is currently disabled.",
      detail:
        "The system is in OBSERVE_ONLY or PAPER_TRADING mode. You can study signals and run paper trades; no live broker orders will be sent.",
      recommendation: "Use this time to review past trades and refine your strategy.",
    };
  }

  // CLEAR
  return {
    headline: "All clear — no active risk locks.",
    detail: "Risk limits, behavior detectors, and market conditions all look fine right now.",
    recommendation: "Stick to your plan and your risk-per-trade rules.",
  };
}

function pickTopBlocker(v: PermissionVerdict): { headline: string; recommendation: string } {
  const reasonsSorted = [...v.reasons].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const top = reasonsSorted.find((r) => r.severity === "BLOCK") ?? reasonsSorted[0];
  if (!top) return { headline: "Trading is locked by the safety system.", recommendation: "Wait until the lock is released." };

  switch (top.code) {
    case "KILL_SWITCH":
      return {
        headline: "Trading is paused — kill switch is engaged.",
        recommendation: "Investigate what triggered the kill switch before resetting it from the Emergency page.",
      };
    case "LIVE_LOCKED_USER":
      return {
        headline: "You manually locked live trading.",
        recommendation: "Unlock from Risk Settings when you're ready.",
      };
    case "DAILY_LOSS_LIMIT":
      return {
        headline: "Trading is locked because your daily loss limit was reached.",
        recommendation: "Step away for the rest of the session — tomorrow is a fresh start.",
      };
    case "MAX_TRADES_REACHED":
      return {
        headline: "Trading is locked because your daily trade limit was reached.",
        recommendation: "Stop trading for today; review the trades you took.",
      };
    case "CONSECUTIVE_LOSSES":
      return {
        headline: "Trading is locked after consecutive losses.",
        recommendation: "Take a 30-minute cooldown — or longer — before re-engaging.",
      };
    case "MARKET_NO_TRADE":
      return {
        headline: "Market condition is NO TRADE.",
        recommendation: "Wait for trend, structure, or session conditions to improve.",
      };
    case "REVENGE_TRADING":
      return {
        headline: "Revenge-trading pattern detected — trading is locked.",
        recommendation: "Step away. The pattern usually stems from emotion, not edge.",
      };
    case "OVERTRADE":
      return {
        headline: "Overtrading pattern detected — trading is locked.",
        recommendation: "Slow down. Quality over quantity.",
      };
    default:
      if (top.code.startsWith("LOCK_")) {
        return {
          headline: "An active risk lock is in place.",
          recommendation: "Check the cooldown timer; the lock will release automatically.",
        };
      }
      return { headline: top.message, recommendation: "Wait until the safety system releases the block." };
  }
}

function severityRank(s: "INFO" | "WARN" | "BLOCK"): number {
  return s === "BLOCK" ? 3 : s === "WARN" ? 2 : 1;
}
