import type {
  AgentVerdict, ConflictResolution, DebateReport, DirectionVerdict, QualityVerdict,
} from "../agentSystem.types";

// conflictResolver — given a DebateReport, proposes resolutions.
// Resolutions are recommendations, not actions; the judge engine consumes
// them when forming the proposed decision.
export function resolveConflicts(
  debate: DebateReport,
  verdicts: AgentVerdict[],
): ConflictResolution[] {
  const out: ConflictResolution[] = [];
  for (const c of debate.conflicts) {
    switch (c.conflictKind) {
      case "DIRECTIONAL_OPPOSITE": {
        const a = verdicts.find((v) => v.agentId === c.agentA) as DirectionVerdict | undefined;
        const b = verdicts.find((v) => v.agentId === c.agentB) as DirectionVerdict | undefined;
        if (!a || !b) {
          out.push({ conflictKind: c.conflictKind, action: "ESCALATE_TO_GOVERNOR", chosenAgentId: null,
            reasons: ["referenced agent not found in verdict set"] });
          break;
        }
        const gap = Math.abs(a.conviction - b.conviction);
        if (gap >= 25) {
          const winner = a.conviction > b.conviction ? a : b;
          out.push({
            conflictKind: c.conflictKind, action: "DEFER_TO_HIGHER_CONVICTION",
            chosenAgentId: winner.agentId,
            reasons: [`gap ${gap.toFixed(0)}pts ≥ 25 — defer to ${winner.agentName} (conviction ${winner.conviction.toFixed(0)})`],
          });
        } else {
          out.push({
            conflictKind: c.conflictKind, action: "ESCALATE_TO_GOVERNOR",
            chosenAgentId: null,
            reasons: [`conviction gap ${gap.toFixed(0)}pts < 25 — too close to defer; governor decides`],
          });
        }
        break;
      }
      case "QUALITY_DISPERSION": {
        // Quality dispersion is averageable — judge will use the average anyway.
        out.push({
          conflictKind: c.conflictKind, action: "AVERAGE",
          chosenAgentId: null,
          reasons: ["quality scores average naturally; flag dispersion in explanation"],
        });
        break;
      }
      case "BLOCK_VS_PASS": {
        // Hard blocks ALWAYS win — escalate so governor confirms.
        out.push({
          conflictKind: c.conflictKind, action: "ABORT",
          chosenAgentId: null,
          reasons: ["any hard-block veto wins by definition — abort regardless of passing agents"],
        });
        break;
      }
    }
  }
  return out;
}

// Quality verdicts helper kept here for resolver-side averaging convenience.
export function averageQualityScore(verdicts: AgentVerdict[]): number {
  const q = verdicts.filter((v): v is QualityVerdict => v.category === "QUALITY");
  if (q.length === 0) return 0;
  return q.reduce((s, v) => s + v.qualityScore, 0) / q.length;
}
