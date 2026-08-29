// Edge promotion gate — the pure spine of R7 step 6.
//
// One rung at a time, evidence named in advance, refusal as the default:
//
//   RESEARCH ──(prereg hash + hash-verified validation report)──▶ SHADOW
//   SHADOW ───(shadowValidated + REAL durable sample ≥ n)───────▶ DEMO
//   DEMO ─────(adminApproved + full Part IV evidence package)───▶ LIVE_CANDIDATE
//   LIVE_CANDIDATE ──▶ (nothing — see below)
//   any ──(breaker fired)──▶ RETIRED   (immediate, one-way, never re-entered)
//
// WHAT THIS MODULE CANNOT DO
// --------------------------
// CONSTRAINT: `liveAllowed` is NEVER set true here — or anywhere in code. The
// last press on anything live-shaped belongs to the owner (the standing
// final-trigger rule for this system), so LIVE_CANDIDATE is this module's
// terminal rung and the only `liveAllowed` literal below is `false` (the
// retirement patch REVOKING it). A test pins this file to that constraint.
//
// WHY THE HASH IS RECOMPUTED, NOT TRUSTED
// ---------------------------------------
// The lib/validation factory hash-chains every SignedValidationReport so a
// result cannot be quietly restated later. This gate re-derives that hash from
// the stored report body and refuses on any mismatch — a report that does not
// recompute is not evidence, whatever its embedded hash claims.
//
// CONSTRAINT: @workspace/api-server does not (and this wave may not — every
// package.json is frozen) depend on @workspace/validation, so the factory's
// report types are mirrored here STRUCTURALLY, exactly as lib/discovery
// mirrors its ValidationPort locally. Fidelity to the real factory's
// canonicalisation (body key order, 10-decimal rounding, `${body}|${prevHash}`
// chaining — lib/validation/src/factory.ts `finalise`) is pinned by
// __qa__/edgePromotion.test.ts, which drives the REAL factory and asserts this
// verifier accepts its reports and rejects tampered ones.
//
// Pure: node:crypto and the pure @workspace/db/schema constants only. No DB,
// no clock (every timestamp is supplied), no randomness, nothing on the order
// path. UNKNOWN inputs refuse — an unverifiable promotion is a refused one.

import { createHash } from "node:crypto";
import { VERSION_GATES } from "@workspace/db/schema";
import {
  modelCertificationPromotionRefusals,
  type CodedCertification,
} from "@workspace/domain/safety-contracts/certificationExpiry";

// ── Statuses ──────────────────────────────────────────────────────────────────
// Mirrored from lib/db/src/schema/edgeLibrary.ts PRODUCTION_EDGE_STATUSES
// (importing it would ride on the schema-index registration this wave leaves
// to the coordinator). The QA test asserts the two lists are identical.
export const EDGE_STATUSES = [
  "RESEARCH",
  "SHADOW",
  "DEMO",
  "LIVE_CANDIDATE",
  "RETIRED",
] as const;
export type EdgeStatus = (typeof EDGE_STATUSES)[number];

// ── Part IV minimum evidence package ──────────────────────────────────────────
// Enumerated verbatim from docs/RESEARCH_OPERATING_SYSTEM.md, "Minimum
// evidence package". DEMO→LIVE_CANDIDATE requires EVERY field explicitly
// attested true; anything absent, false, or unknown refuses the transition.
export const MINIMUM_EVIDENCE_FIELDS = [
  "preregisteredHypothesis",  // preregistered hypothesis, decision target, falsification criteria
  "datasetProvenance",        // dataset provenance, hashes, time ranges, exclusions, data-quality report
  "assumptions",              // exact feature, label, cost and execution assumptions
  "sampleBoundaries",         // train, validation, walk-forward and final-holdout boundaries
  "resultMetrics",            // calibration, conservative EV, drawdown, tail, capacity, abstention results
  "sensitivity",              // sensitivity to parameters, latency, slippage, missed fills, missing data
  "ablationAndBaseline",      // ablation of every feature + minimum-intelligence baseline comparison
  "reproducibility",          // code commit, model artifact, configuration hash, deterministic replay result
  "shadowDemoEvidence",       // shadow/demo sample, broker behavior, reconciliation evidence
  "limitationsAndRollback",   // known limitations, unsupported regimes, breakers, expiry, rollback path
] as const;
export type MinimumEvidenceField = (typeof MINIMUM_EVIDENCE_FIELDS)[number];

