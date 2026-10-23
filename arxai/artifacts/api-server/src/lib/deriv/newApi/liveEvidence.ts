// Live-evidence capture for the Deriv execution path.
//
// PURPOSE: resolve venue-dependent unknowns that no schema or fixture can
// settle, by recording what Deriv ACTUALLY sends — raw frame plus ARX's
// normalized reading of it — in a form a later fixture can be generated from
// without anyone retyping a venue response by hand.
//
// THIS MODULE CANNOT SEND AN ORDER. Capability B (demo execution) is declared
// and specified below, but has NO executable path here: the tier refuses with
// CAPABILITY_NOT_IMPLEMENTED, and a source pin fails if a buy/sell mapper is
// ever imported. That is deliberate — this change must not introduce any path
// capable of placing a trade, so the instrument ships able to do the read-only
// half and the trading half stays a separate, reviewable decision.
//
// EPISTEMIC MODEL, unchanged from DERIV_EXECUTION_STATE_MODEL.md: every record
// is VENUE-PROVEN (the venue sent it), INFERRED (ARX concluded it), or UNKNOWN.
// Absence of evidence is never recorded as evidence of absence, and a shape
// ARX cannot read stays UNRESOLVED rather than being coerced into a reading.

import { redactSecrets, type DerivNewApiConfig } from "./restClient.js";

/** Capability tiers, in ascending order of consequence. */
export const EVIDENCE_TIERS = {
  /** Probes that CANNOT create or close a position. No order risk. */
  READ_ONLY: "READ_ONLY",
  /** Demo-account execution. NOT IMPLEMENTED here — see the header. */
  DEMO_EXECUTION: "DEMO_EXECUTION",
} as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[keyof typeof EVIDENCE_TIERS];

/** Exact operator intent, per tier. Unmistakable by construction: nobody types
 *  either of these by accident, and neither is a truthy flag or a default. */
export const EVIDENCE_AUTHORIZATION = {
  READ_ONLY: "CAPTURE-READ-ONLY-VENUE-EVIDENCE",
  DEMO_EXECUTION: "CAPTURE-DEMO-EXECUTION-EVIDENCE",
} as const;

export class EvidenceRefusal extends Error {}

/** One observed frame. `raw` is post-redaction, always. */
export interface EvidenceFrame {
  direction: "out" | "in";
  /** Redacted frame text. */
  raw: string;
  /** The req_id ARX issued, when the frame carries one. */
  reqId: number | null;
  /** The op ARX ISSUED under that id — never one read off the frame. */
  op: string | null;
  atMs: number;
}

/**
 * One probe: what was asked, what came back, and how ARX read it.
 *
 * `wireWritten` is recorded from the transport's own report, never inferred
 * from the fact that a request was attempted — the distinction that separates
 * a provable no-trade from an unknowable one.
 */
export interface EvidenceProbe {
  name: string;
  op: string;
  /** ARX's classification of the outcome. */
  outcome: "VENUE_REPLY" | "VENUE_REJECTION" | "NOT_SENT" | "UNKNOWN";
  /** Deriv's own error code, when it sent one. */
  derivErrorCode: string | null;
  /** ARX's error taxonomy code, when the attempt failed. */
  arxErrorCode: string | null;
  /** From the transport. null means the transport did not say. */
  wireWritten: boolean | null;
  /** Top-level keys of the reply body — structure without content. */
  replyKeys: string[];
  /** Nested keys under the operation's own block, when present. */
  nestedKeys: string[];
  /** Whether ARX's normalizer could read the reply at all. */
  normalizedOk: boolean;
  /** Why not, when it could not. ARX's own words, never the venue's prose. */
  unreadableReason: string | null;
  transportStateBefore: string;
  transportStateAfter: string;
  reconnectsSoFar: number;
  startedAtMs: number;
  elapsedMs: number;
  frames: EvidenceFrame[];
}

export interface EvidenceArtifact {
  /** Schema version of THIS artifact format, so a fixture generator can
   *  refuse an artifact it does not understand rather than misread it. */
  artifactVersion: 1;
  tier: EvidenceTier;
  capturedAtMs: number;
  /** Presence and shape only — never the values. */
  config: { mode: string; appIdShape: string; tokenLength: number };
  /** Last four of the account id, enough to correlate two runs. */
  accountSuffix: string | null;
  accountType: string | null;
  probes: EvidenceProbe[];
  /** Questions this artifact was built to answer, and whether it did. */
  questions: Array<{ id: string; question: string; answered: boolean; answer: string | null }>;
}

/**
 * Redact a frame.
 *
 * Layered on redactSecrets (token, app id, otp=, Bearer) and adds the WS-side
 * shapes: an `authorize` field, and any URL carrying a query. A frame is
 * capped so a pathological reply cannot turn an artifact into a dump.
 */
export function redactFrame(raw: string, config: DerivNewApiConfig): string {
  let out = redactSecrets(raw, config);
  // A legacy-shaped authorize payload must never be recorded even if one
  // somehow appeared — the whole point of Ruling 15a.
  out = out.replace(/"authorize"\s*:\s*"[^"]*"/gi, '"authorize":"<redacted>"');
  // Any wss/https URL: keep scheme+host+path, drop the query.
  out = out.replace(/(wss?|https?):\/\/([^\s"'?]+)\?[^\s"']*/gi, "$1://$2?<query-redacted>");
  return out;
}

/**
 * Assert an artifact carries no credential material.
 *
 * Runs before an artifact is written OR converted to a fixture. A leak that is
 * only caught in review is a leak that already happened on disk.
 */
export function assertNoSecrets(artifact: EvidenceArtifact, config: DerivNewApiConfig): void {
  const blob = JSON.stringify(artifact);
  const needles: Array<[string, string]> = [];
  if (config.token) needles.push(["token", config.token]);
  if (config.appId) needles.push(["appId", config.appId]);
  for (const [label, value] of needles) {
    if (value.length >= 4 && blob.includes(value)) {
      throw new EvidenceRefusal(`refusing to emit evidence: the ${label} appears in it`);
    }
  }
  if (/otp=(?!<redacted>)[^&"'\s]+/i.test(blob)) {
    throw new EvidenceRefusal("refusing to emit evidence: an OTP appears in it");
  }
  if (/Bearer\s+(?!<redacted>)[A-Za-z0-9._~+/-]{8,}/i.test(blob)) {
    throw new EvidenceRefusal("refusing to emit evidence: a Bearer credential appears in it");
  }
}

/**
 * Serialize deterministically.
 *
 * Keys are sorted at every level so two artifacts of the same observations
 * diff cleanly. Timestamps are DATA and are preserved — they are part of the
 * evidence — so byte-equality across runs is not claimed, only stable
 * structure and ordering.
 */
export function serializeArtifact(artifact: EvidenceArtifact): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>).sort()
          .map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sortDeep(artifact), null, 2)}\n`;
}
