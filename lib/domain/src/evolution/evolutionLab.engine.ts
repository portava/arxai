import { z } from "zod/v4";
import {
  MutationInputsSchema, type StrategyVariant, mutateStrategy,
} from "./strategyMutation.engine";
import {
  VariationTestInputsSchema, type VariationTestResult, evaluateVariations,
} from "./variationTesting.engine";
import {
  SandboxValidationInputsSchema, type SandboxValidationDecision, validateSandbox,
  type SandboxMode,
} from "./sandboxValidation.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Evolution Lab — orchestrates one full mutate→test→validate cycle.
//
// PROJECT RULES enforced here:
//   • Evolution and mutation only happen in sandbox mode (refuse otherwise).
//   • No evolved strategy can skip validation stages (delegated to
//     sandboxValidation, which enforces it).
//   • All evolution results MUST be logged to the Black Box Vault — we
//     return the entries; caller persists via BlackBoxVaultPort.
// ═══════════════════════════════════════════════════════════════════════════

export const BlackBoxVaultEntrySchema = z.object({
  cycleId: z.string().min(1),
  parentStrategyId: z.string().min(1),
  variantId: z.string().min(1),
  outcome: z.enum(["GRADUATED", "REJECTED_TESTING", "REJECTED_VALIDATION", "REJECTED_MODE"]),
  recordedAtIso: z.string(),
  reasons: z.array(z.string()),
});
export type BlackBoxVaultEntry = z.infer<typeof BlackBoxVaultEntrySchema>;

export interface BlackBoxVaultPort {
  append(entry: BlackBoxVaultEntry): Promise<void>;
  list(filter?: { parentStrategyId?: string; cycleId?: string }): Promise<BlackBoxVaultEntry[]>;
}

export const EvolutionCycleInputsSchema = z.object({
  cycleId: z.string().min(1),
  mode: z.enum(["SANDBOX", "SHADOW", "LIVE"]),
  mutation: MutationInputsSchema,
  // Caller runs the simulator and feeds back per-variant results + parent baseline.
  testing: VariationTestInputsSchema,
  // Validation outcomes per qualifying variant (caller produced from sandbox runs).
  validations: z.array(SandboxValidationInputsSchema),
  recordedAtIso: z.string(),
});
export type EvolutionCycleInputs = z.infer<typeof EvolutionCycleInputsSchema>;

export interface EvolutionCycleResult {
  cycleId: string;
  variants: StrategyVariant[];
  testing: VariationTestResult | null;
  validations: SandboxValidationDecision[];
  graduatedVariantIds: string[];
  vaultEntries: BlackBoxVaultEntry[];
  reasons: string[];
  blockers: string[];
}

