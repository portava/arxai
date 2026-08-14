// ═══════════════════════════════════════════════════════════════════════════
// Adversarial Validation — pure. Master decision engine. Takes the seven
// per-category sub-engine results and produces:
//   • fragilityScore (overall, weighted)
//   • robustnessScore (= 1 - fragilityScore)
//   • adversarialFailurePoints — every category × breaking attack, with text
//   • per-category subscores expected by the spec
//   • recommendedRestrictions (deduped, derived from each weak category)
//   • a decision: PROMOTE | RESTRICT | DEMOTE | RETIRE
//   • a plain-English explanation of exactly what broke, and why
//
// Hard rules:
//   • Robustness < 0.30 OR ≥3 categories with fragility > 0.6 → RETIRE.
//   • Robustness < 0.50 OR ≥2 categories with fragility > 0.6 → DEMOTE.
//   • Robustness < 0.70 OR ANY breaking attack → RESTRICT (with reasons
//     and recommended restrictions). High profit cannot bypass this rule.
//   • Otherwise → PROMOTE.
//   • Severe assumption violation (severity ≥ 0.7) → at least RESTRICT.
// ═══════════════════════════════════════════════════════════════════════════

import type { EdgeFragilityResult }      from "./edgeFragility.engine";
import type { RegimeCollapseResult }     from "./regimeCollapse.engine";
import type { ExecutionSabotageResult }  from "./executionSabotage.engine";
import type { BehavioralStressResult }   from "./behavioralStress.engine";
import type { ContradictionTestResult }  from "./contradictionTest.engine";
import type { OverfitExposureResult }    from "./overfitExposure.engine";
import type { AssumptionAuditResult }    from "./assumptionAudit.engine";

export type AdversarialDecision = "PROMOTE" | "RESTRICT" | "DEMOTE" | "RETIRE";

export interface AdversarialValidationInput {
  candidateId: string;
  edgeFragility?:        EdgeFragilityResult;
  regimeCollapse?:       RegimeCollapseResult;
  executionSabotage?:    ExecutionSabotageResult;
  behavioralStress?:     BehavioralStressResult;
  contradictionTest?:    ContradictionTestResult;
  overfitExposure?:      OverfitExposureResult;
  assumptionAudit?:      AssumptionAuditResult;
}

export interface AdversarialFailurePoint {
  category: string;
  attackKind: string;
  degradationPct01: number;
  perturbedExpectancyR: number;
  description?: string;
}

export interface AdversarialValidationResult {
  candidateId: string;
  decision: AdversarialDecision;
  allowedToPromote: boolean;
  fragilityScore01: number;
  robustnessScore01: number;
  // Per-category subscores expected by the spec
  edgeFragilityScore01: number;
  regimeCollapseRisk01: number;
  executionFragilityScore01: number;
  behavioralFragilityScore01: number;
  contradictionToleranceScore01: number;
  overfitExposureScore01: number;
  assumptionViolationSeverity01: number;
  adversarialFailurePoints: AdversarialFailurePoint[];
  recommendedRestrictions: string[];
  weakestCategory: string;
  plainEnglishExplanation: string;
  reasons: string[];
  blockers: string[];
}

// Restriction labels per category — a category triggers its restriction
// when its fragility crosses the WEAK threshold (0.4) or when it has any
// breaking attack.
const CATEGORY_RESTRICTIONS: Record<string, string> = {
  edgeFragility:       "PARAM_DRIFT_GUARD",
  regimeCollapse:      "REQUIRES_REGIME_GATE",
  executionSabotage:   "REQUIRES_HIGH_QUALITY_BROKER",
  behavioralStress:    "REQUIRES_BEHAVIORAL_GATE",
  contradictionTest:   "REQUIRES_CONSENSUS_AGENTS",
  overfitExposure:     "REQUIRES_OOS_REVALIDATION",
};

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
function dedupe<T>(arr: T[]): T[] {
  const s = new Set<T>(); const out: T[] = [];
  for (const x of arr) if (!s.has(x)) { s.add(x); out.push(x); }
  return out;
}

