// ═══════════════════════════════════════════════════════════════════════════
// Continuous Validation — pure. Master HEARTBEAT engine. Combines outputs
// from confidenceHealth, strategyTrust, strategyQuarantine, validationMemory,
// systemHealth, metaValidation, and an optional liveSanityCheck into an
// overall continuous verdict + permissions snapshot.
//
// Decision priority (single direction; never bypassable):
//   1. systemHealth.status === CRITICAL → FREEZE_SYSTEM (everyone)
//   2. quarantine.nextState === RETIRED → RETIRE
//   3. quarantine.nextState === RESTRICTED → QUARANTINE (no new entries)
//   4. confidenceHealth.status === UNRELIABLE OR
//      trust.trustScore01 < 0.40 OR
//      memory.persistentRiskFactors.length >= 2 → QUARANTINE
//   5. quarantine.nextState === SHADOW OR
//      confidenceHealth.status === OVERCONFIDENT OR
//      systemHealth.status === DEGRADED OR
//      meta.recommendation === TIGHTEN_VALIDATION → RESTRICT
//   6. liveSanityCheck.allow === false (when supplied) → RESTRICT
//   7. else → CONTINUE
// ═══════════════════════════════════════════════════════════════════════════

import type { ConfidenceHealthResult }    from "./confidenceHealth.engine";
import type { StrategyTrustResult }       from "./strategyTrust.engine";
import type { LiveSanityCheckResult }     from "./liveSanityCheck.engine";
import type { EvidenceDecayResult }       from "./evidenceDecay.engine";
import type { StrategyQuarantineResult }  from "./strategyQuarantine.engine";
import type { ValidationMemoryResult }    from "./validationMemory.engine";
import type { SystemHealthResult }        from "./systemHealth.engine";
import type { MetaValidationResult }      from "./metaValidation.engine";

export type ContinuousVerdict =
  | "CONTINUE"
  | "RESTRICT"
  | "QUARANTINE"
  | "RETIRE"
  | "FREEZE_SYSTEM";

export interface ContinuousPermissions {
  canEnterNewTrades: boolean;
  canHoldExisting: boolean;
  canIncreaseSize: boolean;
}

export interface ContinuousValidationInput {
  candidateId: string;
  trust: StrategyTrustResult;
  confidenceHealth: ConfidenceHealthResult;
  systemHealth: SystemHealthResult;
  quarantine: StrategyQuarantineResult;
  memory: ValidationMemoryResult;
  metaValidation: MetaValidationResult;
  liveSanityCheck: LiveSanityCheckResult;
  evidenceDecay: EvidenceDecayResult;
  // Below this ratio, the strategy's evidence base is mostly stale and the
  // immune system raises a restriction alert. Default 0.30.
  staleEvidenceRatioBelow01?: number;
}
export interface ContinuousValidationResult {
  candidateId: string;
  verdict: ContinuousVerdict;
  permissions: ContinuousPermissions;
  immuneAlerts: string[];
  reasons: string[];
  inputs: {
    trustScore01: number;
    trustGrade: string;
    confidenceStatus: string;
    confidenceHealthScore01: number;
    quarantineState: string;
    persistentRiskCount: number;
    systemHealthStatus: string;
    systemHealthScore01: number;
    metaRecommendation: string;
    sanityAllow: boolean;
    decayedEvidenceRatio01: number;
  };
  plainEnglishExplanation: string;
}

function permissionsFor(v: ContinuousVerdict): ContinuousPermissions {
  switch (v) {
    case "CONTINUE":      return { canEnterNewTrades: true,  canHoldExisting: true,  canIncreaseSize: true  };
    case "RESTRICT":      return { canEnterNewTrades: true,  canHoldExisting: true,  canIncreaseSize: false };
    case "QUARANTINE":    return { canEnterNewTrades: false, canHoldExisting: true,  canIncreaseSize: false };
    case "RETIRE":        return { canEnterNewTrades: false, canHoldExisting: false, canIncreaseSize: false };
    case "FREEZE_SYSTEM": return { canEnterNewTrades: false, canHoldExisting: true,  canIncreaseSize: false };
  }
}

