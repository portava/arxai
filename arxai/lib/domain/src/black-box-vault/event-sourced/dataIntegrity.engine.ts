// ═══════════════════════════════════════════════════════════════════════════
// Event-sourced vault integrity engine. Distinct from
// ../dataIntegrity.engine.ts (Truth-store integrity) — this one operates on
// the AuditEvent chain.
//
// Detects:
//   DUPLICATE_EVENT_ID, BROKEN_CHAIN, CHECKSUM_MISMATCH,
//   MALFORMED_PAYLOAD, MISSING_FIELD, INVALID_TIMESTAMP, INVALID_SEVERITY,
//   FUTURE_TIMESTAMP.
// Pure — driven by a hash port + a clock port for "future timestamp".
// ═══════════════════════════════════════════════════════════════════════════

import type { AuditEvent, AuditSeverity } from "./eventSchema.types.js";
import type { ClockPort } from "./eventId.engine.js";
import { verifyChain, type HashPort } from "./eventChain.engine.js";

export type AuditIntegrityCategory =
  | "DUPLICATE_EVENT_ID"
  | "BROKEN_CHAIN"
  | "CHECKSUM_MISMATCH"
  | "MALFORMED_PAYLOAD"
  | "MISSING_FIELD"
  | "INVALID_TIMESTAMP"
  | "INVALID_SEVERITY"
  | "FUTURE_TIMESTAMP";

export interface AuditIntegrityFlag {
  category: AuditIntegrityCategory;
  eventId: string | null;
  index: number;
  detail: string;
}

export interface AuditIntegrityReport {
  scannedRows: number;
  flagCount: number;
  criticalCount: number;
  byCategory: Record<AuditIntegrityCategory, number>;
  flags: AuditIntegrityFlag[];
}

const SEVERITIES: ReadonlyArray<AuditSeverity> = ["INFO", "WARN", "DANGER", "CRITICAL"];
const FUTURE_SKEW_MS = 60_000;

function emptyByCategory(): Record<AuditIntegrityCategory, number> {
  return {
    DUPLICATE_EVENT_ID: 0,
    BROKEN_CHAIN: 0,
    CHECKSUM_MISMATCH: 0,
    MALFORMED_PAYLOAD: 0,
    MISSING_FIELD: 0,
    INVALID_TIMESTAMP: 0,
    INVALID_SEVERITY: 0,
    FUTURE_TIMESTAMP: 0,
  };
}

export function scanIntegrity(
  events: ReadonlyArray<AuditEvent>,
  hash: HashPort,
  clock: ClockPort,
): AuditIntegrityReport {
  const flags: AuditIntegrityFlag[] = [];
  const byCategory = emptyByCategory();
  const now = clock();

  // Field / payload / timestamp / severity scan.
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const requiredKeys: (keyof AuditEvent)[] = [
      "eventId", "timestamp", "eventType", "source", "severity",
      "payload", "checksum", "schemaVersion",
    ];
    for (const k of requiredKeys) {
      if (e[k] === undefined || e[k] === null) {
        if (k === "payload") continue; // tolerate empty object handled below
        flags.push({ category: "MISSING_FIELD", eventId: e.eventId ?? null, index: i, detail: `missing ${k}` });
      }
    }
    if (typeof e.payload !== "object" || e.payload === null || Array.isArray(e.payload)) {
      flags.push({ category: "MALFORMED_PAYLOAD", eventId: e.eventId ?? null, index: i, detail: `payload is not a JSON object` });
    }
    const ms = Date.parse(e.timestamp);
    if (Number.isNaN(ms)) {
      flags.push({ category: "INVALID_TIMESTAMP", eventId: e.eventId ?? null, index: i, detail: `cannot parse timestamp ${e.timestamp}` });
    } else if (ms > now + FUTURE_SKEW_MS) {
      flags.push({ category: "FUTURE_TIMESTAMP", eventId: e.eventId ?? null, index: i, detail: `timestamp ${e.timestamp} is in the future` });
    }
    if (!SEVERITIES.includes(e.severity)) {
      flags.push({ category: "INVALID_SEVERITY", eventId: e.eventId ?? null, index: i, detail: `severity ${String(e.severity)} not allowed` });
    }
  }

  // Chain + checksum + duplicates.
  const breaks = verifyChain(events, hash);
  for (const b of breaks) {
    if (b.reason === "CHECKSUM_MISMATCH") {
      flags.push({ category: "CHECKSUM_MISMATCH", eventId: b.eventId, index: b.index, detail: b.detail });
    } else if (b.reason === "DUPLICATE_EVENT_ID") {
      flags.push({ category: "DUPLICATE_EVENT_ID", eventId: b.eventId, index: b.index, detail: b.detail });
    } else {
      flags.push({ category: "BROKEN_CHAIN", eventId: b.eventId, index: b.index, detail: `${b.reason}: ${b.detail}` });
    }
  }

  for (const f of flags) byCategory[f.category]++;
  const criticalCount =
    byCategory.CHECKSUM_MISMATCH +
    byCategory.BROKEN_CHAIN +
    byCategory.DUPLICATE_EVENT_ID +
    byCategory.MISSING_FIELD;

  return {
    scannedRows: events.length,
    flagCount: flags.length,
    criticalCount,
    byCategory,
    flags,
  };
}
