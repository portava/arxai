// Blue Team — must defend EVERY trade. Even a hopeless trade gets an
// "examined, no defense viable" pass. Also emits CONDITIONS that, when
// non-empty, trigger an EXECUTE_IF council verdict downstream.

import type {
  AgentSystemSnapshot, AgentVerdict, DirectionVerdict, HardBlockVerdict,
  QualityVerdict, TradeDirection,
} from "../agentSystem.types";
import type {
  BlueTeamCondition, BlueTeamDefense, BlueTeamReport,
} from "../agentVote.types";

export function runBlueTeam(
  snap: AgentSystemSnapshot,
  verdicts: AgentVerdict[],
  proposedDir: TradeDirection,
): BlueTeamReport {
  const defenses: BlueTeamDefense[] = [];
  const conditions: BlueTeamCondition[] = [];
  let nDef = 0, nCond = 0;

  // 1. Direction agents voting WITH the proposed direction.
  for (const v of verdicts) {
    if (v.category !== "DIRECTION") continue;
    const d = v as DirectionVerdict;
    if (d.direction === proposedDir && d.conviction >= 40) {
      defenses.push({
        defenseId: `B${++nDef}`,
        strength: d.conviction >= 70 ? "STRONG" : d.conviction >= 55 ? "MEDIUM" : "WEAK",
        reason: `${d.agentName} supports ${proposedDir} (conviction ${d.conviction.toFixed(0)})`,
        supportingAgentId: d.agentId, evidence: d.reasons.slice(0, 3),
      });
    }
  }

  // 2. Quality agents scoring the setup well.
  for (const v of verdicts) {
    if (v.category !== "QUALITY") continue;
    const q = v as QualityVerdict;
    if (q.qualityScore >= 60) {
      defenses.push({
        defenseId: `B${++nDef}`,
        strength: q.qualityScore >= 80 ? "STRONG" : "MEDIUM",
        reason: `${q.agentName} confirms strong setup quality (${q.qualityScore.toFixed(0)}/100)`,
        supportingAgentId: q.agentId, evidence: q.reasons.slice(0, 3),
      });
    }
  }

  // 3. Hard-block agents that did NOT veto are passive defenses.
  for (const v of verdicts) {
    if (v.category !== "HARD_BLOCK") continue;
    const b = v as HardBlockVerdict;
    if (!b.vetoed) {
      defenses.push({
        defenseId: `B${++nDef}`, strength: "WEAK",
        reason: `${b.agentName} cleared (no veto)`,
        supportingAgentId: b.agentId, evidence: b.reasons.slice(0, 1),
      });
    }
  }

  // 4. CONDITIONS — situations where the trade is OK only if X happens.
  // These trigger EXECUTE_IF downstream.
  if (snap.market.liquidityScore01 < snap.policy.minLiquidity01 + 0.10
   && snap.market.liquidityScore01 >= snap.policy.minLiquidity01) {
    conditions.push({
      conditionId: `C${++nCond}`,
      description: "execute only if liquidity recovers above threshold + 10%",
      monitorSignal: "market.liquidityScore01",
    });
  }
  const upcoming = snap.news.upcomingEvents.find(
    e => e.affectsSymbol && e.severity === "HIGH"
      && e.minutesUntil > snap.news.blackoutMinutesBeforeHigh
      && e.minutesUntil <= snap.news.blackoutMinutesBeforeHigh + 30,
  );
  if (upcoming) {
    conditions.push({
      conditionId: `C${++nCond}`,
      description: `execute only if "${upcoming.title}" passes uneventfully (${upcoming.minutesUntil}m away)`,
      monitorSignal: "news.upcomingEvents",
    });
  }
  if (snap.market.pipsToNearestSwing > 8) {
    conditions.push({
      conditionId: `C${++nCond}`,
      description: `execute only on retest closer than 8 pips to swing (current ${snap.market.pipsToNearestSwing.toFixed(1)}p)`,
      monitorSignal: "market.currentPrice",
    });
  }

  const summary = defenses.length === 0
    ? "examined; no defense viable"
    : `${defenses.length} defense(s) raised`
      + (conditions.length > 0 ? `, ${conditions.length} condition(s) attached` : "");

  return { defenses, conditions, examined: true, summary };
}
