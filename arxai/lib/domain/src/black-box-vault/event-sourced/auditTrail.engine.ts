// ═══════════════════════════════════════════════════════════════════════════
// Audit trail engine — sits between callers and the EventStorePort.
//
// recordEvent(): seal a draft (assign id + chain it to last + checksum) and
//                append. Never throws to the caller in shadow mode — that's
//                the safety property "if vault fails, app must continue".
// recordCorrection(): records an immutable correction event referencing the
//                     prior eventId. The original is NEVER mutated.
// ═══════════════════════════════════════════════════════════════════════════

import type { AuditCorrectionDraft, AuditEvent, AuditEventDraft } from "./eventSchema.types.js";
import type { EventStorePort } from "./eventStore.engine.js";
import { sealEvent, type SealPorts } from "./eventChain.engine.js";

export interface AuditTrailDeps extends SealPorts {
  store: EventStorePort;
}

export interface AuditTrailWriteResult {
  ok: boolean;
  event: AuditEvent | null;
  error: string | null;
}

export async function recordEvent(
  draft: AuditEventDraft,
  deps: AuditTrailDeps,
): Promise<AuditTrailWriteResult> {
  try {
    const prev = await deps.store.lastEventId();
    const sealed = sealEvent(draft, prev, deps);
    await deps.store.append(sealed);
    return { ok: true, event: sealed, error: null };
  } catch (err) {
    return { ok: false, event: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function recordCorrection(
  draft: AuditCorrectionDraft,
  deps: AuditTrailDeps,
): Promise<AuditTrailWriteResult> {
  return recordEvent(
    {
      eventType: "VAULT_CORRECTION",
      source: draft.source,
      severity: draft.severity,
      systemMode: draft.systemMode,
      globalState: draft.globalState,
      timestamp: draft.timestamp,
      payload: {
        ...(draft.payload ?? {}),
        correctsEventId: draft.correctsEventId,
        reason: draft.reason,
        innerEventType: draft.eventType,
      },
    },
    deps,
  );
}
