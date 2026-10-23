import type {
  DisagreementQuery, DisagreementRecord, DisagreementStorePort, ShadowComparison,
} from "./intelligenceV2.types";

// buildDisagreementRecord
//
// Wraps a ShadowComparison into a stored record. Only records where
// `agreed === false` should be persisted — the caller decides.
export function buildDisagreementRecord(input: {
  comparison: ShadowComparison;
  symbol: string;
  id?: string;
  now?: Date;
}): DisagreementRecord {
  const now = input.now ?? new Date();
  return {
    id: input.id ?? `dis-${input.comparison.signalId}-${now.getTime()}`,
    occurredAt: input.comparison.comparedAt,
    signalId: input.comparison.signalId,
    symbol: input.symbol,
    comparison: input.comparison,
    realOutcomeR: null,
    realActedSystem: null,
  };
}

// shouldRecord
//
// Convention: persist any comparison that produced at least one
// non-NONE divergence. Calibration is best done on real disagreements.
export function shouldRecord(comparison: ShadowComparison): boolean {
  return !comparison.agreed;
}

// ── In-memory store — pure, ships in the domain so tests + dev can use it
//    without an external dependency. Production wires a Postgres-backed
//    Port that implements the same DisagreementStorePort interface.
export class InMemoryDisagreementStore implements DisagreementStorePort {
  private records: Map<string, DisagreementRecord> = new Map();

  async record(record: DisagreementRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async list(query: DisagreementQuery = {}): Promise<DisagreementRecord[]> {
    let out = Array.from(this.records.values());
    if (query.symbol)  out = out.filter((r) => r.symbol === query.symbol);
    if (query.since)   out = out.filter((r) => r.occurredAt >= query.since!);
    if (query.until)   out = out.filter((r) => r.occurredAt <= query.until!);
    if (query.resolvedOnly) out = out.filter((r) => r.realOutcomeR !== null);
    if (query.divergenceKind) {
      out = out.filter((r) => {
        const c = r.comparison as ShadowComparison;
        return c.divergenceKinds.includes(query.divergenceKind!);
      });
    }
    return out.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  async fillOutcome(
    id: string,
    realOutcomeR: number,
    realActedSystem: NonNullable<DisagreementRecord["realActedSystem"]>,
  ): Promise<boolean> {
    const existing = this.records.get(id);
    if (!existing) return false;
    this.records.set(id, { ...existing, realOutcomeR, realActedSystem });
    return true;
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}
