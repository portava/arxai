// Continuous certification (Blueprint Part II #56) — coded review periods.
//
// docs/CERTIFICATIONS.md records WHAT is certified and by what evidence, and
// its Article IV note says authority "expires unless the evidence remains
// current" — but until this contract, currency was a human convention: nothing
// coded knew when a certification lapsed, so nothing reduced authority when
// one did. This module is the coded register: each certification carries the
// date its evidence was produced and a review period, and the three
// enforcement seams below consult it at act time.
//
// AUTHORITY DIRECTION (inviolable, same rule as recovery probation):
//   * A LAPSE can only ever REDUCE authority — refuse a venue send, refuse a
//     promotion, refuse a kill-switch release. Nothing here grants anything.
//   * RECERTIFICATION is never automatic. The only way a lapsed entry becomes
//     current again is re-running the evidence (the certify harnesses / the
//     suites named in docs/CERTIFICATIONS.md) and updating `certifiedAtIso`
//     here in a reviewed change under an owner ruling — the same amendment
//     shape as the Capital Constitution guard's pinned headings.
//
// ENFORCEMENT SEAMS (the consumers of this register):
//   * BROKER   → guidedExecutionService refuses a venue-permitting dispatch
//                (TIER_1/TIER_2) while any BROKER certification is lapsed.
//                TIER_0 dry-run keeps working: the dry-run floor is exactly
//                what a lapsed venue certification reduces you to.
//   * MODEL    → edgePromotion.evaluatePromotion refuses EVERY promotion rung
//                while any MODEL certification is lapsed (existing edges keep
//                their earned rung; nothing new climbs).
//   * RECOVERY → the kill-switch release doorway adds a violation while any
//                RECOVERY certification is lapsed (the switch stays engaged —
//                an unproven recovery procedure may not be relied on).
//
// FAIL-CLOSED SEMANTICS: a malformed date in the register evaluates as
// LAPSED with a typed reason, never as current. A certification we cannot
// read is a certification we do not have.
//
// Pure and clock-injected: every evaluator takes `now` from the caller, so
// drills and tests pin time instead of racing the wall clock.

export const CERTIFICATION_KINDS = ["BROKER", "MODEL", "RECOVERY"] as const;
export type CertificationKind = (typeof CERTIFICATION_KINDS)[number];