// SHADOW→DEMO minimum REAL (non-synthetic) durable shadow sample. One number,
// owned by the registry gates — not a second constant that can drift.
export const MIN_REAL_SHADOW_SAMPLE: number = VERSION_GATES.MIN_SHADOW_SAMPLE;

const HEX64 = /^[0-9a-f]{64}$/;

// ── Structural mirrors of lib/validation factory types ───────────────────────
export interface ValidationThresholdsLike {
  minDsr: number;
  maxPbo: number;
}

export interface ValidationCandidateLike {
  key: string;
  verdict: "PASS" | "REJECT";
  // Full-precision in the live report; after a JSON/jsonb round trip a NaN
  // becomes null (JSON has no NaN). roundForHash maps null back to the "NaN"
  // string the factory's own rounding produces, so an honest round-tripped
  // report still verifies. Any OTHER non-finite (Infinity also nulls out in
  // JSON) fails verification — refusing is the correct failure mode.
  oosSharpe: number | null;
  dsr: number | null;
  pbo: number | null;
}

export interface SignedValidationReportLike {
  familyKey: string;
  nTrials: number;
  thresholds: ValidationThresholdsLike;
  candidates: ValidationCandidateLike[];
  reportHash: string;
  prevHash: string;
}

// ── Canonical hash recomputation (mirror of factory.ts `round`/`finalise`) ───
function roundForHash(x: number | null | undefined): number | string {
  if (x === null || x === undefined) return "NaN"; // jsonb round trip of NaN
  return Number.isFinite(x) ? Number(x.toFixed(10)) : String(x);
}

/**
 * Recompute the factory's report hash from the report body.
 *
 * The body is REBUILT here with the factory's literal key order (familyKey,
 * nTrials, thresholds{minDsr,maxPbo}, candidates[{key,verdict,oosSharpe,dsr,
 * pbo}]) rather than re-serialising the stored object — Postgres jsonb does
 * not preserve key order, so serialising the stored object as-is would fail
 * on every legitimate report. A report whose ORIGINAL thresholds object used
 * a different key order will fail verification; that is fail-closed, and the
 * factory's own DEFAULT_THRESHOLDS order is the one rebuilt here.
 */
export function computeReportHash(
  report: Omit<SignedValidationReportLike, "reportHash">,
): string {
  const body = {
    familyKey: report.familyKey,
    nTrials: report.nTrials,
    thresholds: {
      minDsr: report.thresholds.minDsr,
      maxPbo: report.thresholds.maxPbo,
    },
    candidates: report.candidates.map((c) => ({
      key: c.key,
      verdict: c.verdict,
      oosSharpe: roundForHash(c.oosSharpe),
      dsr: roundForHash(c.dsr),
      pbo: roundForHash(c.pbo),
    })),
  };
  return createHash("sha256")
    .update(`${JSON.stringify(body)}|${report.prevHash}`, "utf8")
    .digest("hex");
}

export interface ReportVerification {
  ok: boolean;
  reason: string | null;
}

/** Structural + hash-chain verification. Anything unverifiable refuses. */
export function verifyValidationReport(report: unknown): ReportVerification {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, reason: "REPORT_NOT_AN_OBJECT" };
  }
  const r = report as Record<string, unknown>;
  if (typeof r.familyKey !== "string" || r.familyKey.length === 0) {
    return { ok: false, reason: "REPORT_FAMILY_KEY_MISSING" };
  }
  if (typeof r.nTrials !== "number" || !Number.isFinite(r.nTrials)) {
    return { ok: false, reason: "REPORT_NTRIALS_MISSING" };
  }
  const th = r.thresholds as Record<string, unknown> | null | undefined;
  if (!th || typeof th !== "object" || typeof th.minDsr !== "number" || typeof th.maxPbo !== "number") {
    return { ok: false, reason: "REPORT_THRESHOLDS_MALFORMED" };
  }
  if (!Array.isArray(r.candidates)) {
    return { ok: false, reason: "REPORT_CANDIDATES_MISSING" };
  }
  for (const c of r.candidates as Array<Record<string, unknown>>) {
    if (
      !c || typeof c !== "object" ||
      typeof c.key !== "string" ||
      (c.verdict !== "PASS" && c.verdict !== "REJECT")
    ) {
      return { ok: false, reason: "REPORT_CANDIDATE_MALFORMED" };
    }
  }
  if (typeof r.prevHash !== "string" || !HEX64.test(r.prevHash)) {
    return { ok: false, reason: "REPORT_PREV_HASH_MALFORMED" };
  }
  if (typeof r.reportHash !== "string" || !HEX64.test(r.reportHash)) {
    return { ok: false, reason: "REPORT_HASH_MALFORMED" };
  }

  const recomputed = computeReportHash(r as unknown as SignedValidationReportLike);
  if (recomputed !== r.reportHash) {
    return { ok: false, reason: "REPORT_HASH_MISMATCH" };
  }
  return { ok: true, reason: null };
}