export function runContinuousValidation(
  i: ContinuousValidationInput,
): ContinuousValidationResult {
  const reasons: string[] = [];
  const alerts: string[] = [];
  let verdict: ContinuousVerdict;

  if (i.systemHealth.status === "CRITICAL") {
    verdict = "FREEZE_SYSTEM";
    alerts.push("SYSTEM_HEALTH_CRITICAL");
    reasons.push("system health is CRITICAL — freeze new entries platform-wide");
  } else if (i.quarantine.nextState === "RETIRED") {
    verdict = "RETIRE";
    alerts.push("QUARANTINE_RETIRED");
    reasons.push("quarantine engine reports RETIRED — strategy is terminal");
  } else if (i.quarantine.nextState === "RESTRICTED") {
    verdict = "QUARANTINE";
    alerts.push("QUARANTINE_RESTRICTED");
    reasons.push("quarantine engine reports RESTRICTED — entries denied");
  } else if (i.confidenceHealth.status === "UNRELIABLE"
          || i.trust.trustScore01 < 0.40
          || i.memory.persistentRiskFactors.length >= 2) {
    verdict = "QUARANTINE";
    if (i.confidenceHealth.status === "UNRELIABLE") alerts.push("CONFIDENCE_UNRELIABLE");
    if (i.trust.trustScore01 < 0.40)                alerts.push("TRUST_FALLEN_BELOW_QUARANTINE");
    if (i.memory.persistentRiskFactors.length >= 2) alerts.push("PERSISTENT_RISK_FACTORS");
    reasons.push("confidence/trust/memory triggered quarantine");
  } else if (i.quarantine.nextState === "SHADOW"
          || i.confidenceHealth.status === "OVERCONFIDENT"
          || i.systemHealth.status === "DEGRADED"
          || i.metaValidation.recommendation === "TIGHTEN_VALIDATION"
          || !i.liveSanityCheck.allow
          || i.evidenceDecay.decayedRatio01 < (i.staleEvidenceRatioBelow01 ?? 0.30)) {
    verdict = "RESTRICT";
    if (i.quarantine.nextState === "SHADOW")                              alerts.push("SHADOW_OPERATION");
    if (i.confidenceHealth.status === "OVERCONFIDENT")                    alerts.push("OVERCONFIDENCE_DRIFT");
    if (i.systemHealth.status === "DEGRADED")                             alerts.push("SYSTEM_DEGRADED");
    if (i.metaValidation.recommendation === "TIGHTEN_VALIDATION")         alerts.push("META_VALIDATOR_TIGHTEN");
    if (!i.liveSanityCheck.allow)                                         alerts.push("LIVE_SANITY_BLOCK");
    if (i.evidenceDecay.decayedRatio01 < (i.staleEvidenceRatioBelow01 ?? 0.30))
                                                                          alerts.push("STALE_EVIDENCE_BASE");
    reasons.push("at least one moderate immune signal — restrict size & growth");
  } else {
    verdict = "CONTINUE";
    reasons.push("all immune signals healthy — continue with full permissions");
  }

  const sanityAllow = i.liveSanityCheck.allow;
  const result: ContinuousValidationResult = {
    candidateId: i.candidateId,
    verdict,
    permissions: permissionsFor(verdict),
    immuneAlerts: alerts,
    reasons,
    inputs: {
      trustScore01: i.trust.trustScore01,
      trustGrade: i.trust.trustGrade,
      confidenceStatus: i.confidenceHealth.status,
      confidenceHealthScore01: i.confidenceHealth.healthScore01,
      quarantineState: i.quarantine.nextState,
      persistentRiskCount: i.memory.persistentRiskFactors.length,
      systemHealthStatus: i.systemHealth.status,
      systemHealthScore01: i.systemHealth.systemHealthScore01,
      metaRecommendation: i.metaValidation.recommendation,
      sanityAllow,
      decayedEvidenceRatio01: i.evidenceDecay.decayedRatio01,
    },
    plainEnglishExplanation: buildPlainEnglish(verdict, alerts, i),
  };
  return result;
}

function buildPlainEnglish(
  verdict: ContinuousVerdict,
  alerts: string[],
  i: ContinuousValidationInput,
): string {
  const parts: string[] = [];
  parts.push(`Continuous verdict: ${verdict}.`);
  parts.push(`Trust ${(i.trust.trustScore01 * 100).toFixed(0)}% (${i.trust.trustGrade}); confidence ${i.confidenceHealth.status} (${(i.confidenceHealth.healthScore01 * 100).toFixed(0)}%); quarantine ${i.quarantine.nextState}; system ${i.systemHealth.status}.`);
  if (alerts.length > 0) parts.push(`Active immune alerts: ${alerts.join(", ")}.`);
  if (i.memory.persistentRiskFactors.length > 0) {
    parts.push(`Persistent risks: ${i.memory.persistentRiskFactors.join(", ")}.`);
  }
  return parts.join(" ");
}
