// ═══════════════════════════════════════════════════════════════════════════
// Strategy Attack — pure. Orchestrator that, given a bundle of attack
// inputs across all six categories, runs each sub-engine and returns the
// per-category subscores. Caller can then feed these into
// `adversarialValidation.engine` for the final decision.
// ═══════════════════════════════════════════════════════════════════════════

import {
  assessEdgeFragility, type EdgeFragilityInput, type EdgeFragilityResult,
} from "./edgeFragility.engine";
import {
  assessRegimeCollapse, type RegimeCollapseInput, type RegimeCollapseResult,
} from "./regimeCollapse.engine";
import {
  assessExecutionSabotage, type ExecutionSabotageInput, type ExecutionSabotageResult,
} from "./executionSabotage.engine";
import {
  assessBehavioralStress, type BehavioralStressInput, type BehavioralStressResult,
} from "./behavioralStress.engine";
import {
  assessContradictionTolerance, type ContradictionTestInput, type ContradictionTestResult,
} from "./contradictionTest.engine";
import {
  assessOverfitExposure, type OverfitExposureInput, type OverfitExposureResult,
} from "./overfitExposure.engine";
import {
  auditAssumptions, type AssumptionAuditInput, type AssumptionAuditResult,
} from "./assumptionAudit.engine";

export interface StrategyAttackInput {
  candidateId: string;
  edgeFragility?:        EdgeFragilityInput;
  regimeCollapse?:       RegimeCollapseInput;
  executionSabotage?:    ExecutionSabotageInput;
  behavioralStress?:     BehavioralStressInput;
  contradictionTest?:    ContradictionTestInput;
  overfitExposure?:      OverfitExposureInput;
  assumptionAudit?:      AssumptionAuditInput;
}
export interface StrategyAttackResult {
  candidateId: string;
  edgeFragility?:        EdgeFragilityResult;
  regimeCollapse?:       RegimeCollapseResult;
  executionSabotage?:    ExecutionSabotageResult;
  behavioralStress?:     BehavioralStressResult;
  contradictionTest?:    ContradictionTestResult;
  overfitExposure?:      OverfitExposureResult;
  assumptionAudit?:      AssumptionAuditResult;
  categoriesRun: string[];
}

export function runStrategyAttack(i: StrategyAttackInput): StrategyAttackResult {
  const categoriesRun: string[] = [];
  const r: StrategyAttackResult = { candidateId: i.candidateId, categoriesRun };
  if (i.edgeFragility)     { r.edgeFragility     = assessEdgeFragility(i.edgeFragility);         categoriesRun.push("edgeFragility"); }
  if (i.regimeCollapse)    { r.regimeCollapse    = assessRegimeCollapse(i.regimeCollapse);       categoriesRun.push("regimeCollapse"); }
  if (i.executionSabotage) { r.executionSabotage = assessExecutionSabotage(i.executionSabotage); categoriesRun.push("executionSabotage"); }
  if (i.behavioralStress)  { r.behavioralStress  = assessBehavioralStress(i.behavioralStress);   categoriesRun.push("behavioralStress"); }
  if (i.contradictionTest) { r.contradictionTest = assessContradictionTolerance(i.contradictionTest); categoriesRun.push("contradictionTest"); }
  if (i.overfitExposure)   { r.overfitExposure   = assessOverfitExposure(i.overfitExposure);     categoriesRun.push("overfitExposure"); }
  if (i.assumptionAudit)   { r.assumptionAudit   = auditAssumptions(i.assumptionAudit);          categoriesRun.push("assumptionAudit"); }
  return r;
}