// ── The gate ──────────────────────────────────────────────────────────────────
/** The subset of a production_edges row the gate reads. */
export interface EdgeGateView {
  status: string;
  preregHash: string | null;
  validationReportJson: unknown;
  reportHash: string | null;
  shadowValidated: boolean;
  adminApproved: boolean;
  liveAllowed: boolean;
}

export interface PromotionEvidence {
  /**
   * Durable REAL shadow rows backing the edge — shadow_predictions rows whose
   * source is NOT SYNTHETIC_SIMULATOR. The caller attests the exclusion with
   * `syntheticExcluded`; a count assembled without the exclusion refuses.
   */
  sampleSize: number;
  syntheticExcluded: boolean;
  /** Part IV attestations; only used for DEMO→LIVE_CANDIDATE. */
  minimumEvidence?: Partial<Record<MinimumEvidenceField, boolean>>;
}

export interface PromotionDecision {
  allowed: boolean;
  from: string;
  /** Next rung when allowed; null when refused. */
  to: EdgeStatus | null;
  /** Every requirement that failed. Empty only when allowed. */
  reasons: string[];
  /**
   * Row patch for an allowed promotion. NEVER contains `liveAllowed` —
   * that field is out of this module's authority (owner-pressed).
   */
  patch: { status: EdgeStatus; promotedAt: Date } | null;
}

function refuse(from: string, reasons: string[]): PromotionDecision {
  return { allowed: false, from, to: null, reasons, patch: null };
}

/**
 * Evaluate the SINGLE next promotion rung for an edge. Pure — `now` is
 * supplied by the caller, and the decision is a value, not a side effect.
 */
