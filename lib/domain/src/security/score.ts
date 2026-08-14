// ═══════════════════════════════════════════════════════════════════════════
// security/score.ts — pure weighted SECURITY_SCORE engine + band mapping.
//
// Honest degradation: a component that cannot be verified is treated as 0, not
// silently assumed secure. Critical-floor components (the ones that, if broken,
// mean the system is not safe regardless of the average) cap the band. An
// explicit lockdown forces the Lockdown band. Deterministic; no IO.
// ═══════════════════════════════════════════════════════════════════════════

import {
  SECURITY_SCORE_COMPONENTS,
  type SecurityBand,
  type SecurityScoreComponent,
  type SecurityScoreComponentInputs,
  type SecurityScoreResult,
} from "./types.js";

/** Weights sum to 1.0. Credentials/redaction/isolation carry the most weight. */
export const SECURITY_SCORE_WEIGHTS: Record<SecurityScoreComponent, number> = {
  rolePermissionIntegrity: 0.12,
  secretsProtected: 0.14,
  encryptionReadiness: 0.08,
  commandIntegrity: 0.09,
  auditRedaction: 0.12,
  tokenSafety: 0.11,
  dataAccessIsolation: 0.13,
  replayProtection: 0.06,
  sessionSafety: 0.06,
  secureTransport: 0.04,
  exportSafety: 0.05,
};

/**
 * Components that, if 0 or unverifiable, mean we cannot honestly call the system
 * secure — the band is capped at Critical even if the weighted average is high.
 */
export const CRITICAL_FLOOR_COMPONENTS: ReadonlySet<SecurityScoreComponent> =
  new Set<SecurityScoreComponent>([
    "secretsProtected",
    "auditRedaction",
    "tokenSafety",
    "dataAccessIsolation",
  ]);

/** Lower-bound score thresholds for each band (descending). */
export const SECURITY_BAND_THRESHOLDS: ReadonlyArray<[SecurityBand, number]> = [
  ["Secure", 90],
  ["Healthy", 80],
  ["Watch", 65],
  ["Degraded", 45],
  ["Critical", 25],
  ["Lockdown", 0],
];

function clamp0to100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/** Map a 0–100 score to its band (ignores floors/lockdown). */
export function securityBandForScore(score: number): SecurityBand {
  const s = clamp0to100(score);
  for (const [band, min] of SECURITY_BAND_THRESHOLDS) {
    if (s >= min) return band;
  }
  return "Lockdown";
}

/** Rank bands so we can take the worse (lower-security) of two. */
const BAND_RANK: Record<SecurityBand, number> = {
  Secure: 6,
  Healthy: 5,
  Watch: 4,
  Degraded: 3,
  Critical: 2,
  Lockdown: 1,
};

function worseBand(a: SecurityBand, b: SecurityBand): SecurityBand {
  return BAND_RANK[a] <= BAND_RANK[b] ? a : b;
}

export interface ComputeSecurityScoreOptions {
  /** Force the Lockdown band regardless of the computed score. */
  lockdownTriggered?: boolean;
  /** If a critical-floor component is 0/unknown, cap the band (default true). */
  criticalFloorCapsBand?: boolean;
}

/**
 * Compute the weighted SECURITY_SCORE and resolve the state band.
 *
 * Unknown (undefined/null/non-finite) components are degraded to 0 and listed
 * in `unknownComponents`. The score is a weighted average over ALL components
 * (unknown contributes 0), so missing signals pull the score DOWN — never up.
 */
export function computeSecurityScore(
  inputs: SecurityScoreComponentInputs,
  options: ComputeSecurityScoreOptions = {},
): SecurityScoreResult {
  const { lockdownTriggered = false, criticalFloorCapsBand = true } = options;

  const componentScores = {} as Record<SecurityScoreComponent, number>;
  const unknownComponents: SecurityScoreComponent[] = [];
  const reasons: string[] = [];

  let weightedSum = 0;
  for (const component of SECURITY_SCORE_COMPONENTS) {
    const raw = inputs[component];
    const known = typeof raw === "number" && Number.isFinite(raw);
    const value = known ? clamp0to100(raw as number) : 0;
    componentScores[component] = value;
    if (!known) unknownComponents.push(component);
    weightedSum += value * SECURITY_SCORE_WEIGHTS[component];
  }

  const score = Math.round(clamp0to100(weightedSum));
  let band = securityBandForScore(score);

  // Critical-floor: any critical component at 0 caps the band at Critical.
  let criticalFloorHit = false;
  if (criticalFloorCapsBand) {
    for (const component of CRITICAL_FLOOR_COMPONENTS) {
      if (componentScores[component] <= 0) {
        criticalFloorHit = true;
        band = worseBand(band, "Critical");
        const unknown = unknownComponents.includes(component);
        reasons.push(
          unknown
            ? `${labelFor(component)} could not be verified — treated as not protected.`
            : `${labelFor(component)} is failing.`,
        );
      }
    }
  }

  if (unknownComponents.length > 0 && !criticalFloorHit) {
    reasons.push(
      `${unknownComponents.length} security signal(s) could not be verified and were scored conservatively.`,
    );
  }

  let lockdownForced = false;
  if (lockdownTriggered) {
    lockdownForced = true;
    band = "Lockdown";
    reasons.push("Security lockdown is active — sensitive surfaces fail closed.");
  }

  if (reasons.length === 0) {
    reasons.push(`All security signals verified; posture is ${band.toLowerCase()}.`);
  }

  return {
    score,
    band,
    componentScores,
    unknownComponents,
    criticalFloorHit,
    lockdownForced,
    reasons,
  };
}

/** Plain-English, token-free label for a component (for reasons/UI later). */
export function labelFor(component: SecurityScoreComponent): string {
  const map: Record<SecurityScoreComponent, string> = {
    rolePermissionIntegrity: "Role & permission integrity",
    secretsProtected: "Secret protection",
    encryptionReadiness: "Encryption readiness",
    commandIntegrity: "Command integrity",
    auditRedaction: "Audit redaction",
    tokenSafety: "Token safety",
    dataAccessIsolation: "Per-user data isolation",
    replayProtection: "Replay protection",
    sessionSafety: "Session safety",
    secureTransport: "Secure transport",
    exportSafety: "Export safety",
  };
  return map[component];
}
