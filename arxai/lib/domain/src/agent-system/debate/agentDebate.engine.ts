import type {
  AgentVerdict, DebateConflict, DebateReport, DirectionVerdict, QualityVerdict,
} from "../agentSystem.types";

// agentDebate — IDENTIFIES conflicts between agents.
// Does NOT resolve them — that's the conflictResolver engine's job.
//
// Conflict kinds detected:
//  • DIRECTIONAL_OPPOSITE: two direction agents took opposite sides
//  • QUALITY_DISPERSION: max-min quality score gap > 40 points
//  • BLOCK_VS_PASS: a hard-block agent vetoed while another did not
//    (informational — the block still wins, but the disagreement is logged)
export function agentDebate(verdicts: AgentVerdict[]): DebateReport {
  const conflicts: DebateConflict[] = [];
  const reasons: string[] = [];

  // ── Directional conflicts ──────────────────────────────────────────────
  const directional = verdicts.filter((v): v is DirectionVerdict =>
    v.category === "DIRECTION" && v.direction !== "ABSTAIN");
  for (let i = 0; i < directional.length; i++) {
    for (let j = i + 1; j < directional.length; j++) {
      const a = directional[i], b = directional[j];
      if (a.direction !== b.direction) {
        conflicts.push({
          agentA: a.agentId, agentB: b.agentId,
          conflictKind: "DIRECTIONAL_OPPOSITE",
          description: `${a.agentName} ${a.direction}@${a.conviction.toFixed(0)} vs ${b.agentName} ${b.direction}@${b.conviction.toFixed(0)}`,
        });
      }
    }
  }

  // ── Directional agreement01 ────────────────────────────────────────────
  let directionalAgreement01 = 1;
  if (directional.length >= 2) {
    const buy  = directional.filter((v) => v.direction === "BUY").length;
    const sell = directional.filter((v) => v.direction === "SELL").length;
    directionalAgreement01 = Math.max(buy, sell) / directional.length;
  }

  // ── Quality dispersion ─────────────────────────────────────────────────
  const quality = verdicts.filter((v): v is QualityVerdict => v.category === "QUALITY");
  let qualityDispersion01 = 0;
  if (quality.length >= 2) {
    const scores = quality.map((q) => q.qualityScore);
    const min = Math.min(...scores), max = Math.max(...scores);
    const gap = max - min;
    qualityDispersion01 = Math.min(1, gap / 100);
    if (gap > 40) {
      // Pair the highest and lowest as the representative conflict.
      const hi = quality.reduce((a, b) => a.qualityScore > b.qualityScore ? a : b);
      const lo = quality.reduce((a, b) => a.qualityScore < b.qualityScore ? a : b);
      conflicts.push({
        agentA: hi.agentId, agentB: lo.agentId,
        conflictKind: "QUALITY_DISPERSION",
        description: `${hi.agentName} q${hi.qualityScore.toFixed(0)} vs ${lo.agentName} q${lo.qualityScore.toFixed(0)} — ${gap.toFixed(0)} point gap`,
      });
    }
  }

  // ── Block vs pass (informational) ──────────────────────────────────────
  const blocks = verdicts.filter((v) => v.category === "HARD_BLOCK");
  const blockedAgents = blocks.filter((b) => b.category === "HARD_BLOCK" && b.vetoed);
  const passingAgents = blocks.filter((b) => b.category === "HARD_BLOCK" && !b.vetoed);
  if (blockedAgents.length > 0 && passingAgents.length > 0) {
    conflicts.push({
      agentA: blockedAgents[0].agentId, agentB: passingAgents[0].agentId,
      conflictKind: "BLOCK_VS_PASS",
      description: `${blockedAgents.length} block(s) vs ${passingAgents.length} pass(es) at hard-block level`,
    });
  }

  reasons.push(`${conflicts.length} conflict(s) identified; directional agreement ${(directionalAgreement01 * 100).toFixed(0)}%, quality dispersion ${(qualityDispersion01 * 100).toFixed(0)}%`);
  return { conflicts, directionalAgreement01, qualityDispersion01, reasons };
}
