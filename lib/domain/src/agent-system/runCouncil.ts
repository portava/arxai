// runCouncil — Phase 3 council pipeline (upgraded).
//
//   sensors (already in snapshot)
//     → 12 agents
//     → authority rules (level 1..5)
//     → Red Team challenge / Blue Team defense
//     → disagreement score → conflict severity
//     → judge (existing tradeJudge)
//     → council verdict mapper (7 verdicts)
//     → conflict-severity escalation overlay
//     → hard-block resolver (authority-5 veto override)
//     → vote expiration + stale-decision guard
//     → blocker hierarchy + explanation
//
// The council CANNOT place trades. The Risk Governor (separate engine) keeps
// its final veto. The Control Tower keeps mode control. This function ONLY
// returns artifacts; the caller is responsible for vault logging.

import { riskAgent } from "./agents/risk.agent";
import { executionAgent } from "./agents/execution.agent";
import { newsAgent } from "./agents/news.agent";
import { traderDnaAgent } from "./agents/traderDNA.agent";
import { trendAgent } from "./agents/trend.agent";
import { momentumAgent } from "./agents/momentum.agent";
import { liquidityAgent } from "./agents/liquidity.agent";
import { marketStructureAgent } from "./agents/marketStructure.agent";
import { volatilityAgent } from "./agents/volatility.agent";
import { sessionAgent } from "./agents/session.agent";
import { entryPrecisionAgent } from "./agents/entryPrecision.agent";
import { historicalMatchAgent } from "./agents/historicalMatch.agent";

import { agentDebate } from "./debate/agentDebate.engine";
import { runRedTeam } from "./debate/redTeam.agent";
import { runBlueTeam } from "./debate/blueTeam.agent";
import { disagreementScore } from "./debate/disagreementScore.engine";
import {
  diversityAdjustedDisagreementScore,
  type DiversityWeights,
} from "./debate/evidenceDiversity.engine";

import { tradeJudge } from "./judge/tradeJudge.engine";
import { explainDecision } from "./judge/decisionExplanation.engine";
import { mapToCouncilVerdict } from "./judge/councilVerdict.engine";

import { applyAuthorityRules } from "./authority/authorityRules.engine";
import { checkVoteExpiration } from "./expiration/voteExpiration.engine";
import { staleDecisionGuard } from "./expiration/staleDecisionGuard.engine";
import {
  classifyConflict, escalateIfMoreStrict,
} from "./conflict/conflictSeverity.engine";
import { rankBlockers } from "./conflict/blockerHierarchy.engine";
import { resolveHardBlock } from "./conflict/hardBlockResolver.engine";

import {
  CONTRACT_SCHEMA_VERSION, versionOf,
} from "./contracts/agentSchemaVersion.engine";
import type {
  AgentDataSourceId, AgentOutputContract, ContractValidation,
} from "./contracts/agentContract.types";
import {
  validateAgentOutput, neutralizeContract,
} from "./contracts/agentOutputValidator.engine";
import { applyConfidenceCap, type ConfidenceCapApplication } from "./safety/confidenceCap.engine";
import { enforceHallucinationGuard, type HallucinationCheck } from "./safety/hallucinationGuard.engine";
import { enforceEvidenceRequirement, type EvidenceRequirementCheck } from "./safety/evidenceRequirement.engine";
import { authorityOf } from "./authority/agentAuthority.types";

import type {
  AgentSystemSnapshot, AgentVerdict, DirectionVerdict, HardBlockVerdict,
  QualityVerdict,
} from "./agentSystem.types";
import {
  type AgentCouncilVote, type CouncilRunArtifact,
  verdictToCouncilVote,
} from "./agentVote.types";

const AGENT_DOMAIN: Record<string, string> = {
  RISK: "risk", EXEC: "execution", NEWS: "news", DNA: "trader-dna",
  TREND: "trend", MOMO: "momentum", LIQ: "liquidity",
  STRUCT: "market-structure", VOL: "volatility", SESSION: "session",
  PRECISION: "entry-precision", HIST: "historical-match",
};

// Per-agent declaration of which sensor families it consults. Drives the
// contract's `dataSourcesUsed` and the confidence-cap stale-data check.
const AGENT_DATA_SOURCES: Record<string, AgentDataSourceId[]> = {
  RISK:      ["account", "policy", "behavior"],
  EXEC:      ["execution", "market", "policy"],
  NEWS:      ["news", "policy"],
  DNA:       ["behavior"],
  TREND:     ["market"],
  MOMO:      ["market"],
  LIQ:       ["market"],
  STRUCT:    ["market"],
  VOL:       ["market", "policy"],
  SESSION:   ["market", "policy"],
  PRECISION: ["market", "setup"],
  HIST:      ["policy"],
};

/** TTL of an agent opinion in ms. After this, the vote is stale. */
const COUNCIL_OPINION_TTL_MS = 30_000;

