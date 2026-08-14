// ═══════════════════════════════════════════════════════════════════════════
// Event chain + checksum engine.
//
// - canonicalize(): stable JSON serialization (sorted keys) used for the
//   checksum. Sorting keys means two semantically equal payloads produce the
//   same digest regardless of property insertion order.
// - sealEvent(): given a draft + previous event id + ports, returns a fully
//   sealed AuditEvent including checksum.
// - verifyEvent(): recomputes the checksum and confirms it matches.
// - verifyChain(): walks an ordered list and reports breaks.
// ═══════════════════════════════════════════════════════════════════════════

import {
  AUDIT_SCHEMA_VERSION,
  type AuditEvent,
  type AuditEventDraft,
} from "./eventSchema.types.js";
import { newEventId, type ClockPort, type RandomHexPort } from "./eventId.engine.js";

export type HashPort = (utf8: string) => string;

export interface SealPorts {
  clock: ClockPort;
  rand: RandomHexPort;
  hash: HashPort;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(value, sortReplacer());
}

function sortReplacer() {
  return function (_key: string, val: unknown): unknown {
    if (val === null || typeof val !== "object" || Array.isArray(val)) return val;
    const entries = Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = v;
    return out;
  };
}

function checksumBody(e: Omit<AuditEvent, "checksum">): string {
  // Everything except the checksum itself feeds the digest. previousEventId is
  // included so any tampering with chain order is detected too.
  return canonicalize({
    eventId: e.eventId,
    timestamp: e.timestamp,
    eventType: e.eventType,
    source: e.source,
    severity: e.severity,
    systemMode: e.systemMode,
    globalState: e.globalState,
    payload: e.payload,
    previousEventId: e.previousEventId,
    schemaVersion: e.schemaVersion,
  });
}

export function sealEvent(
  draft: AuditEventDraft,
  previousEventId: string | null,
  ports: SealPorts,
): AuditEvent {
  const eventId = newEventId(ports.clock, ports.rand);
  const timestamp = draft.timestamp ?? new Date(ports.clock()).toISOString();
  const body: Omit<AuditEvent, "checksum"> = {
    eventId,
    timestamp,
    eventType: draft.eventType,
    source: draft.source,
    severity: draft.severity,
    systemMode: draft.systemMode,
    globalState: draft.globalState,
    payload: draft.payload ?? {},
    previousEventId,
    schemaVersion: AUDIT_SCHEMA_VERSION,
    trainingEligible: draft.trainingEligible ?? true,
  };
  const checksum = ports.hash(checksumBody(body));
  return { ...body, checksum };
}

export function verifyEvent(e: AuditEvent, hash: HashPort): boolean {
  const expected = hash(checksumBody(e));
  return expected === e.checksum;
}

export type ChainBreakReason =
  | "CHECKSUM_MISMATCH"
  | "BROKEN_PREV_POINTER"
  | "DUPLICATE_EVENT_ID"
  | "OUT_OF_ORDER_TIMESTAMP"
  | "MISSING_FIRST_EVENT";

export interface ChainBreak {
  index: number;
  eventId: string | null;
  reason: ChainBreakReason;
  detail: string;
}

export function verifyChain(events: ReadonlyArray<AuditEvent>, hash: HashPort): ChainBreak[] {
  const breaks: ChainBreak[] = [];
  const seen = new Set<string>();
  let prev: AuditEvent | null = null;

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (seen.has(e.eventId)) {
      breaks.push({ index: i, eventId: e.eventId, reason: "DUPLICATE_EVENT_ID", detail: `duplicate eventId ${e.eventId}` });
    }
    seen.add(e.eventId);

    if (!verifyEvent(e, hash)) {
      breaks.push({ index: i, eventId: e.eventId, reason: "CHECKSUM_MISMATCH", detail: `checksum does not match body for ${e.eventId}` });
    }

    if (i === 0) {
      if (e.previousEventId !== null) {
        breaks.push({ index: 0, eventId: e.eventId, reason: "MISSING_FIRST_EVENT", detail: `first event has non-null previousEventId=${e.previousEventId}` });
      }
    } else {
      if (e.previousEventId !== prev!.eventId) {
        breaks.push({ index: i, eventId: e.eventId, reason: "BROKEN_PREV_POINTER",
          detail: `expected prev=${prev!.eventId}, got ${e.previousEventId ?? "null"}` });
      }
      if (Date.parse(e.timestamp) < Date.parse(prev!.timestamp)) {
        breaks.push({ index: i, eventId: e.eventId, reason: "OUT_OF_ORDER_TIMESTAMP",
          detail: `timestamp ${e.timestamp} < previous ${prev!.timestamp}` });
      }
    }
    prev = e;
  }
  return breaks;
}