export interface CodedCertification {
  /** Stable id, referenced by drills and audit details. */
  id: string;
  kind: CertificationKind;
  /** What the evidence certifies, in one sentence. */
  subject: string;
  /** When the evidence was last produced (docs/CERTIFICATIONS.md dates). */
  certifiedAtIso: string;
  /** Days the evidence is considered current before it must be re-run. */
  reviewPeriodDays: number;
  /** Where the evidence and the re-run procedure live. */
  evidenceRef: string;
}

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The coded register. Dates come from docs/CERTIFICATIONS.md ("Verified:
 * 2026-08-27", Grade A run dates 2026-08-25/26). 90 days mirrors the quarterly
 * review the blueprint's continuous-certification capability asks for.
 *
 * AMENDING AN ENTRY (recertification) requires: (1) actually re-running the
 * evidence named in `evidenceRef`, (2) updating `certifiedAtIso` in a reviewed
 * change, (3) recording the re-run in docs/CERTIFICATIONS.md. Deleting an
 * entry requires an owner ruling — an inconvenient expiry is the feature.
 */
export const CODED_CERTIFICATIONS: readonly CodedCertification[] = [
  {
    id: "broker-deriv-transport-readonly",
    kind: "BROKER",
    subject: "Deriv new-API transport, read-only surfaces (Grade A, live venue evidence)",
    certifiedAtIso: "2026-08-25T00:00:00.000Z",
    reviewPeriodDays: 90,
    evidenceRef: "docs/CERTIFICATIONS.md — re-run certify:deriv-new-api / diagnose:deriv-new-api",
  },
  {
    id: "broker-deriv-demo-settlement",
    kind: "BROKER",
    subject: "Deriv demo buy → open → sell → venue-confirmed settlement + non-zero P/L reconciliation",
    certifiedAtIso: "2026-08-25T00:00:00.000Z",
    reviewPeriodDays: 90,
    evidenceRef: "docs/CERTIFICATIONS.md — Rulings 17/18 evidence harnesses",
  },
  {
    id: "model-validation-promotion-machinery",
    kind: "MODEL",
    subject: "Learning/validation stack: signed validation reports, edge promotion gate, shadow sample rules",
    certifiedAtIso: "2026-08-27T00:00:00.000Z",
    reviewPeriodDays: 90,
    evidenceRef: "docs/CERTIFICATIONS.md — Grade B/C re-run (test:edge-promotion, test:validation-factory)",
  },
  {
    id: "recovery-killswitch-release-probation",
    kind: "RECOVERY",
    subject: "Kill-switch cold-posture release doorway + graduated recovery probation arming",
    certifiedAtIso: "2026-08-27T00:00:00.000Z",
    reviewPeriodDays: 90,
    evidenceRef: "docs/CERTIFICATIONS.md — test:phase6-killswitch-release, test:recovery-probation",
  },
] as const;

export type CertificationStatus = "CURRENT" | "LAPSED";

export interface CertificationEvaluation {
  id: string;
  kind: CertificationKind;
  status: CertificationStatus;
  /** null when the certified date could not be parsed (which is LAPSED). */
  expiresAtMs: number | null;
  /** Human-readable reason; always present when LAPSED. */
  reason: string | null;
}

/**
 * Evaluate one certification at `now`. Total: a malformed date is LAPSED with
 * a typed reason (fail closed), never a throw and never CURRENT.
 */
export function evaluateCodedCertification(
  cert: CodedCertification,
  now: Date,
): CertificationEvaluation {
  const certifiedMs = Date.parse(cert.certifiedAtIso);
  if (!Number.isFinite(certifiedMs)) {
    return {
      id: cert.id, kind: cert.kind, status: "LAPSED", expiresAtMs: null,
      reason: `certifiedAtIso ${JSON.stringify(cert.certifiedAtIso)} is unreadable — an unreadable certification is not a certification`,
    };
  }
  if (!Number.isFinite(cert.reviewPeriodDays) || cert.reviewPeriodDays <= 0) {
    return {
      id: cert.id, kind: cert.kind, status: "LAPSED", expiresAtMs: null,
      reason: `reviewPeriodDays ${String(cert.reviewPeriodDays)} is invalid — a certification without a review period never earned one`,
    };
  }
  const expiresAtMs = certifiedMs + cert.reviewPeriodDays * DAY_MS;
  if (now.getTime() > expiresAtMs) {
    const lapsedDays = Math.floor((now.getTime() - expiresAtMs) / DAY_MS);
    return {
      id: cert.id, kind: cert.kind, status: "LAPSED", expiresAtMs,
      reason:
        `${cert.id} lapsed ${lapsedDays}d ago (certified ${cert.certifiedAtIso.slice(0, 10)}, ` +
        `review period ${cert.reviewPeriodDays}d) — recertify via ${cert.evidenceRef}`,
    };
  }
  return { id: cert.id, kind: cert.kind, status: "CURRENT", expiresAtMs, reason: null };
}

/**
 * All LAPSED certifications of one kind at `now`. The registry is injectable
 * so recertification drills exercise lapse → reduction → recert without
 * waiting for the real register to age.
 */
export function lapsedCertificationsOfKind(
  kind: CertificationKind,
  now: Date,
  registry: readonly CodedCertification[] = CODED_CERTIFICATIONS,
): CertificationEvaluation[] {
  return registry
    .filter((c) => c.kind === kind)
    .map((c) => evaluateCodedCertification(c, now))
    .filter((e) => e.status === "LAPSED");
}

/**
 * MODEL seam — reasons that refuse every promotion rung while a MODEL
 * certification is lapsed. Empty array = no model-certification objection.
 */
export function modelCertificationPromotionRefusals(
  now: Date,
  registry: readonly CodedCertification[] = CODED_CERTIFICATIONS,
): string[] {
  return lapsedCertificationsOfKind("MODEL", now, registry).map(
    (e) => `MODEL_CERTIFICATION_LAPSED: ${e.reason ?? e.id}`,
  );
}

/**
 * RECOVERY seam — extra kill-switch release violations while a RECOVERY
 * certification is lapsed. Blocking a release keeps the switch ENGAGED, which
 * is the reduce-only direction: an unproven recovery procedure may not be the
 * thing a release relies on.
 */
export function recoveryCertificationReleaseViolations(
  now: Date,
  registry: readonly CodedCertification[] = CODED_CERTIFICATIONS,
): string[] {
  return lapsedCertificationsOfKind("RECOVERY", now, registry).map(
    (e) => `recovery certification lapsed: ${e.reason ?? e.id}`,
  );
}

/**
 * BROKER seam — reasons that refuse a venue-permitting guided dispatch while
 * a BROKER certification is lapsed. The caller applies this ONLY when the
 * resolved tier permits a venue send: TIER_0 dry-run is the floor a lapse
 * reduces to, so the dry-run path itself must keep working.
 */
export function brokerCertificationDispatchRefusals(
  now: Date,
  registry: readonly CodedCertification[] = CODED_CERTIFICATIONS,
): string[] {
  return lapsedCertificationsOfKind("BROKER", now, registry).map(
    (e) => `BROKER_CERTIFICATION_LAPSED: ${e.reason ?? e.id}`,
  );
}
