import { z } from "zod/v4";
import { StateTransitionRecordSchema, type StateTransitionRecord } from "./stateMachine.engine";

// ═══════════════════════════════════════════════════════════════════════════
// State History Store — IO Port for persisting transitions and emitting
// vault events. Provides:
//   - StateHistoryStore interface (Port — caller wires to DB / vault)
//   - InMemoryStateHistoryStore (pure reference impl, deterministic)
//   - toVaultEvent (pure mapper used by callers when forwarding to the
//     Black Box Vault Integration)
// ═══════════════════════════════════════════════════════════════════════════

export const StateHistoryEntrySchema = z.object({
  id: z.string(),
  recordedAtIso: z.string(),
  record: StateTransitionRecordSchema,
});
export type StateHistoryEntry = z.infer<typeof StateHistoryEntrySchema>;

export const StateHistoryQuerySchema = z.object({
  limit: z.int().positive().max(10_000).default(100),
  sinceIso: z.string().optional(),
  untilIso: z.string().optional(),
});
export type StateHistoryQuery = z.infer<typeof StateHistoryQuerySchema>;

// Port — IO behind an interface so engines stay pure.
export interface StateHistoryStore {
  append(record: StateTransitionRecord): Promise<StateHistoryEntry>;
  list(query: StateHistoryQuery): Promise<StateHistoryEntry[]>;
  latest(): Promise<StateHistoryEntry | null>;
  count(): Promise<number>;
}

// Pure reference implementation — stores entries in a private array.
// IDs are derived from index + timestamp (deterministic given input order).
export function createInMemoryStateHistoryStore(): StateHistoryStore {
  const entries: StateHistoryEntry[] = [];
  return {
    async append(record) {
      const entry: StateHistoryEntry = {
        id: `sth_${entries.length}_${record.generatedAtIso}`,
        recordedAtIso: record.generatedAtIso,
        record,
      };
      entries.push(entry);
      return entry;
    },
    async list(q) {
      const limit = q.limit ?? 100;
      const since = q.sinceIso;
      const until = q.untilIso;
      const filtered = entries.filter((e) => {
        if (since && e.recordedAtIso < since) return false;
        if (until && e.recordedAtIso > until) return false;
        return true;
      });
      return filtered.slice(-limit);
    },
    async latest() {
      return entries.length === 0 ? null : entries[entries.length - 1]!;
    },
    async count() { return entries.length; },
  };
}

// Pure mapper: convert a transition record into the shape expected by the
// Black Box Vault Integration's "resilienceEvents" / "complexityEvents" /
// generic event slot. Caller decides which slot to push it to.
export const VaultMappedSchema = z.object({
  severity: z.enum(["INFO", "WARN", "DANGER", "CRITICAL"]),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type VaultMapped = z.infer<typeof VaultMappedSchema>;

export function toVaultEvent(record: StateTransitionRecord): VaultMapped {
  const isCritical = record.toState === "LOCKDOWN" || record.toState === "SAFE_SHUTDOWN";
  const isDanger   = record.toState === "DEGRADED_MODE" || record.toState === "RECOVERY_MODE"
                  || record.toState === "PRESERVATION_MODE";
  const isWarn     = record.changed && !isCritical && !isDanger;
  const severity: VaultMapped["severity"] =
    isCritical ? "CRITICAL" : isDanger ? "DANGER" : isWarn ? "WARN" : "INFO";

  const summary = record.changed
    ? `Global state ${record.fromState} → ${record.toState}` +
      (record.toSubstates.length ? ` (substates: ${record.toSubstates.join(", ")})` : "")
    : `Global state held at ${record.toState}`;

  return {
    severity, summary,
    payload: {
      fromState: record.fromState, toState: record.toState,
      fromSubstates: record.fromSubstates, toSubstates: record.toSubstates,
      changed: record.changed,
      acceptedSources: record.acceptedDemands.map((d) => d.source),
      rejectedSources: record.rejectedDemands.map((d) => d.source),
      generatedAtIso: record.generatedAtIso,
    },
  };
}
