// ═══════════════════════════════════════════════════════════════════════════
// Event replay engine — reconstructs the chain of decisions up to a target
// event id. Used by Replay Lab + integrity scanner to demonstrate that any
// past system state can be reproduced from the audit log alone.
// ═══════════════════════════════════════════════════════════════════════════

import type { AuditEvent } from "./eventSchema.types.js";
import { buildSnapshot, type AuditSnapshot } from "./snapshotBuilder.engine.js";

export interface ReplayResult {
  target: string | null;
  found: boolean;
  events: AuditEvent[];
  snapshot: AuditSnapshot;
}

export function replayUpTo(
  events: ReadonlyArray<AuditEvent>,
  targetEventId: string | null,
): ReplayResult {
  if (targetEventId === null) {
    const snap = buildSnapshot(events);
    return { target: null, found: true, events: [...events], snapshot: snap };
  }
  const idx = events.findIndex((e) => e.eventId === targetEventId);
  if (idx < 0) {
    return {
      target: targetEventId,
      found: false,
      events: [],
      snapshot: buildSnapshot([]),
    };
  }
  const slice = events.slice(0, idx + 1);
  return {
    target: targetEventId,
    found: true,
    events: slice,
    snapshot: buildSnapshot(slice),
  };
}
