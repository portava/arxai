import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Archive — terminal cold-storage step. RETIRED strategies move to the
// Black Box Vault for forensic / training purposes. Archived = immutable.
//
// All archives MUST land in the BlackBoxVault (project rule for evolution
// is mirrored here for symmetry — every retired strategy is auditable).
// ═══════════════════════════════════════════════════════════════════════════

export const ArchiveInputsSchema = z.object({
  strategyId: z.string().min(1),
  currentStage: z.literal("RETIRED"),
  daysSinceRetirement: z.number().min(0),
  reinstatementWindowDays: z.number().min(0).default(30),
  finalSnapshotPayloadBytes: z.int().nonnegative(),
});
export type ArchiveInputs = z.infer<typeof ArchiveInputsSchema>;

export const ArchiveRecordSchema = z.object({
  strategyId: z.string().min(1),
  archivedAtIso: z.string(),
  payloadBytes: z.int().nonnegative(),
  notes: z.array(z.string()),
});
export type ArchiveRecord = z.infer<typeof ArchiveRecordSchema>;

export interface ArchiveVaultPort {
  store(record: ArchiveRecord): Promise<void>;
  list(): Promise<ArchiveRecord[]>;
  has(strategyId: string): Promise<boolean>;
}

export interface ArchiveDecision {
  recommend: boolean;
  reasons: string[];
  blockers: string[];
}

// evaluateArchive — only ARCHIVE retired strategies whose reinstatement
// window has elapsed (so operator had a chance to bring them back).
export function evaluateArchive(i: ArchiveInputs): ArchiveDecision {
  const reasons: string[] = [];
  const blockers: string[] = [];

  if (i.daysSinceRetirement < i.reinstatementWindowDays) {
    blockers.push(`reinstatement window not elapsed: ${i.daysSinceRetirement.toFixed(1)}d < ${i.reinstatementWindowDays}d`);
    reasons.push(`HOLD — keep ${i.strategyId} warm for possible REINSTATE`);
    return { recommend: false, reasons, blockers };
  }
  if (i.finalSnapshotPayloadBytes <= 0) {
    blockers.push(`final snapshot payload is empty — refusing to archive without artefact`);
    reasons.push(`HOLD — operator must produce a final snapshot first`);
    return { recommend: false, reasons, blockers };
  }
  reasons.push(`reinstatement window elapsed and snapshot ready — recommend ARCHIVE`);
  return { recommend: true, reasons, blockers };
}

export function createInMemoryArchiveVault(): ArchiveVaultPort {
  const records = new Map<string, ArchiveRecord>();
  return {
    async store(record) {
      // Defensive: archives are immutable — refuse to overwrite.
      if (records.has(record.strategyId)) {
        throw new Error(`archive already exists for ${record.strategyId} — archives are immutable`);
      }
      records.set(record.strategyId, { ...record, notes: [...record.notes] });
    },
    async list() {
      return [...records.values()].map((r) => ({ ...r, notes: [...r.notes] }));
    },
    async has(strategyId) { return records.has(strategyId); },
  };
}
