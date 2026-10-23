import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// AI Economy — central ledger of agent ACCOUNTS. Each agent earns three
// kinds of "wealth":
//   • reputation01      — what the agent has shown it can do
//   • survivalCurrency  — capital allocation chips, earned by NOT blowing up
//   • trustScore01      — composite gate to authority (computed elsewhere)
//
// Project invariants enforced here:
//   • No agent bypasses the Risk Governor — economy CANNOT widen authority.
//     This module records and ranks; authority changes are proposals only.
//   • Survival quality matters MORE than raw profit: capital allocation
//     proposals weight survivalCurrency above reputation.
//   • Pure functions; all mutation through the EconomyLedgerPort.
// ═══════════════════════════════════════════════════════════════════════════

export const AgentIdSchema = z.string().min(1);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const AgentAccountSchema = z.object({
  agentId: AgentIdSchema,
  reputation01: z.number().min(0).max(1),
  survivalCurrency: z.number().min(0),       // chips, not signed
  trustScore01: z.number().min(0).max(1),
  disciplineScore01: z.number().min(0).max(1),
  specialtyScore01: z.number().min(0).max(1),
  sampleCount: z.int().nonnegative(),
  lastUpdatedIso: z.string(),
});
export type AgentAccount = z.infer<typeof AgentAccountSchema>;

export const EconomySnapshotSchema = z.object({
  accounts: z.array(AgentAccountSchema),
  totalSurvivalCurrency: z.number().min(0),
  takenAtIso: z.string(),
});
export type EconomySnapshot = z.infer<typeof EconomySnapshotSchema>;

export interface EconomyLedgerPort {
  upsert(account: AgentAccount): Promise<void>;
  get(id: AgentId): Promise<AgentAccount | null>;
  list(): Promise<AgentAccount[]>;
}

// rankAgents — sort by composite "deserve more capital" score.
// Survival-first weighting: 0.45 survival, 0.30 trust, 0.25 reputation.
// (If you change weights, project rule "survival > raw profit" must hold.)
export const RANK_WEIGHTS = {
  survival: 0.45,
  trust: 0.30,
  reputation: 0.25,
} as const;

export interface RankedAgent {
  agentId: AgentId;
  rankScore01: number;
  reasons: string[];
}

export function rankAgents(accounts: readonly AgentAccount[]): RankedAgent[] {
  const W = RANK_WEIGHTS;
  // Normalize survivalCurrency 0..1 across the population (max-scaling).
  const maxCurrency = accounts.reduce((m, a) => Math.max(m, a.survivalCurrency), 0);
  const ranked = accounts.map((a) => {
    const survival01 = maxCurrency > 0 ? Math.min(1, a.survivalCurrency / maxCurrency) : 0;
    const score = survival01 * W.survival
                + a.trustScore01 * W.trust
                + a.reputation01 * W.reputation;
    return {
      agentId: a.agentId,
      rankScore01: Math.max(0, Math.min(1, score)),
      reasons: [
        `survival01 ${survival01.toFixed(3)} × ${W.survival}`,
        `trust ${a.trustScore01.toFixed(3)} × ${W.trust}`,
        `reputation ${a.reputation01.toFixed(3)} × ${W.reputation}`,
        `composite ${score.toFixed(3)}`,
      ],
    };
  });
  ranked.sort((a, b) => b.rankScore01 - a.rankScore01);
  return ranked;
}

// proposeCapitalAllocation — distribute a normalized capital budget (0..1)
// across agents proportional to rankScore. Pure proposal — Risk Governor
// still has final veto; nothing here actually moves money.
export interface AllocationProposal {
  agentId: AgentId;
  fraction01: number;                        // share of total budget
  reasons: string[];
}

// Default per-cycle ramp cap: a strong agent's allocation can grow by at
// most this fraction of total capital per cycle. Project rule: capital
// allocation must increase GRADUALLY.
export const ALLOCATION_RAMP = {
  defaultMaxStepDelta01: 0.10,               // ±10% of total per cycle
} as const;

export function proposeCapitalAllocation(
  accounts: readonly AgentAccount[],
  opts: {
    maxAgents?: number;
    minRankScore?: number;
    previousAllocations?: ReadonlyMap<AgentId, number>;
    maxStepDelta01?: number;
  } = {},
): { proposals: AllocationProposal[]; reasons: string[]; blockers: string[] } {
  const reasons: string[] = [];
  const blockers: string[] = [];
  if (accounts.length === 0) {
    blockers.push("no agent accounts to allocate among");
    return { proposals: [], reasons, blockers };
  }
  const minRank = opts.minRankScore ?? 0.05;
  const ranked = rankAgents(accounts).filter((r) => r.rankScore01 >= minRank);
  const cap = opts.maxAgents ?? ranked.length;
  const eligible = ranked.slice(0, cap);
  if (eligible.length === 0) {
    blockers.push(`no agents passed minRankScore ${minRank.toFixed(3)}`);
    return { proposals: [], reasons, blockers };
  }
  const totalScore = eligible.reduce((s, r) => s + r.rankScore01, 0);

  // First pass: target shares.
  const target = eligible.map((r) => ({
    agentId: r.agentId,
    targetFraction01: totalScore > 0 ? r.rankScore01 / totalScore : 0,
    rankReasons: r.reasons,
  }));

  // Second pass: ramp-limit changes vs previous allocation.
  const prev = opts.previousAllocations;
  const maxStep = Math.max(0, Math.min(1, opts.maxStepDelta01 ?? ALLOCATION_RAMP.defaultMaxStepDelta01));
  let proposals: AllocationProposal[] = target.map((t) => {
    const prevFrac = prev?.get(t.agentId) ?? 0;
    const desiredDelta = t.targetFraction01 - prevFrac;
    const cappedDelta = Math.max(-maxStep, Math.min(maxStep, desiredDelta));
    const ramped = Math.max(0, Math.min(1, prevFrac + cappedDelta));
    const reasonsR = [...t.rankReasons, `target ${t.targetFraction01.toFixed(3)} from prev ${prevFrac.toFixed(3)} → ramp-limited to ${ramped.toFixed(3)} (max step ±${maxStep.toFixed(3)})`];
    return { agentId: t.agentId, fraction01: ramped, reasons: reasonsR };
  });

  // Defensive: re-normalize so fractions sum to ≤ 1 (rounding + ramp can drift).
  const sum = proposals.reduce((s, p) => s + p.fraction01, 0);
  if (sum > 1) {
    const factor = 1 / sum;
    proposals = proposals.map((p) => ({
      ...p,
      fraction01: p.fraction01 * factor,
      reasons: [...p.reasons, `re-normalized × ${factor.toFixed(3)} to keep total ≤ 1`],
    }));
  }

  reasons.push(`allocated capital across ${proposals.length} of ${accounts.length} agents (ramp-limited ±${maxStep.toFixed(3)} per cycle)`,
               `proposal is advisory — Risk Governor retains final veto`);
  return { proposals, reasons, blockers };
}
