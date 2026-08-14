import {
  type BehaviorImpact, type BehaviorVerdict, type ClosedTradeRecord,
  type TraderBehaviorEvent,
} from "./retrospective.types";

// evaluateTraderBehavior
//
// Pure: classifies each operator action as HELPFUL, HARMFUL, or NEUTRAL
// given what actually happened in the trade. Aggregates into a netImpact.
//
// Classification rules (per behavior kind):
//   • MANUAL_EARLY_EXIT
//       — HARMFUL  if exit cut a winning trade short of MFE (we left ≥ 1R on table)
//       — HELPFUL  if exit happened on a losing trade before MAE worsened
//       — NEUTRAL  otherwise
//   • MANUAL_STOP_TIGHTEN
//       — HELPFUL  if final outcome is profitable (locked in something)
//       — HARMFUL  if it stopped us out before a recovery (MFE > 0 but pnl ≤ 0)
//       — NEUTRAL  otherwise
//   • MANUAL_STOP_WIDEN_APPLIED
//       — HARMFUL  always (widening stops mid-trade is the canonical anti-pattern)
//   • MANUAL_STOP_WIDEN_ATTEMPT (refused)
//       — NEUTRAL  but logged — the operator tried; the system saved them
//   • ADDED_TO_POSITION
//       — HELPFUL if final pnl > 0 (averaged into a winner)
//       — HARMFUL if final pnl < 0 (averaged into a loser)
//   • REDUCED_POSITION
//       — HELPFUL if reduce was in a losing context (MAE deepening)
//       — NEUTRAL if reduce was in a winning context (just took chips off)
//   • OVERRIDE_KILL_SWITCH
//       — HARMFUL if outcome ended in loss; NEUTRAL otherwise (still risky)
//   • IGNORED_EXIT_WARNING
//       — HARMFUL if outcome ended worse than the warning would have implied
//   • OTHER
//       — NEUTRAL with descriptive reason
export function evaluateTraderBehavior(rec: ClosedTradeRecord): BehaviorVerdict {
  const reasons: string[] = [];
  const events: BehaviorImpact[] = [];
  const lost = rec.outcome.pnlR < 0;
  const won  = rec.outcome.pnlR > 0;
  const wonBigly = rec.outcome.pnlR >= 1.0;
  const mfe = rec.intra.maxFavorableExcursionR;
  const leftOnTable = Math.max(0, mfe - rec.outcome.pnlR);

  for (const ev of rec.behaviors) {
    const impact = classify(ev, { lost, won, wonBigly, mfe, leftOnTable });
    events.push(impact);
  }

  // Aggregate net impact: count helpful vs harmful; neutral doesn't shift.
  const helpfulCount = events.filter((e) => e.impact === "HELPFUL").length;
  const harmfulCount = events.filter((e) => e.impact === "HARMFUL").length;
  let netImpact: BehaviorVerdict["netImpact"];
  if (events.length === 0) {
    netImpact = "NONE";
    reasons.push("no operator interventions during trade");
  } else if (harmfulCount > helpfulCount) {
    netImpact = "HARMFUL";
    reasons.push(`${harmfulCount} harmful vs ${helpfulCount} helpful intervention(s) — net negative`);
  } else if (helpfulCount > harmfulCount) {
    netImpact = "HELPFUL";
    reasons.push(`${helpfulCount} helpful vs ${harmfulCount} harmful intervention(s) — net positive`);
  } else if (helpfulCount === 0 && harmfulCount === 0) {
    netImpact = "NEUTRAL";
    reasons.push(`${events.length} intervention(s), all neutral`);
  } else {
    netImpact = "NEUTRAL";
    reasons.push(`${helpfulCount} helpful and ${harmfulCount} harmful — net neutral by count`);
  }

  // Surface the worst single intervention prominently if any HARMFUL fired.
  const firstHarmful = events.find((e) => e.impact === "HARMFUL");
  if (firstHarmful) {
    reasons.push(`primary concern: ${firstHarmful.kind} — ${firstHarmful.reason}`);
  }

  return {
    affected: events.length > 0 && (helpfulCount > 0 || harmfulCount > 0),
    netImpact,
    events,
    reasons,
  };
}

interface OutcomeContext {
  lost: boolean; won: boolean; wonBigly: boolean; mfe: number; leftOnTable: number;
}

function classify(ev: TraderBehaviorEvent, ctx: OutcomeContext): BehaviorImpact {
  switch (ev.kind) {
    case "MANUAL_EARLY_EXIT": {
      if (ctx.won && ctx.leftOnTable >= 1.0) {
        return mk(ev, "HARMFUL", `early exit cut a winner short — left ${ctx.leftOnTable.toFixed(2)}R on table`);
      }
      if (ctx.lost && ctx.mfe <= 0.25) {
        return mk(ev, "HELPFUL", `early exit before MAE worsened on a never-developing trade`);
      }
      return mk(ev, "NEUTRAL", "early exit timing was unremarkable");
    }
    case "MANUAL_STOP_TIGHTEN": {
      if (ctx.won) return mk(ev, "HELPFUL", "tightened stop on a winner — locked in result");
      if (ctx.lost && ctx.mfe > 0.5) return mk(ev, "HARMFUL", `tightened stop in a winning context that then reversed — got knocked out before recovery (MFE was ${ctx.mfe.toFixed(2)}R)`);
      return mk(ev, "NEUTRAL", "stop tighten had ambiguous effect");
    }
    case "MANUAL_STOP_WIDEN_APPLIED":
      return mk(ev, "HARMFUL", "widened stop mid-trade — canonical anti-pattern, regardless of outcome");
    case "MANUAL_STOP_WIDEN_ATTEMPT":
      return mk(ev, "NEUTRAL", "widen attempt was refused by the system — discipline preserved");
    case "ADDED_TO_POSITION": {
      if (ctx.won)  return mk(ev, "HELPFUL", "averaged into a winner");
      if (ctx.lost) return mk(ev, "HARMFUL", "averaged into a loser — pyramiding into adverse move");
      return mk(ev, "NEUTRAL", "add-to-position outcome was flat");
    }
    case "REDUCED_POSITION": {
      if (ctx.lost && ctx.mfe < 0.25) return mk(ev, "HELPFUL", "reduced exposure on a deteriorating trade");
      return mk(ev, "NEUTRAL", "reduction had no material outcome impact");
    }
    case "OVERRIDE_KILL_SWITCH":
      if (ctx.lost) return mk(ev, "HARMFUL", "overrode kill switch and trade went on to lose — discipline gap");
      return mk(ev, "NEUTRAL", "kill switch override did not result in loss this time, but is high-risk behavior");
    case "IGNORED_EXIT_WARNING":
      if (ctx.lost) return mk(ev, "HARMFUL", "ignored exit warning and trade then lost");
      return mk(ev, "NEUTRAL", "ignored exit warning but outcome was not worse this time");
    case "OTHER":
      return mk(ev, "NEUTRAL", `other intervention: ${ev.description || "unspecified"}`);
  }
}

function mk(ev: TraderBehaviorEvent, impact: BehaviorImpact["impact"], reason: string): BehaviorImpact {
  return { kind: ev.kind, atFraction: ev.atFraction, impact, reason };
}