export interface RunCouncilOptions {
  /** Historical evidence-diversity weights (from persisted per-agent stance
   *  records). When present, correlated agents' convictions are DISCOUNTED in
   *  the disagreement score — the discount can only RAISE disagreement (add
   *  caution). Absent → the classic unadjusted score (no fabricated
   *  correlation). */
  diversityWeights?: DiversityWeights | null;
}

export function runCouncil(
  snap: AgentSystemSnapshot,
  decisionId: string,
  opts: RunCouncilOptions = {},
): CouncilRunArtifact {
  // 1. Run all 12 agents (FACTS → INTERPRETATIONS).
  const verdicts: AgentVerdict[] = [
    riskAgent(snap),
    executionAgent(snap),
    newsAgent(snap),
    traderDnaAgent(snap),
    trendAgent(snap),
    momentumAgent(snap),
    liquidityAgent(snap),
    marketStructureAgent(snap),
    volatilityAgent(snap),
    sessionAgent(snap),
    entryPrecisionAgent(snap),
    historicalMatchAgent(snap),
  ];

  // 2. Authority rules — translate raw verdicts into per-agent authority
  //    decisions that record veto effectiveness.
  const authorityDecisions = applyAuthorityRules(verdicts);

  // 3. Build a strict V2 contract per agent, validate it, then run the
  //    safety pipeline (cap → hallucination → evidence). Anything that
  //    fails validation is force-neutralised so the council can't act on
  //    it. The resulting contracts feed the AgentCouncilVote shape that
  //    the rest of the pipeline already understands.
  const expiresAtIso = new Date(snap.now.getTime() + COUNCIL_OPINION_TTL_MS).toISOString();

  const contractValidations: ContractValidation[] = [];
  const confidenceCaps: ConfidenceCapApplication[] = [];
  const hallucinationChecks: HallucinationCheck[] = [];
  const evidenceChecks: EvidenceRequirementCheck[] = [];
  const agentContracts: AgentOutputContract[] = [];
  const agentVotes: AgentCouncilVote[] = [];

  for (const v of verdicts) {
    const { vote, confidence01 } = verdictToCouncilVote(v, snap.setup.direction);
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (v.category === "HARD_BLOCK") {
      const b = v as HardBlockVerdict;
      if (b.vetoed && b.vetoReason) blockers.push(b.vetoReason);
    }
    if (v.category === "DIRECTION") {
      const d = v as DirectionVerdict;
      if (d.direction !== "ABSTAIN" && d.direction !== snap.setup.direction && d.conviction >= 40) {
        warnings.push(`votes against proposed ${snap.setup.direction} (says ${d.direction} @ ${d.conviction.toFixed(0)})`);
      }
    }
    if (v.category === "QUALITY") {
      const q = v as QualityVerdict;
      if (q.qualityScore < 35) warnings.push(`low quality score ${q.qualityScore.toFixed(0)}/100`);
    }

    const initialEvidence = v.reasons.slice(0, 4);
    const authorityLevel = authorityOf(v.agentId);
    let contract: AgentOutputContract = {
      agentId: v.agentId, agentName: v.agentName,
      agentVersion: versionOf(v.agentId),
      authorityLevel,
      vote, confidence01,
      evidence: initialEvidence,
      warnings, blockers,
      expiresAtIso,
      dataSourcesUsed: AGENT_DATA_SOURCES[v.agentId] ?? ["market"],
      uncertaintyReason: warnings.length > 0 ? warnings[0] : null,
    };

    // 3a. Structural validation.
    const validation = validateAgentOutput(contract);
    contractValidations.push(validation);
    if (!validation.valid) {
      contract = neutralizeContract(contract, `invalid contract: ${validation.errors.join(", ")}`);
    }

    // 3b. Confidence cap (stale data, self-conflict, high warnings).
    const capRes = applyConfidenceCap(contract, snap);
    confidenceCaps.push(capRes.application);
    contract = capRes.contract;

    // 3c. Hallucination guard (high confidence requires ≥2 evidence cites).
    const halRes = enforceHallucinationGuard(contract);
    hallucinationChecks.push(halRes.check);
    contract = halRes.contract;

    // 3d. Evidence requirement (non-NEUTRAL vote needs ≥1 cite).
    const evRes = enforceEvidenceRequirement(contract);
    evidenceChecks.push(evRes.check);
    contract = evRes.contract;

    agentContracts.push(contract);
    agentVotes.push({
      agentId: contract.agentId,
      agentName: contract.agentName,
      domain: AGENT_DOMAIN[contract.agentId] ?? "unknown",
      vote: contract.vote,
      confidence01: contract.confidence01,
      evidence: contract.evidence,
      blockers: contract.blockers,
      warnings: contract.warnings,
      isCritical: contract.authorityLevel === 5,
      expiresAtIso: contract.expiresAtIso,
    });
  }

  // 4. Vote expiration + stale-decision guard.
  const voteExpirationChecks = checkVoteExpiration(agentVotes, snap.now);
  const staleGuard = staleDecisionGuard(voteExpirationChecks);

  // 5. Debate — Red Team challenges, Blue Team defends, disagreement score,
  //    conflict-severity classification.
  const debate = agentDebate(verdicts);
  const redTeam = runRedTeam(snap, verdicts, snap.setup.direction);
  const blueTeam = runBlueTeam(snap, verdicts, snap.setup.direction);
  const diversityView = opts.diversityWeights
    ? diversityAdjustedDisagreementScore(verdicts, opts.diversityWeights)
    : null;
  const dis = diversityView ?? disagreementScore(verdicts);
  const conflictSeverity = classifyConflict(dis.score01, debate.conflicts.length);

  // 6. Judge — synthesize into proposed decision (existing engine).
  const proposed = tradeJudge(verdicts, debate, snap.setup.direction);
  const explanationBase = explainDecision(proposed, verdicts, debate);

  // 7. Map onto council 7-verdict vocabulary.
  const baseDecision = mapToCouncilVerdict({
    agentVerdicts: verdicts, proposed, debate,
    disagreementScore01: dis.score01, redTeam, blueTeam,
  });

  // 8. Conflict-severity escalation: a HIGH/EXTREME split forces a stricter
  //    verdict (e.g. EXECUTE → SOFT_BLOCK). Never DEgrades.
  const escalated = escalateIfMoreStrict(baseDecision.verdict, conflictSeverity.forcedVerdict);
  if (escalated !== baseDecision.verdict) {
    baseDecision.reasoning.push(
      `escalated ${baseDecision.verdict} → ${escalated} (${conflictSeverity.reason})`,
    );
    baseDecision.verdict = escalated;
    if (escalated === "WAIT" || escalated === "SOFT_BLOCK" || escalated === "HARD_BLOCK") {
      baseDecision.sizeMultiplier = 0;
      baseDecision.conditions = [];
    }
  }

  // 9. Hard-block resolver: authority-5 veto overrides confidence + verdict.
  const hardBlockResolution = resolveHardBlock({
    authorityDecisions,
    currentVerdict: baseDecision.verdict,
    currentConfidence01: baseDecision.confidence01,
  });
  if (hardBlockResolution.triggered) {
    if (baseDecision.verdict !== "HARD_BLOCK") {
      baseDecision.reasoning.push(hardBlockResolution.reason);
    }
    baseDecision.verdict = "HARD_BLOCK";
    baseDecision.sizeMultiplier = 0;
    baseDecision.conditions = [];
  }

  // 10. Stale-decision guard: stale critical votes also force a SOFT_BLOCK
  //     (or stronger) so a stale snapshot can never silently authorize a
  //     trade.
  if (staleGuard.blockExecution && baseDecision.verdict !== "HARD_BLOCK") {
    baseDecision.reasoning.push(`stale guard: ${staleGuard.reason}`);
    baseDecision.verdict = "SOFT_BLOCK";
    baseDecision.sizeMultiplier = 0;
    baseDecision.conditions = [];
  }

  // 11. Blocker hierarchy (ranked, deterministic).
  const blockerHierarchy = rankBlockers(agentVotes, authorityDecisions);

  const explanation = {
    headline: `${baseDecision.verdict} — ${snap.setup.symbol} ${snap.setup.direction} (council confidence ${(baseDecision.confidence01 * 100).toFixed(0)}%)`,
    bullets: [
      ...explanationBase.bullets,
      `Red Team: ${redTeam.summary}`,
      `Blue Team: ${blueTeam.summary}`,
      `Disagreement: ${(dis.score01 * 100).toFixed(0)}% — ${conflictSeverity.level}`,
      `Authority-5 vetoes: ${hardBlockResolution.triggered ? hardBlockResolution.byAgentNames.join(", ") : "none"}`,
      `Stale critical votes: ${staleGuard.hasStaleCritical ? staleGuard.staleAgentIds.join(", ") : "none"}`,
    ],
    cautionFlags: [...explanationBase.cautionFlags, ...baseDecision.warnings],
  };

  return {
    decisionId,
    generatedAtIso: snap.now.toISOString(),
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    agentContracts,
    contractValidations,
    confidenceCaps,
    hallucinationChecks,
    evidenceChecks,
    agentVotes,
    authorityDecisions,
    voteExpirationChecks,
    staleGuard,
    redTeam, blueTeam,
    disagreementScore01: dis.score01,
    ...(diversityView
      ? {
          diversity: {
            applied: diversityView.adjustmentApplied,
            unadjustedScore01: diversityView.unadjustedScore01,
            clusters: opts.diversityWeights?.clusters ?? [],
          },
        }
      : {}),
    conflictSeverity,
    decision: baseDecision,
    blockerHierarchy,
    hardBlockResolution,
    explanation,
  };
}
