// ═══════════════════════════════════════════════════════════════════════════
// EventStorePort + in-memory implementation.
//
// The port defines the minimal surface a storage backend must implement.
// The server provides a Postgres-backed adapter; tests and pure replay
// can use createInMemoryEventStore().
// Storage is append-only: append() never overwrites; corrections are new events.
// ═══════════════════════════════════════════════════════════════════════════

import type { AuditEvent } from "./eventSchema.types.js";

export interface EventStorePort {
  append(event: AuditEvent): Promise<void>;
  /** Returns null if the store is empty. */
  lastEventId(): Promise<string | null>;
  /** Read events ordered by insertion (= chain order). */
  list(opts?: { limit?: number; afterEventId?: string }): Promise<AuditEvent[]>;
  /** Total events. Useful for snapshots & integrity coverage stats. */
  count(): Promise<number>;
}

export interface InMemoryEventStore extends EventStorePort {
  // Direct access for tests — never call from production code.
  _events: AuditEvent[];
}

export function createInMemoryEventStore(): InMemoryEventStore {
  const events: AuditEvent[] = [];
  return {
    _events: events,
    async append(e) {
      // Append-only — refuse if the same id already exists.
      if (events.some((x) => x.eventId === e.eventId)) {
        throw new Error(`AUDIT_VAULT: duplicate eventId ${e.eventId}`);
      }
      events.push(e);
    },
    async lastEventId() {
      return events.length === 0 ? null : events[events.length - 1]!.eventId;
    },
    async list(opts = {}) {
      let from = 0;
      if (opts.afterEventId) {
        const idx = events.findIndex((e) => e.eventId === opts.afterEventId);
        from = idx < 0 ? events.length : idx + 1;
      }
      const slice = events.slice(from);
      const lim = opts.limit ?? slice.length;
      return slice.slice(0, lim);
    },
    async count() {
      return events.length;
    },
  };
}