export function evaluatePromotion(
  edge: EdgeGateView,
  evidence: PromotionEvidence,
  now: Date,
  /**
   * #56 Continuous certification — injectable register for recertification
   * drills. Omitted (production) = the CODED register. While any MODEL
   * certification is past its review period, EVERY rung refuses: existing
   * edges keep their earned status, but nothing new climbs on the say-so of a
   * validation stack whose own evidence has expired. Reduce-only by
   * construction — this check can only ADD refusals, never grant a rung.
   */
  certificationRegistry?: readonly CodedCertification[],
): PromotionDecision {
  const from = edge.status;

  const modelCertRefusals = modelCertificationPromotionRefusals(now, certificationRegistry);
  if (modelCertRefusals.length > 0) {
    return refuse(from, modelCertRefusals);
  }

  switch (from) {
    case "RESEARCH": {
      const reasons: string[] = [];
      if (!edge.preregHash) {
        reasons.push("PREREG_HASH_MISSING: hypothesis was not pre-registered before results");
      } else if (!HEX64.test(edge.preregHash)) {
        reasons.push("PREREG_HASH_MALFORMED: expected 64-hex sha256 from lib/discovery preRegister");
      }
      if (edge.validationReportJson === null || edge.validationReportJson === undefined) {
        reasons.push("VALIDATION_REPORT_MISSING: no lib/validation report attached");
      } else {
        const v = verifyValidationReport(edge.validationReportJson);
        if (!v.ok) {
          reasons.push(`VALIDATION_REPORT_UNVERIFIED: ${v.reason}`);
        } else {
          const report = edge.validationReportJson as SignedValidationReportLike;
          if (!edge.reportHash) {
            reasons.push("ROW_REPORT_HASH_MISSING: row carries no reportHash to cross-check");
          } else if (edge.reportHash !== report.reportHash) {
            reasons.push("ROW_REPORT_HASH_MISMATCH: row reportHash differs from the embedded report");
          }
          // A hash-valid report that certifies nothing earns nothing: the
          // default outcome of research is rejection, and only a PASS verdict
          // inside the hash-covered candidate set is evidence of an edge.
          if (!report.candidates.some((c) => c.verdict === "PASS")) {
            reasons.push("NO_PASSING_CANDIDATE: the verified report contains no PASS verdict");
          }
        }
      }
      if (reasons.length > 0) return refuse(from, reasons);
      return { allowed: true, from, to: "SHADOW", reasons: [], patch: { status: "SHADOW", promotedAt: now } };
    }

    case "SHADOW": {
      const reasons: string[] = [];
      if (edge.shadowValidated !== true) {
        reasons.push("SHADOW_NOT_VALIDATED: shadowValidated is not true");
      }
      if (evidence.syntheticExcluded !== true) {
        reasons.push(
          "SYNTHETIC_NOT_EXCLUDED: sample was not attested free of SYNTHETIC_SIMULATOR rows — synthetic rows are not market evidence",
        );
      }
      if (!Number.isInteger(evidence.sampleSize) || evidence.sampleSize < MIN_REAL_SHADOW_SAMPLE) {
        reasons.push(
          `REAL_SHADOW_SAMPLE_TOO_SMALL: ${String(evidence.sampleSize)} < ${MIN_REAL_SHADOW_SAMPLE} durable real shadow rows`,
        );
      }
      if (reasons.length > 0) return refuse(from, reasons);
      return { allowed: true, from, to: "DEMO", reasons: [], patch: { status: "DEMO", promotedAt: now } };
    }

    case "DEMO": {
      const reasons: string[] = [];
      if (edge.adminApproved !== true) {
        reasons.push("ADMIN_NOT_APPROVED: adminApproved is not true");
      }
      for (const field of MINIMUM_EVIDENCE_FIELDS) {
        // Absent and false are the same refusal: unattested evidence is
        // missing evidence (Part IV is a package, not a menu).
        if (evidence.minimumEvidence?.[field] !== true) {
          reasons.push(`MINIMUM_EVIDENCE_MISSING: ${field}`);
        }
      }
      if (reasons.length > 0) return refuse(from, reasons);
      return {
        allowed: true,
        from,
        to: "LIVE_CANDIDATE",
        reasons: [],
        // CONSTRAINT: the patch advances status ONLY. liveAllowed stays false
        // — flipping it is the owner's press, out of code's authority.
        patch: { status: "LIVE_CANDIDATE", promotedAt: now },
      };
    }

    case "LIVE_CANDIDATE":
      return refuse(from, [
        "TERMINAL_FOR_CODE: LIVE_CANDIDATE→live is the owner's press; no code path sets liveAllowed",
      ]);

    case "RETIRED":
      return refuse(from, ["RETIRED_IS_TERMINAL: retirement is one-way; a retired edge never promotes"]);

    default:
      // Fail-closed: a status this gate does not recognise promotes nothing.
      return refuse(from, [`UNKNOWN_STATUS: "${from}" is not a recognised rung — refusing`]);
  }
}

// ── Retirement ────────────────────────────────────────────────────────────────
export interface RetirementDecision {
  retired: boolean;
  /**
   * Row patch when the breaker retires the edge. The ONLY liveAllowed literal
   * this module writes — and it is `false`: retirement REVOKES; nothing here
   * grants.
   */
  patch: { status: "RETIRED"; retiredAt: Date; liveAllowed: false } | null;
  reason: string;
}

/**
 * Retirement is immediate and one-way. A fired breaker retires the edge NOW —
 * no grace period, no appeal path in code. An already-retired edge stays
 * retired (idempotent; retiredAt is never rewritten), and nothing in this
 * module — or anywhere — transitions out of RETIRED.
 */
export function applyRetirement(
  edge: EdgeGateView,
  breakerFired: boolean,
  now: Date,
): RetirementDecision {
  if (edge.status === "RETIRED") {
    return { retired: true, patch: null, reason: "ALREADY_RETIRED: one-way; retiredAt is not rewritten" };
  }
  if (!breakerFired) {
    return { retired: false, patch: null, reason: "NO_BREAKER: nothing to act on" };
  }
  return {
    retired: true,
    patch: { status: "RETIRED", retiredAt: now, liveAllowed: false },
    reason: "BREAKER_FIRED: retired immediately",
  };
}