export function decideAdversarialValidation(
  i: AdversarialValidationInput,
): AdversarialValidationResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const restrictions: string[] = [];
  const failurePoints: AdversarialFailurePoint[] = [];

  // Per-category fragility scores (0 if not run).
  const ef = i.edgeFragility?.fragilityScore01     ?? 0;
  const rc = i.regimeCollapse?.fragilityScore01    ?? 0;
  const xs = i.executionSabotage?.fragilityScore01 ?? 0;
  const bs = i.behavioralStress?.fragilityScore01  ?? 0;
  const ct = i.contradictionTest?.fragilityScore01 ?? 0;
  const ox = i.overfitExposure?.fragilityScore01   ?? 0;
  const av = i.assumptionAudit?.violationSeverity01 ?? 0;

  // Weighted overall fragility — overfit exposure and regime collapse get
  // the heaviest weight because they predict catastrophic live failures.
  const W = {
    edgeFragility: 0.15, regimeCollapse: 0.20,
    executionSabotage: 0.15, behavioralStress: 0.15,
    contradictionTest: 0.10, overfitExposure: 0.20,
    assumptionAudit: 0.05,
  };
  let weightedSum = 0; let weightTotal = 0;
  const ran: Array<[string, number, number]> = []; // [name, score, weight]
  if (i.edgeFragility)     { weightedSum += ef * W.edgeFragility;     weightTotal += W.edgeFragility;     ran.push(["edgeFragility", ef, W.edgeFragility]); }
  if (i.regimeCollapse)    { weightedSum += rc * W.regimeCollapse;    weightTotal += W.regimeCollapse;    ran.push(["regimeCollapse", rc, W.regimeCollapse]); }
  if (i.executionSabotage) { weightedSum += xs * W.executionSabotage; weightTotal += W.executionSabotage; ran.push(["executionSabotage", xs, W.executionSabotage]); }
  if (i.behavioralStress)  { weightedSum += bs * W.behavioralStress;  weightTotal += W.behavioralStress;  ran.push(["behavioralStress", bs, W.behavioralStress]); }
  if (i.contradictionTest) { weightedSum += ct * W.contradictionTest; weightTotal += W.contradictionTest; ran.push(["contradictionTest", ct, W.contradictionTest]); }
  if (i.overfitExposure)   { weightedSum += ox * W.overfitExposure;   weightTotal += W.overfitExposure;   ran.push(["overfitExposure", ox, W.overfitExposure]); }
  if (i.assumptionAudit)   { weightedSum += av * W.assumptionAudit;   weightTotal += W.assumptionAudit;   ran.push(["assumptionAudit", av, W.assumptionAudit]); }

  const fragility = weightTotal > 0 ? clamp01(weightedSum / weightTotal) : 0.5;
  const robustness = clamp01(1 - fragility);

  // Collect failure points from every category that actually ran.
  function collect(category: string, items?: ReadonlyArray<{ kind: string; perturbedExpectancyR: number; degradationPct01: number; breaking: boolean; description?: string }>) {
    if (!items) return;
    for (const a of items) {
      if (a.breaking) {
        failurePoints.push({
          category, attackKind: a.kind,
          degradationPct01: a.degradationPct01,
          perturbedExpectancyR: a.perturbedExpectancyR,
          description: a.description,
        });
      }
    }
  }
  collect("edgeFragility",     i.edgeFragility?.attacks);
  collect("regimeCollapse",    i.regimeCollapse?.scenarios);
  collect("executionSabotage", i.executionSabotage?.scenarios);
  collect("behavioralStress",  i.behavioralStress?.scenarios);
  collect("contradictionTest", i.contradictionTest?.scenarios);
  collect("overfitExposure",   i.overfitExposure?.probes);

  // Categories with fragility > 0.6 are "weak"; > 0.4 trigger RESTRICT.
  const heavilyWeak = ran.filter(([, s]) => s > 0.6).map(([n]) => n);
  const weak = ran.filter(([, s]) => s > 0.4).map(([n]) => n);

  // Category-driven recommended restrictions: any category that is "weak"
  // OR has at least one breaking attack contributes its restriction. The
  // breaking-attack trigger guarantees that a single catastrophic failure
  // (e.g. broker instability) is mitigated even when the AVERAGE category
  // fragility stays below the 0.4 weak threshold.
  const breakingByCategory = new Map<string, number>();
  for (const fp of failurePoints) {
    breakingByCategory.set(fp.category, (breakingByCategory.get(fp.category) ?? 0) + 1);
  }
  for (const [name, score] of ran) {
    if (!CATEGORY_RESTRICTIONS[name]) continue;
    const breaking = breakingByCategory.get(name) ?? 0;
    if (score > 0.4 || breaking > 0) restrictions.push(CATEGORY_RESTRICTIONS[name]);
  }
  if (i.assumptionAudit) {
    for (const r of i.assumptionAudit.recommendedRestrictions) restrictions.push(r);
    if (i.assumptionAudit.violationSeverity01 >= 0.7) {
      blockers.push(`SEVERE_ASSUMPTION_VIOLATIONS: ${i.assumptionAudit.assumptionsViolated.join(", ")}`);
    }
  }

  // Decision tree (single direction; never bypassable by profit alone).
  let decision: AdversarialDecision;
  if (robustness < 0.30 || heavilyWeak.length >= 3) {
    decision = "RETIRE";
    reasons.push(`robustness ${robustness.toFixed(2)} < 0.30 OR ${heavilyWeak.length} severely weak categories — retire`);
  } else if (robustness < 0.50 || heavilyWeak.length >= 2) {
    decision = "DEMOTE";
    reasons.push(`robustness ${robustness.toFixed(2)} < 0.50 OR ${heavilyWeak.length} severely weak categories — demote`);
  } else if (robustness < 0.70 || failurePoints.length > 0 || weak.length > 0
          || (i.assumptionAudit?.violationSeverity01 ?? 0) >= 0.7) {
    decision = "RESTRICT";
    reasons.push(`robustness ${robustness.toFixed(2)} < 0.70 OR ${failurePoints.length} breaking attack(s) OR ${weak.length} weak categor${weak.length === 1 ? "y" : "ies"} — restrict`);
  } else {
    decision = "PROMOTE";
    reasons.push(`robustness ${robustness.toFixed(2)} ≥ 0.70 with no breaking attacks and no weak categories — promote`);
  }

  // Weakest category
  const weakest = ran.length > 0
    ? ran.reduce((w, e) => e[1] > w[1] ? e : w, ran[0]!)
    : ["none", 0, 0] as [string, number, number];

  // Plain-English explanation
  const plainEnglish = buildPlainEnglish({
    decision, fragility, robustness,
    failurePoints, weak, heavilyWeak,
    weakestCategory: weakest[0],
    weakestScore: weakest[1],
    assumption: i.assumptionAudit,
  });

  return {
    candidateId: i.candidateId,
    decision,
    allowedToPromote: decision === "PROMOTE",
    fragilityScore01: fragility,
    robustnessScore01: robustness,
    edgeFragilityScore01:          ef,
    regimeCollapseRisk01:          rc,
    executionFragilityScore01:     xs,
    behavioralFragilityScore01:    bs,
    contradictionToleranceScore01: clamp01(1 - ct),
    overfitExposureScore01:        ox,
    assumptionViolationSeverity01: av,
    adversarialFailurePoints: failurePoints,
    recommendedRestrictions: dedupe(restrictions),
    weakestCategory: weakest[0],
    plainEnglishExplanation: plainEnglish,
    reasons, blockers,
  };
}

