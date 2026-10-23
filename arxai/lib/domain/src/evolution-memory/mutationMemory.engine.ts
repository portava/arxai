import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Mutation Memory — append-only ledger of what mutations have been tried,
// with their outcome. Used to (a) prevent retrying known-bad fingerprints
// and (b) feed the constitution's MEMORY_BLACKLISTED rule.
// ═══════════════════════════════════════════════════════════════════════════

export const MutationOutcomeSchema = z.enum([
  "GRADUATED", "REJECTED_VALIDATION", "REJECTED_MODE",
  "COLLAPSED_LIVE", "OVERFIT_DETECTED", "FAKE_EDGE_DETECTED",
]);
export type MutationOutcome = z.infer<typeof MutationOutcomeSchema>;

export const MutationMemoryEntrySchema = z.object({
  fingerprint: z.string().min(1),
  parentStrategyId: z.string().min(1),
  outcome: MutationOutcomeSchema,
  recordedAtIso: z.string(),
  notes: z.string().default(""),
});
export type MutationMemoryEntry = z.infer<typeof MutationMemoryEntrySchema>;

export const MutationMemoryQuerySchema = z.object({
  fingerprint: z.string().min(1),
  history: z.array(MutationMemoryEntrySchema),
});
export type MutationMemoryQuery = z.infer<typeof MutationMemoryQuerySchema>;

const BLACKLIST_OUTCOMES: ReadonlySet<MutationOutcome> = new Set([
  "COLLAPSED_LIVE", "OVERFIT_DETECTED", "FAKE_EDGE_DETECTED",
]);

export interface MutationMemoryDecision {
  fingerprint: string;
  blacklisted: boolean;
  matchingEntries: MutationMemoryEntry[];
  reasons: string[];
}

export function queryMutationMemory(q: MutationMemoryQuery): MutationMemoryDecision {
  const matching = q.history.filter((e) => e.fingerprint === q.fingerprint);
  const blacklisted = matching.some((e) => BLACKLIST_OUTCOMES.has(e.outcome));
  const reasons: string[] = matching.length === 0
    ? [`no prior history for fingerprint ${q.fingerprint}`]
    : [`${matching.length} prior outcome(s); blacklisted=${blacklisted}`];
  return { fingerprint: q.fingerprint, blacklisted, matchingEntries: matching, reasons };
}

export function appendMutationMemory(
  history: readonly MutationMemoryEntry[],
  entry: MutationMemoryEntry,
): MutationMemoryEntry[] {
  return [...history, entry];
}

export function blacklistedFingerprints(history: readonly MutationMemoryEntry[]): string[] {
  const out = new Set<string>();
  for (const e of history) if (BLACKLIST_OUTCOMES.has(e.outcome)) out.add(e.fingerprint);
  return [...out];
}
