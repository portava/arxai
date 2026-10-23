import { z } from "zod/v4";
import {
  BlackBoxVaultEntrySchema,
  type BlackBoxVaultEntry,
  type EvolutionCycleResult,
} from "./evolutionLab.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Mutation Report — distills an EvolutionCycleResult into a compact
// auditable summary suitable for the Black Box Vault and dashboards.
// Pure: takes a cycle result, returns counts + per-variant outcomes.
// ═══════════════════════════════════════════════════════════════════════════

export const MutationReportSchema = z.object({
  cycleId: z.string().min(1),
  parentStrategyId: z.string().min(1),
  generatedAtIso: z.string(),
  totals: z.object({
    variantsGenerated: z.int().nonnegative(),
    qualifiedAtTesting: z.int().nonnegative(),
    graduatedAtValidation: z.int().nonnegative(),
    rejectedAtMode: z.int().nonnegative(),
    rejectedAtTesting: z.int().nonnegative(),
    rejectedAtValidation: z.int().nonnegative(),
  }),
  perVariant: z.array(z.object({
    variantId: z.string().min(1),
    outcome: z.enum(["GRADUATED", "REJECTED_TESTING", "REJECTED_VALIDATION", "REJECTED_MODE"]),
    reasons: z.array(z.string()),
  })),
  vaultEntries: z.array(BlackBoxVaultEntrySchema),
  graduationRate01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type MutationReport = z.infer<typeof MutationReportSchema>;

export function buildMutationReport(
  cycle: EvolutionCycleResult,
  generatedAtIso: string,
  parentStrategyId: string,
): MutationReport {
  // Latest-wins: a variant might have multiple vault entries (e.g. testing
  // rejection then a forced validation rejection). The CYCLE-level outcome
  // is the LAST emitted entry per variantId.
  const latestByVariant = new Map<string, BlackBoxVaultEntry>();
  for (const e of cycle.vaultEntries) latestByVariant.set(e.variantId, e);

  let graduated = 0, rejTesting = 0, rejValidation = 0, rejMode = 0;
  const perVariant = [...latestByVariant.values()].map((e) => {
    switch (e.outcome) {
      case "GRADUATED":            graduated++;     break;
      case "REJECTED_TESTING":     rejTesting++;    break;
      case "REJECTED_VALIDATION":  rejValidation++; break;
      case "REJECTED_MODE":        rejMode++;       break;
    }
    return { variantId: e.variantId, outcome: e.outcome, reasons: [...e.reasons] };
  });

  const variantsGenerated = cycle.variants.length;
  const qualifiedAtTesting = cycle.testing?.qualifyingVariantIds.length ?? 0;
  const graduationRate01 = variantsGenerated > 0 ? graduated / variantsGenerated : 0;

  return {
    cycleId: cycle.cycleId,
    parentStrategyId,
    generatedAtIso,
    totals: {
      variantsGenerated,
      qualifiedAtTesting,
      graduatedAtValidation: graduated,
      rejectedAtMode: rejMode,
      rejectedAtTesting: rejTesting,
      rejectedAtValidation: rejValidation,
    },
    perVariant,
    vaultEntries: cycle.vaultEntries.map((e) => ({ ...e, reasons: [...e.reasons] })),
    graduationRate01,
    reasons: [
      `cycle ${cycle.cycleId}: ${variantsGenerated} variants → ${qualifiedAtTesting} qualified → ${graduated} graduated`,
      `graduation rate ${(graduationRate01 * 100).toFixed(1)}%`,
      `evolution remained sandbox-only (project rule)`,
    ],
  };
}
