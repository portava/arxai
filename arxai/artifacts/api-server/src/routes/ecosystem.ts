// ═══════════════════════════════════════════════════════════════════════════
// /api/ecosystem/* — Phase 11 Ecosystem Evolution + Governance Intelligence
//
// All endpoints are ADVISORY (canPlaceTrades:false). Modes:
//   ECOSYSTEM_FITNESS_PIPELINE | EVOLUTION_CONSTITUTION_PIPELINE
//   EVOLUTION_SANDBOX_PIPELINE | EVOLUTION_MEMORY_PIPELINE
//   ECOSYSTEM_POLITICS_PIPELINE | EVOLUTION_FRAUD_PIPELINE
//   STRATEGY_SPECIES_PIPELINE   | ECOSYSTEM_SURVIVAL_PIPELINE
//
// PROJECT GUARANTEES enforced here:
//   • Ecosystem health > isolated profit. Promotion gates downstream must
//     respect ecosystemFitness.fitness01 and ecosystemSurvival.survival01.
//   • Forbidden mutations / failed constitution rulings are NEVER permitted.
//   • Sandbox simulation is mode-gated to SANDBOX only.
//   • Memory blacklist (collapse history) feeds the constitution.
//   • Vault entries (EE_*) are emitted for every governance/evolution event.
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { shadowCapture } from "../lib/auditVault.js";
import {
  ContributionInputsSchema, computeContributionScore,
  FragilityInputsSchema, evaluateSystemicFragility,
  EcosystemFitnessInputsSchema, evaluateEcosystemFitness,
} from "@workspace/domain/ecosystem-fitness";
import {
  ConstitutionRuleInputsSchema, ruleOnMutation, constitutionPreamble,
  listForbiddenPatterns,
} from "@workspace/domain/evolution-constitution";
import {
  CorrelatedFailureInputsSchema, simulateCorrelatedFailure,
  MassDisagreementInputsSchema, simulateMassDisagreement,
  EcosystemStressInputsSchema, evaluateEcosystemStress,
  EcosystemSimInputsSchema, runEcosystemSimulation,
} from "@workspace/domain/evolution-sandbox";
import {
  MutationMemoryQuerySchema, queryMutationMemory,
  CollapseHistoryInputsSchema, summarizeCollapseHistory,
  AdaptationSummaryInputsSchema, summarizeAdaptation,
} from "@workspace/domain/evolution-memory";
import {
  ConflictInputsSchema, resolveAuthorityConflict,
  EmergencyVetoInputsSchema, evaluateEmergencyVeto,
  GovernanceVoteInputsSchema, tallyGovernanceVote,
} from "@workspace/domain/ecosystem-politics";
import {
  FakeEdgeInputsSchema, detectFakeEdge,
  OverfitInputsSchema, detectOverfit,
  IllusionInputsSchema, detectStatisticalIllusion,
} from "@workspace/domain/evolution-fraud";
import {
  SpeciesFingerprintSchema, classifySpecies,
  ExtinctionRiskInputsSchema, evaluateExtinctionRisk,
  AdaptationCapacityInputsSchema, evaluateAdaptationCapacity,
  EcosystemBalanceInputsSchema, evaluateEcosystemBalance,
} from "@workspace/domain/strategy-species";
import {
  CivilizationStressInputsSchema, runCivilizationStressTest,
  SystemicRecoveryInputsSchema, evaluateSystemicRecovery,
  EcosystemSurvivalInputsSchema, evaluateEcosystemSurvival,
} from "@workspace/domain/ecosystem-survival";

const router: IRouter = Router();
const SOURCE = "ECOSYSTEM_GOVERNANCE" as never;

type Mode =
  | "ECOSYSTEM_FITNESS_PIPELINE" | "EVOLUTION_CONSTITUTION_PIPELINE"
  | "EVOLUTION_SANDBOX_PIPELINE" | "EVOLUTION_MEMORY_PIPELINE"
  | "ECOSYSTEM_POLITICS_PIPELINE" | "EVOLUTION_FRAUD_PIPELINE"
  | "STRATEGY_SPECIES_PIPELINE"   | "ECOSYSTEM_SURVIVAL_PIPELINE";

