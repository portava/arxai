// ═══════════════════════════════════════════════════════════════════════════
// dataQualityGuard.engine.ts — pure quality assessment for AuditEventDraft.
//
// Flags incomplete, malformed, oversized, or otherwise suspicious records
// BEFORE they are stored. Pure: no IO, no time, no secrets.
// ═══════════════════════════════════════════════════════════════════════════

import type { AuditEventDraft, AuditSeverity } from "./eventSchema.types.js";

export type QualityFlagKind =
  | "MISSING_FIELD"
  | "INVALID_SEVERITY"
  | "BAD_TIMESTAMP"
  | "FUTURE_TIMESTAMP"
  | "PAYLOAD_NOT_OBJECT"
  | "PAYLOAD_NOT_SERIALIZABLE"
  | "OVERSIZED_PAYLOAD"
  | "EMPTY_EVENT_TYPE"
  | "UNKNOWN_SEVERITY";

export interface QualityFlag {
  kind: QualityFlagKind;
  severity: "INFO" | "WARN" | "DANGER";
  detail: string;
}

export interface QualityReport {
  flags: QualityFlag[];
  hasCriticalIssue: boolean;
  payloadSizeBytes: number;
}

const VALID_SEVERITIES: ReadonlyArray<AuditSeverity> = ["INFO", "WARN", "DANGER", "CRITICAL"];

/** Default soft cap for payloads stored verbatim. Larger payloads are flagged
 *  WARN — the compression engine should reduce them first. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

export interface QualityOpts {
  maxBytes?: number;
  /** Minutes of clock skew tolerated for "future" timestamps. */
  futureSkewMs?: number;
  nowMs?: number;
}

export function assessQuality(draft: AuditEventDraft, opts: QualityOpts = {}): QualityReport {
  const flags: QualityFlag[] = [];

  // Required core fields
  if (!draft.eventType || typeof draft.eventType !== "string" || draft.eventType.trim() === "") {
    flags.push({ kind: "EMPTY_EVENT_TYPE", severity: "DANGER", detail: "eventType is missing or empty" });
  }
  if (!draft.source || typeof draft.source !== "string") {
    flags.push({ kind: "MISSING_FIELD", severity: "DANGER", detail: "source" });
  }
  if (!draft.severity) {
    flags.push({ kind: "MISSING_FIELD", severity: "DANGER", detail: "severity" });
  } else if (!VALID_SEVERITIES.includes(draft.severity as AuditSeverity)) {
    flags.push({ kind: "INVALID_SEVERITY", severity: "DANGER", detail: String(draft.severity) });
  }

  // Timestamp validity (only when explicitly provided — adapter fills in otherwise)
  if (draft.timestamp != null) {
    const t = Date.parse(draft.timestamp);
    if (!Number.isFinite(t)) {
      flags.push({ kind: "BAD_TIMESTAMP", severity: "DANGER", detail: String(draft.timestamp) });
    } else {
      const now = opts.nowMs ?? Date.now();
      const skew = opts.futureSkewMs ?? 5 * 60 * 1000;
      if (t > now + skew) {
        flags.push({ kind: "FUTURE_TIMESTAMP", severity: "DANGER", detail: String(draft.timestamp) });
      }
    }
  }

  // Payload shape
  let size = 0;
  if (draft.payload !== undefined && draft.payload !== null) {
    if (typeof draft.payload !== "object" || Array.isArray(draft.payload)) {
      flags.push({ kind: "PAYLOAD_NOT_OBJECT", severity: "DANGER", detail: typeof draft.payload });
    } else {
      try {
        size = JSON.stringify(draft.payload).length;
      } catch {
        flags.push({ kind: "PAYLOAD_NOT_SERIALIZABLE", severity: "DANGER", detail: "JSON.stringify failed" });
      }
    }
  }

  const max = opts.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (size > max) {
    flags.push({ kind: "OVERSIZED_PAYLOAD", severity: "WARN", detail: `${size}B > ${max}B` });
  }

  return {
    flags,
    hasCriticalIssue: flags.some((f) => f.severity === "DANGER"),
    payloadSizeBytes: size,
  };
}