function buildPlainEnglish(e: {
  decision: AdversarialDecision; fragility: number; robustness: number;
  failurePoints: AdversarialFailurePoint[];
  weak: string[]; heavilyWeak: string[];
  weakestCategory: string; weakestScore: number;
  assumption?: AssumptionAuditResult;
}): string {
  const parts: string[] = [];
  parts.push(`Adversarial robustness ${(e.robustness * 100).toFixed(0)}%, fragility ${(e.fragility * 100).toFixed(0)}%.`);
  switch (e.decision) {
    case "PROMOTE":
      parts.push(`Strategy survived every adversarial attack.`); break;
    case "RESTRICT":
      parts.push(`Strategy is profitable but fragile under stress and may only operate with restrictions.`);
      break;
    case "DEMOTE":
      parts.push(`Strategy fails too many adversarial scenarios — demote for re-validation.`);
      break;
    case "RETIRE":
      parts.push(`Strategy collapses under adversarial conditions and should be retired.`);
      break;
  }
  if (e.failurePoints.length > 0) {
    const top = e.failurePoints.slice().sort((a, b) => b.degradationPct01 - a.degradationPct01).slice(0, 3);
    parts.push(`Top failure points: ${top.map(p => `${p.category}/${p.attackKind} (${(p.degradationPct01 * 100).toFixed(0)}% deg)`).join("; ")}.`);
  }
  if (e.weakestCategory !== "none") {
    parts.push(`Weakest category: ${e.weakestCategory} (fragility ${(e.weakestScore * 100).toFixed(0)}%).`);
  }
  if (e.assumption && e.assumption.assumptionsViolated.length > 0) {
    parts.push(`Violated assumptions: ${e.assumption.assumptionsViolated.join(", ")}.`);
  }
  return parts.join(" ");
}