function nowIso(): string { return new Date().toISOString(); }
function envelope(mode: Mode) {
  return { canPlaceTrades: false as const, mode, generatedAtIso: nowIso() };
}

function parseOr400<T extends z.ZodTypeAny>(
  schema: T, body: unknown, res: Response,
): z.infer<T> | null {
  const r = schema.safeParse(body);
  if (!r.success) {
    res.status(400).json({ error: "invalid request body", issues: r.error.issues });
    return null;
  }
  return r.data;
}

async function logEvent(
  eventType: string, severity: "INFO" | "WARN" | "DANGER",
  payload: Record<string, unknown>,
): Promise<void> {
  await shadowCapture({
    source: SOURCE,
    eventType: eventType as never,
    severity,
    systemMode: null, globalState: null,
    payload,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Ecosystem fitness
// ═══════════════════════════════════════════════════════════════════════════
router.post("/ecosystem/contribution-score", async (req: Request, res: Response) => {
  const body = parseOr400(ContributionInputsSchema, req.body, res);
  if (!body) return;
  const result = computeContributionScore(body);
  await logEvent("EE_CONTRIBUTION_SCORED", result.netBenefit ? "INFO" : "WARN", {
    strategyId: result.strategyId, score: result.score, netBenefit: result.netBenefit,
  });
  res.json({ ...envelope("ECOSYSTEM_FITNESS_PIPELINE"), result });
});

router.post("/ecosystem/systemic-fragility", async (req: Request, res: Response) => {
  const body = parseOr400(FragilityInputsSchema, req.body, res);
  if (!body) return;
  const result = evaluateSystemicFragility(body);
  await logEvent("EE_FRAGILITY_EVALUATED", result.fragility01 >= 0.6 ? "WARN" : "INFO", {
    fragility01: result.fragility01, triggerCount: result.triggers.length,
  });
  res.json({ ...envelope("ECOSYSTEM_FITNESS_PIPELINE"), result });
});

router.post("/ecosystem/fitness", async (req: Request, res: Response) => {
  const body = parseOr400(EcosystemFitnessInputsSchema, req.body, res);
  if (!body) return;
  const report = evaluateEcosystemFitness(body);
  const sev: "INFO" | "WARN" | "DANGER" =
    report.fitness01 < 0.4 ? "DANGER" : report.fitness01 < 0.6 ? "WARN" : "INFO";
  await logEvent("EE_FITNESS_EVALUATED", sev, {
    fitness01: report.fitness01,
    netBeneficialFraction01: report.netBeneficialFraction01,
    fragility01: report.fragility01,
  });
  res.json({ ...envelope("ECOSYSTEM_FITNESS_PIPELINE"), report });
});

// ═══════════════════════════════════════════════════════════════════════════
// Evolution constitution
// ═══════════════════════════════════════════════════════════════════════════
router.get("/ecosystem/constitution/preamble", async (_req: Request, res: Response) => {
  res.json({
    ...envelope("EVOLUTION_CONSTITUTION_PIPELINE"),
    preamble: constitutionPreamble(),
    forbiddenPatterns: listForbiddenPatterns(),
  });
});

router.post("/ecosystem/constitution/rule", async (req: Request, res: Response) => {
  const body = parseOr400(ConstitutionRuleInputsSchema, req.body, res);
  if (!body) return;
  const ruling = ruleOnMutation(body);
  await logEvent("EE_CONSTITUTION_RULED", ruling.permitted ? "INFO" : "DANGER", {
    permitted: ruling.permitted,
    matchedForbiddenPatternIds: ruling.matchedForbiddenPatternIds,
    citedLawIds: ruling.citedLawIds,
    fingerprint: body.mutationFingerprint,
    proposedFromMode: body.proposedFromMode,
  });
  res.json({ ...envelope("EVOLUTION_CONSTITUTION_PIPELINE"), ruling });
});

// ═══════════════════════════════════════════════════════════════════════════
// Evolution sandbox simulations
// ═══════════════════════════════════════════════════════════════════════════
router.post("/ecosystem/sandbox/correlated-failure", async (req: Request, res: Response) => {
  const body = parseOr400(CorrelatedFailureInputsSchema, req.body, res);
  if (!body) return;
  const result = simulateCorrelatedFailure(body);
  await logEvent("EE_SANDBOX_FAILURE_SIM", result.breachesCatastrophicLimit ? "DANGER" : "INFO", {
    accountLossPct: result.scenarioAccountLossPct,
    breaches: result.breachesCatastrophicLimit,
  });
  res.json({ ...envelope("EVOLUTION_SANDBOX_PIPELINE"), result });
});

router.post("/ecosystem/sandbox/mass-disagreement", async (req: Request, res: Response) => {
  const body = parseOr400(MassDisagreementInputsSchema, req.body, res);
  if (!body) return;
  const result = simulateMassDisagreement(body);
  await logEvent("EE_SANDBOX_DISAGREEMENT_SIM", result.paralysis ? "WARN" : "INFO", {
    variance01: result.signalVariance01, paralysis: result.paralysis,
  });
  res.json({ ...envelope("EVOLUTION_SANDBOX_PIPELINE"), result });
});

router.post("/ecosystem/sandbox/stress", async (req: Request, res: Response) => {
  const body = parseOr400(EcosystemStressInputsSchema, req.body, res);
  if (!body) return;
  const result = evaluateEcosystemStress(body);
  await logEvent("EE_SANDBOX_STRESS_EVAL", result.systemBreaks ? "DANGER" : "INFO", {
    stress01: result.stress01, worstAxis: result.worstAxis, breaks: result.systemBreaks,
  });
  res.json({ ...envelope("EVOLUTION_SANDBOX_PIPELINE"), result });
});

router.post("/ecosystem/sandbox/simulation", async (req: Request, res: Response) => {
  const body = parseOr400(EcosystemSimInputsSchema, req.body, res);
  if (!body) return;
  const result = runEcosystemSimulation(body);
  const sev: "INFO" | "WARN" | "DANGER" =
    body.mode !== "SANDBOX" ? "DANGER" : result.passed ? "INFO" : "WARN";
  await logEvent("EE_SANDBOX_SIMULATION_RAN", sev, {
    passed: result.passed,
    mode: body.mode,
    failureBreaches: result.failure.breachesCatastrophicLimit,
    paralysis: result.disagreement.paralysis,
    stressBreaks: result.stress.systemBreaks,
  });
  res.json({ ...envelope("EVOLUTION_SANDBOX_PIPELINE"), result });
});

// ═══════════════════════════════════════════════════════════════════════════
// Evolution memory
// ═══════════════════════════════════════════════════════════════════════════
router.post("/ecosystem/memory/mutation-query", async (req: Request, res: Response) => {
  const body = parseOr400(MutationMemoryQuerySchema, req.body, res);
  if (!body) return;
  const decision = queryMutationMemory(body);
  await logEvent("EE_MUTATION_MEMORY_QUERIED", decision.blacklisted ? "WARN" : "INFO", {
    fingerprint: decision.fingerprint, blacklisted: decision.blacklisted,
    matchCount: decision.matchingEntries.length,
  });
  res.json({ ...envelope("EVOLUTION_MEMORY_PIPELINE"), decision });
});

router.post("/ecosystem/memory/collapse-history", async (req: Request, res: Response) => {
  const body = parseOr400(CollapseHistoryInputsSchema, req.body, res);
  if (!body) return;
  const report = summarizeCollapseHistory(body);
  await logEvent("EE_COLLAPSE_HISTORY_SUMMARIZED", "INFO", {
    totalCollapses: report.totalCollapses,
    inWindow: report.collapsesInWindow,
    blacklistFingerprintCount: report.rootFingerprintsToBlacklist.length,
  });
  res.json({ ...envelope("EVOLUTION_MEMORY_PIPELINE"), report });
});

router.post("/ecosystem/memory/adaptation-summary", async (req: Request, res: Response) => {
  const body = parseOr400(AdaptationSummaryInputsSchema, req.body, res);
  if (!body) return;
  const summary = summarizeAdaptation(body);
  await logEvent("EE_ADAPTATION_SUMMARIZED", "INFO", {
    strategyId: summary.strategyId,
    successRate01: summary.successRate01,
    attempts: summary.attempts,
  });
  res.json({ ...envelope("EVOLUTION_MEMORY_PIPELINE"), summary });
});

// ═══════════════════════════════════════════════════════════════════════════
// Ecosystem politics
// ═══════════════════════════════════════════════════════════════════════════
router.post("/ecosystem/politics/authority-conflict", async (req: Request, res: Response) => {
  const body = parseOr400(ConflictInputsSchema, req.body, res);
  if (!body) return;
  const resolution = resolveAuthorityConflict(body);
  await logEvent("EE_AUTHORITY_RESOLVED", "INFO", {
    competing: body.competing, winner: resolution.winner,
  });
  res.json({ ...envelope("ECOSYSTEM_POLITICS_PIPELINE"), resolution });
});

router.post("/ecosystem/politics/emergency-veto", async (req: Request, res: Response) => {
  const body = parseOr400(EmergencyVetoInputsSchema, req.body, res);
  if (!body) return;
  const decision = evaluateEmergencyVeto(body);
  await logEvent("EE_EMERGENCY_VETO_EVALUATED", decision.vetoApproved ? "DANGER" : "WARN", {
    invokingAuthority: decision.invokingAuthority,
    proposedAction: decision.proposedAction,
    vetoApproved: decision.vetoApproved,
  });
  res.json({ ...envelope("ECOSYSTEM_POLITICS_PIPELINE"), decision });
});

router.post("/ecosystem/politics/vote", async (req: Request, res: Response) => {
  const body = parseOr400(GovernanceVoteInputsSchema, req.body, res);
  if (!body) return;
  const result = tallyGovernanceVote(body);
  await logEvent("EE_GOVERNANCE_VOTE_TALLIED", "INFO", {
    motion: result.motion, passed: result.passed, approval01: result.approval01,
  });
  res.json({ ...envelope("ECOSYSTEM_POLITICS_PIPELINE"), result });
});

// ═══════════════════════════════════════════════════════════════════════════
// Evolution fraud
// ═══════════════════════════════════════════════════════════════════════════
router.post("/ecosystem/fraud/fake-edge", async (req: Request, res: Response) => {
  const body = parseOr400(FakeEdgeInputsSchema, req.body, res);
  if (!body) return;
  const result = detectFakeEdge(body);
  await logEvent("EE_FAKE_EDGE_EVALUATED", result.block ? "DANGER" : "INFO", {
    strategyId: result.strategyId, suspicion01: result.suspicion01, block: result.block,
  });
  res.json({ ...envelope("EVOLUTION_FRAUD_PIPELINE"), result });
});

router.post("/ecosystem/fraud/overfit", async (req: Request, res: Response) => {
  const body = parseOr400(OverfitInputsSchema, req.body, res);
  if (!body) return;
  const result = detectOverfit(body);
  await logEvent("EE_OVERFIT_EVALUATED", result.block ? "DANGER" : "INFO", {
    variantId: result.variantId, overfit01: result.overfit01, block: result.block,
  });
  res.json({ ...envelope("EVOLUTION_FRAUD_PIPELINE"), result });
});

router.post("/ecosystem/fraud/illusion", async (req: Request, res: Response) => {
  const body = parseOr400(IllusionInputsSchema, req.body, res);
  if (!body) return;
  const result = detectStatisticalIllusion(body);
  await logEvent("EE_ILLUSION_EVALUATED", result.block ? "DANGER" : "INFO", {
    strategyId: result.strategyId, illusion01: result.illusion01,
    tLike: result.tLike, block: result.block,
  });
  res.json({ ...envelope("EVOLUTION_FRAUD_PIPELINE"), result });
});

// ═══════════════════════════════════════════════════════════════════════════
// Strategy species
// ═══════════════════════════════════════════════════════════════════════════
router.post("/ecosystem/species/classify", async (req: Request, res: Response) => {
  const body = parseOr400(SpeciesFingerprintSchema, req.body, res);
  if (!body) return;
  const result = classifySpecies(body);
  await logEvent("EE_SPECIES_CLASSIFIED", "INFO", {
    strategyId: result.strategyId, species: result.species, confidence01: result.confidence01,
  });
  res.json({ ...envelope("STRATEGY_SPECIES_PIPELINE"), result });
});

router.post("/ecosystem/species/extinction-risk", async (req: Request, res: Response) => {
  const body = parseOr400(ExtinctionRiskInputsSchema, req.body, res);
  if (!body) return;
  const result = evaluateExtinctionRisk(body);
  await logEvent("EE_EXTINCTION_RISK_EVALUATED", result.risk01 >= 0.6 ? "WARN" : "INFO", {
    species: result.species, risk01: result.risk01,
  });
  res.json({ ...envelope("STRATEGY_SPECIES_PIPELINE"), result });
});

router.post("/ecosystem/species/adaptation-capacity", async (req: Request, res: Response) => {
  const body = parseOr400(AdaptationCapacityInputsSchema, req.body, res);
  if (!body) return;
  const result = evaluateAdaptationCapacity(body);
  await logEvent("EE_ADAPTATION_CAPACITY_EVALUATED", "INFO", {
    species: result.species, capacity01: result.capacity01,
  });
  res.json({ ...envelope("STRATEGY_SPECIES_PIPELINE"), result });
});

router.post("/ecosystem/species/balance", async (req: Request, res: Response) => {
  const body = parseOr400(EcosystemBalanceInputsSchema, req.body, res);
  if (!body) return;
  const report = evaluateEcosystemBalance(body);
  await logEvent("EE_ECOSYSTEM_BALANCE_EVALUATED", report.monocultureRisk ? "WARN" : "INFO", {
    diversity01: report.diversity01,
    dominantSpecies: report.dominantSpecies,
    dominantShare01: report.dominantShare01,
    monocultureRisk: report.monocultureRisk,
  });
  res.json({ ...envelope("STRATEGY_SPECIES_PIPELINE"), report });
});

// ═══════════════════════════════════════════════════════════════════════════
// Ecosystem survival
// ═══════════════════════════════════════════════════════════════════════════
router.post("/ecosystem/survival/civilization-stress", async (req: Request, res: Response) => {
  const body = parseOr400(CivilizationStressInputsSchema, req.body, res);
  if (!body) return;
  const result = runCivilizationStressTest(body);
  await logEvent("EE_CIVILIZATION_STRESS_RAN", result.survives ? "INFO" : "DANGER", {
    survives: result.survives,
    projectedLossPct: result.projectedAccountLossPct,
    marginOfSafety01: result.marginOfSafety01,
  });
  res.json({ ...envelope("ECOSYSTEM_SURVIVAL_PIPELINE"), result });
});

router.post("/ecosystem/survival/recovery", async (req: Request, res: Response) => {
  const body = parseOr400(SystemicRecoveryInputsSchema, req.body, res);
  if (!body) return;
  const result = evaluateSystemicRecovery(body);
  await logEvent("EE_SYSTEMIC_RECOVERY_EVALUATED", result.blockers.length > 0 ? "WARN" : "INFO", {
    estimatedRecoveryDays: result.estimatedRecoveryDays,
    recoveryScore01: result.recoveryScore01,
  });
  res.json({ ...envelope("ECOSYSTEM_SURVIVAL_PIPELINE"), result });
});

router.post("/ecosystem/survival/score", async (req: Request, res: Response) => {
  const body = parseOr400(EcosystemSurvivalInputsSchema, req.body, res);
  if (!body) return;
  const report = evaluateEcosystemSurvival(body);
  const sev: "INFO" | "WARN" | "DANGER" =
    report.survival01 < 0.3 ? "DANGER" : report.survival01 < 0.6 ? "WARN" : "INFO";
  await logEvent("EE_ECOSYSTEM_SURVIVAL_SCORED", sev, {
    survival01: report.survival01,
    stressSurvives: report.stressSurvives,
    pillars: report.pillars,
  });
  res.json({ ...envelope("ECOSYSTEM_SURVIVAL_PIPELINE"), report });
});

export default router;