export function runEvolutionCycle(i: EvolutionCycleInputs): EvolutionCycleResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const vaultEntries: BlackBoxVaultEntry[] = [];

  // ── Hard rule: SANDBOX only ─────────────────────────────────────────────
  if (i.mode !== "SANDBOX") {
    blockers.push(`mode ${i.mode} ≠ SANDBOX — evolution refused (rule: mutation only in sandbox)`);
    reasons.push(`evolution cycle ${i.cycleId} refused — wrong mode`);
    vaultEntries.push({
      cycleId: i.cycleId,
      parentStrategyId: i.mutation.parentStrategyId,
      variantId: i.mutation.parentStrategyId,
      outcome: "REJECTED_MODE",
      recordedAtIso: i.recordedAtIso,
      reasons: [`mode ${i.mode} ≠ SANDBOX`],
    });
    return {
      cycleId: i.cycleId, variants: [], testing: null, validations: [],
      graduatedVariantIds: [], vaultEntries, reasons, blockers,
    };
  }

  // ── Step 1: mutate ──────────────────────────────────────────────────────
  const m = mutateStrategy(i.mutation);
  reasons.push(...m.reasons);
  blockers.push(...m.blockers);
  if (m.variants.length === 0) {
    // Black Box Vault rule: every cycle outcome must be auditable, including
    // a refusal at the mutation stage.
    vaultEntries.push({
      cycleId: i.cycleId,
      parentStrategyId: i.mutation.parentStrategyId,
      variantId: `${i.mutation.parentStrategyId}.cycle-rejected`,
      outcome: "REJECTED_VALIDATION",
      recordedAtIso: i.recordedAtIso,
      reasons: [`mutation produced 0 variants — cycle aborted`, ...m.blockers],
    });
    return {
      cycleId: i.cycleId, variants: [], testing: null, validations: [],
      graduatedVariantIds: [], vaultEntries, reasons, blockers,
    };
  }

  // ── Lineage integrity: testing must be FOR THIS PARENT ──────────────────
  if (i.testing.parentStrategyId !== i.mutation.parentStrategyId) {
    blockers.push(`testing.parentStrategyId ${i.testing.parentStrategyId} ≠ mutation.parentStrategyId ${i.mutation.parentStrategyId} — refusing cycle`);
    vaultEntries.push({
      cycleId: i.cycleId,
      parentStrategyId: i.mutation.parentStrategyId,
      variantId: `${i.cycleId}.lineage-mismatch`,
      outcome: "REJECTED_TESTING",
      recordedAtIso: i.recordedAtIso,
      reasons: [`parent lineage mismatch between mutation and testing inputs`],
    });
    return {
      cycleId: i.cycleId, variants: m.variants, testing: null, validations: [],
      graduatedVariantIds: [], vaultEntries, reasons, blockers,
    };
  }

  // ── Step 2: variation testing ───────────────────────────────────────────
  const t = evaluateVariations(i.testing);
  reasons.push(...t.reasons);
  blockers.push(...t.blockers);

  // ── Lineage integrity: only accept variantIds we actually produced ──────
  const mutatedIds = new Set(m.variants.map((v) => v.variantId));
  const foreignQualifying = t.qualifyingVariantIds.filter((id) => !mutatedIds.has(id));
  for (const id of foreignQualifying) {
    blockers.push(`testing reported foreign variantId ${id} not produced by this mutation cycle — rejecting`);
    vaultEntries.push({
      cycleId: i.cycleId,
      parentStrategyId: i.mutation.parentStrategyId,
      variantId: id,
      outcome: "REJECTED_TESTING",
      recordedAtIso: i.recordedAtIso,
      reasons: [`foreign variantId — not in this cycle's mutation outputs`],
    });
  }

  // Fail-closed: if testing reported gating blockers (e.g. baseline too small),
  // refuse to graduate ANY variant from this cycle. Log all variants as rejected.
  if (t.blockers.length > 0) {
    reasons.push(`cycle ${i.cycleId} aborted at testing stage due to ${t.blockers.length} blocker(s) — fail-closed`);
    for (const v of m.variants) {
      vaultEntries.push({
        cycleId: i.cycleId,
        parentStrategyId: i.mutation.parentStrategyId,
        variantId: v.variantId,
        outcome: "REJECTED_TESTING",
        recordedAtIso: i.recordedAtIso,
        reasons: [`variation testing returned blockers — cycle fail-closed`, ...t.blockers],
      });
    }
    return {
      cycleId: i.cycleId, variants: m.variants, testing: t, validations: [],
      graduatedVariantIds: [], vaultEntries, reasons, blockers,
    };
  }

  // Hard-filter qualifying to mutated lineage only.
  const qualifying = new Set(t.qualifyingVariantIds.filter((id) => mutatedIds.has(id)));

  // Log non-qualifying variants now (vault).
  for (const v of m.variants) {
    if (!qualifying.has(v.variantId)) {
      vaultEntries.push({
        cycleId: i.cycleId,
        parentStrategyId: i.mutation.parentStrategyId,
        variantId: v.variantId,
        outcome: "REJECTED_TESTING",
        recordedAtIso: i.recordedAtIso,
        reasons: [`did not qualify in variation testing`],
      });
    }
  }

  // ── Step 3: sandbox validation per qualifying variant ───────────────────
  const validations: SandboxValidationDecision[] = [];
  const graduated: string[] = [];
  for (const variantId of qualifying) {
    const inputs = i.validations.find((v) => v.variantId === variantId);
    if (!inputs) {
      vaultEntries.push({
        cycleId: i.cycleId,
        parentStrategyId: i.mutation.parentStrategyId,
        variantId,
        outcome: "REJECTED_VALIDATION",
        recordedAtIso: i.recordedAtIso,
        reasons: [`missing sandbox validation inputs for variant`],
      });
      continue;
    }
    // Defensive: force mode through — rule enforcement.
    const decision = validateSandbox({ ...inputs, mode: i.mode as SandboxMode });
    validations.push(decision);
    if (decision.approved) {
      graduated.push(variantId);
      vaultEntries.push({
        cycleId: i.cycleId,
        parentStrategyId: i.mutation.parentStrategyId,
        variantId,
        outcome: "GRADUATED",
        recordedAtIso: i.recordedAtIso,
        reasons: [...decision.reasons],
      });
    } else {
      vaultEntries.push({
        cycleId: i.cycleId,
        parentStrategyId: i.mutation.parentStrategyId,
        variantId,
        outcome: "REJECTED_VALIDATION",
        recordedAtIso: i.recordedAtIso,
        reasons: [...decision.reasons, ...decision.blockers],
      });
    }
  }

  reasons.push(`cycle ${i.cycleId}: ${m.variants.length} variants → ${qualifying.size} qualified → ${graduated.length} graduated`);
  return {
    cycleId: i.cycleId, variants: m.variants, testing: t, validations,
    graduatedVariantIds: graduated, vaultEntries, reasons, blockers,
  };
}

export function createInMemoryBlackBoxVault(): BlackBoxVaultPort {
  const entries: BlackBoxVaultEntry[] = [];
  return {
    async append(e) { entries.push({ ...e, reasons: [...e.reasons] }); },
    async list(filter) {
      let out = entries.map((e) => ({ ...e, reasons: [...e.reasons] }));
      if (filter?.parentStrategyId) out = out.filter((e) => e.parentStrategyId === filter.parentStrategyId);
      if (filter?.cycleId)          out = out.filter((e) => e.cycleId === filter.cycleId);
      return out;
    },
  };
}
