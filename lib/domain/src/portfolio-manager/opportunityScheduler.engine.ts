// ═══════════════════════════════════════════════════════════════════════════
// Capability #20 — Capital Scheduler over SIMULTANEOUS qualified opportunities.
//
// Divides the existing risk envelope (the per-strategy allocations already
// produced by generateAllocationPlan + the account-wide budget caps) among
// simultaneous QUALIFIED opportunities, ranked by:
//
//   • conservative utility  (lower-bound expected R — never the optimistic mean)
//   • reliability           (evidence-backed probability the edge is real)
//   • duration              (shorter holds → better capital turnover)
//   • optionality           (how much follow-on flexibility the trade preserves)
//   • capacity              (how much risk the market can absorb for this idea)
//
// SAFETY (tighten-only): every allocation is min-clamped against
//   1. the opportunity's own requested risk,
//   2. the opportunity's market-capacity clip,
//   3. the strategy's remaining envelope from the existing AllocationPlan,
//   4. the per-symbol cap remaining,
//   5. the remaining deployable budget.
// The scheduler can therefore only ever allocate LESS than the existing caps
// allow — it can never widen any envelope, and `verifyScheduleWithinEnvelope`
// re-proves that invariant on the produced schedule.
//
// Regret / missed-opportunity accounting: every unit of qualified risk that
// could not be funded is journaled with a typed cause and its forgone
// conservative utility. The journal FEEDS BACK into ranking only, via a
// bounded (≤ +15%) priority boost for strategies that historically missed
// funded-quality opportunities — it NEVER changes any cap.
// ═══════════════════════════════════════════════════════════════════════════

import { clamp01, clampNonNegative } from "./portfolio.types";

export interface QualifiedOpportunity {
  opportunityId: string;
  strategyId: string;
  symbolId: string;
  /** Risk the opportunity asks for, in R units. */
  requestedRiskR: number;
  /** LOWER-BOUND expected R per unit of allocated risk (conservative utility). */
  conservativeUtilityR: number;
  /** 0..1 — evidence-backed reliability of the edge estimate. */
  reliability01: number;
  /** Expected holding duration in minutes (shorter → better turnover). */
  expectedDurationMin: number;
  /** 0..1 — optionality preserved (scale-out ability, early-exit liquidity). */
  optionality01: number;
  /** Max riskR this market can absorb for this idea. Omitted → no extra clip. */
  capacityRiskR?: number;
}

/** Historical missed-opportunity accounting fed back as a bounded ranking boost. */
export interface RegretFeedbackEntry {
  strategyId: string;
  /** Count of previously journaled missed opportunities for this strategy. */
  missedCount: number;
  /** Total forgone conservative utility (R) journaled for this strategy. */
  forgoneUtilityR: number;
}

export type MissedCause =
  | "STRATEGY_ENVELOPE_EXHAUSTED"
  | "SYMBOL_CAP_REACHED"
  | "DEPLOYABLE_EXHAUSTED"
  | "CAPACITY_LIMIT"
  | "ZERO_STRATEGY_ENVELOPE"
  | "NEGATIVE_CONSERVATIVE_UTILITY";

export interface RegretJournalEntry {
  opportunityId: string;
  strategyId: string;
  symbolId: string;
  /** Requested minus allocated (R). */
  missedRiskR: number;
  /** missedRiskR × conservativeUtilityR (0 when utility ≤ 0 — declining was correct). */
  forgoneConservativeUtilityR: number;
  cause: MissedCause;
  detail: string;
}

export interface OpportunityAllocation {
  opportunityId: string;
  strategyId: string;
  symbolId: string;
  requestedRiskR: number;
  allocatedRiskR: number;
  rankScore: number;
  rank: number;
  reasons: string[];
}

export interface OpportunityScheduleInput {
  opportunities: ReadonlyArray<QualifiedOpportunity>;
  /** Per-strategy envelope (R) from the existing AllocationPlan — the scheduler
   *  treats this as a HARD ceiling it may only spend down, never raise. */
  strategyEnvelopeR: Readonly<Record<string, number>>;
  /** Account-wide caps from the existing RiskBudget. */
  perSymbolCapR: number;
  deployableR: number;
  /** Risk already committed per symbol (existing open exposure), if any. */
  perSymbolUsedR?: Readonly<Record<string, number>>;
  /** Risk already committed against deployable, if any. */
  deployedR?: number;
  /** Bounded ranking feedback from previously journaled misses. */
  regretFeedback?: ReadonlyArray<RegretFeedbackEntry>;
}

/** Deterministic stress evidence attached to every schedule. */
export interface ScheduleStressEvidence {
  method: "SCHEDULER_STRESS_V1";
  /** Every funded opportunity loses its full allocated risk simultaneously. */
  simultaneousFullLossR: number;
  /** That loss as a fraction of the deployable budget (0..1+). */
  lossFractionOfDeployable: number;
  /** True when the simultaneous loss would consume > the deployable budget —
   *  impossible by construction; a true value is an invariant breach. */
  exceedsDeployable: boolean;
  /** Largest single-symbol simultaneous loss (correlation worst case). */
  worstSymbolLossR: number;
  worstSymbol: string | null;
}

export interface OpportunitySchedule {
  allocations: OpportunityAllocation[];
  regretJournal: RegretJournalEntry[];
  totalAllocatedR: number;
  totalRequestedR: number;
  totalForgoneConservativeUtilityR: number;
  stressEvidence: ScheduleStressEvidence;
  reasons: string[];
  blockers: string[];
}

const EPS = 1e-9;

/** Bounded regret boost: ranking-only, clamped to [1, 1.15]. */
export function regretBoostFor(
  strategyId: string,
  feedback: ReadonlyArray<RegretFeedbackEntry> | undefined,
): number {
  if (!feedback) return 1;
  const f = feedback.find((x) => x.strategyId === strategyId);
  if (!f || f.missedCount <= 0 || f.forgoneUtilityR <= 0) return 1;
  return Math.min(1.15, 1 + 0.05 * Math.log1p(f.missedCount));
}

/** Composite conservative-utility rank score (higher = fund first). */
export function scoreOpportunity(
  o: QualifiedOpportunity,
  feedback?: ReadonlyArray<RegretFeedbackEntry>,
): number {
  if (o.conservativeUtilityR <= 0) return 0;
  const reliability = clamp01(o.reliability01);
  // Turnover: a 1h hold keeps full weight; weight decays with sqrt of hours.
  const hours = Math.max(o.expectedDurationMin, 1) / 60;
  const durationFactor = 1 / Math.sqrt(Math.max(hours, 1));
  const optionalityFactor = 1 + 0.15 * clamp01(o.optionality01);
  const boost = regretBoostFor(o.strategyId, feedback);
  return o.conservativeUtilityR * reliability * durationFactor * optionalityFactor * boost;
}

export function scheduleOpportunities(input: OpportunityScheduleInput): OpportunitySchedule {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const journal: RegretJournalEntry[] = [];

  const strategyRemaining = new Map<string, number>();
  for (const [sid, r] of Object.entries(input.strategyEnvelopeR)) {
    strategyRemaining.set(sid, clampNonNegative(r));
  }
  const symbolUsed = new Map<string, number>(
    Object.entries(input.perSymbolUsedR ?? {}).map(([s, r]) => [s, clampNonNegative(r)]),
  );
  let deployableRemaining = clampNonNegative(input.deployableR - clampNonNegative(input.deployedR ?? 0));

  // Rank: score desc, then stable by opportunityId for determinism.
  const scored = input.opportunities.map((o) => ({
    o, score: scoreOpportunity(o, input.regretFeedback),
  }));
  scored.sort((a, b) =>
    b.score !== a.score ? b.score - a.score
      : a.o.opportunityId < b.o.opportunityId ? -1
      : a.o.opportunityId > b.o.opportunityId ? 1 : 0);

  const allocations: OpportunityAllocation[] = [];
  let rank = 0;
  for (const { o, score } of scored) {
    rank += 1;
    const oReasons: string[] = [];
    const requested = clampNonNegative(o.requestedRiskR);

    if (o.conservativeUtilityR <= 0) {
      // Qualified upstream but the CONSERVATIVE utility is non-positive:
      // funding it would be spending budget on an edge we cannot lower-bound
      // above zero. Journaled as a decline, forgone utility = 0 (declining
      // a non-positive-utility trade forgoes nothing, by construction).
      journal.push({
        opportunityId: o.opportunityId, strategyId: o.strategyId, symbolId: o.symbolId,
        missedRiskR: requested, forgoneConservativeUtilityR: 0,
        cause: "NEGATIVE_CONSERVATIVE_UTILITY",
        detail: `conservativeUtilityR ${o.conservativeUtilityR.toFixed(3)} ≤ 0 — not funded`,
      });
      allocations.push({
        opportunityId: o.opportunityId, strategyId: o.strategyId, symbolId: o.symbolId,
        requestedRiskR: requested, allocatedRiskR: 0, rankScore: score, rank,
        reasons: [`declined: conservative utility ≤ 0`],
      });
      continue;
    }

    const envelope = strategyRemaining.get(o.strategyId) ?? 0;
    const symUsed = symbolUsed.get(o.symbolId) ?? 0;
    const symRemaining = input.perSymbolCapR > 0
      ? clampNonNegative(input.perSymbolCapR - symUsed)
      : Number.POSITIVE_INFINITY;
    const capacity = o.capacityRiskR !== undefined
      ? clampNonNegative(o.capacityRiskR)
      : Number.POSITIVE_INFINITY;

    const clips: Array<{ limit: number; cause: MissedCause; label: string }> = [
      { limit: capacity, cause: "CAPACITY_LIMIT", label: "market capacity" },
      { limit: envelope, cause: envelope <= EPS ? "ZERO_STRATEGY_ENVELOPE" : "STRATEGY_ENVELOPE_EXHAUSTED", label: "strategy envelope" },
      { limit: symRemaining, cause: "SYMBOL_CAP_REACHED", label: "per-symbol cap" },
      { limit: deployableRemaining, cause: "DEPLOYABLE_EXHAUSTED", label: "deployable budget" },
    ];
    let allocated = requested;
    let bindingCause: MissedCause | null = null;
    let bindingLabel = "";
    for (const c of clips) {
      if (c.limit < allocated - EPS) {
        allocated = c.limit;
        bindingCause = c.cause;
        bindingLabel = c.label;
      }
    }
    allocated = clampNonNegative(allocated);

    if (allocated > EPS) {
      strategyRemaining.set(o.strategyId, clampNonNegative(envelope - allocated));
      symbolUsed.set(o.symbolId, symUsed + allocated);
      deployableRemaining = clampNonNegative(deployableRemaining - allocated);
      oReasons.push(`allocated ${allocated.toFixed(3)}R of ${requested.toFixed(3)}R requested (rank ${rank}, score ${score.toFixed(3)})`);
    }
    const missed = clampNonNegative(requested - allocated);
    if (missed > EPS && bindingCause) {
      const forgone = missed * o.conservativeUtilityR;
      journal.push({
        opportunityId: o.opportunityId, strategyId: o.strategyId, symbolId: o.symbolId,
        missedRiskR: missed, forgoneConservativeUtilityR: forgone,
        cause: bindingCause,
        detail: `${bindingLabel} clipped ${requested.toFixed(3)}R → ${allocated.toFixed(3)}R (forgone conservative utility ${forgone.toFixed(3)}R)`,
      });
      oReasons.push(`clipped by ${bindingLabel}: missed ${missed.toFixed(3)}R journaled`);
    }
    allocations.push({
      opportunityId: o.opportunityId, strategyId: o.strategyId, symbolId: o.symbolId,
      requestedRiskR: requested, allocatedRiskR: allocated, rankScore: score, rank,
      reasons: oReasons,
    });
  }

  const totalAllocatedR = allocations.reduce((s, a) => s + a.allocatedRiskR, 0);
  const totalRequestedR = allocations.reduce((s, a) => s + a.requestedRiskR, 0);
  const totalForgone = journal.reduce((s, j) => s + j.forgoneConservativeUtilityR, 0);
  reasons.push(`${allocations.length} opportunity(ies): allocated ${totalAllocatedR.toFixed(3)}R of ${totalRequestedR.toFixed(3)}R requested`);
  if (journal.length > 0) {
    reasons.push(`${journal.length} regret journal entr(ies), total forgone conservative utility ${totalForgone.toFixed(3)}R`);
  }

  // Deterministic stress evidence: what happens if EVERYTHING funded loses at
  // once (the correlation worst case the allocator must survive by budget).
  const perSymbolLoss = new Map<string, number>();
  for (const a of allocations) {
    perSymbolLoss.set(a.symbolId, (perSymbolLoss.get(a.symbolId) ?? 0) + a.allocatedRiskR);
  }
  let worstSymbol: string | null = null;
  let worstSymbolLossR = 0;
  for (const [sym, r] of perSymbolLoss) {
    if (r > worstSymbolLossR) { worstSymbolLossR = r; worstSymbol = sym; }
  }
  const deployableBase = Math.max(clampNonNegative(input.deployableR - clampNonNegative(input.deployedR ?? 0)), EPS);
  const stressEvidence: ScheduleStressEvidence = {
    method: "SCHEDULER_STRESS_V1",
    simultaneousFullLossR: totalAllocatedR,
    lossFractionOfDeployable: totalAllocatedR / deployableBase,
    exceedsDeployable: totalAllocatedR > deployableBase + EPS,
    worstSymbolLossR, worstSymbol,
  };
  if (stressEvidence.exceedsDeployable) {
    blockers.push(`STRESS: simultaneous full loss ${totalAllocatedR.toFixed(3)}R exceeds deployable — invariant breach`);
  }
  reasons.push(`stress: simultaneous full loss ${totalAllocatedR.toFixed(3)}R = ${(stressEvidence.lossFractionOfDeployable * 100).toFixed(1)}% of deployable`);

  const schedule: OpportunitySchedule = {
    allocations, regretJournal: journal,
    totalAllocatedR, totalRequestedR,
    totalForgoneConservativeUtilityR: totalForgone,
    stressEvidence,
    reasons, blockers,
  };
  // Self-verify the tighten-only invariant; a violation is a blocker, never
  // silently shipped.
  const violations = verifyScheduleWithinEnvelope(schedule, input);
  if (violations.length > 0) blockers.push(...violations);
  return schedule;
}

/** Re-proves the tighten-only invariant on a produced schedule. Empty = OK. */
export function verifyScheduleWithinEnvelope(
  schedule: OpportunitySchedule,
  input: OpportunityScheduleInput,
): string[] {
  const out: string[] = [];
  const byStrategy = new Map<string, number>();
  const bySymbol = new Map<string, number>();
  for (const a of schedule.allocations) {
    byStrategy.set(a.strategyId, (byStrategy.get(a.strategyId) ?? 0) + a.allocatedRiskR);
    bySymbol.set(a.symbolId, (bySymbol.get(a.symbolId) ?? 0) + a.allocatedRiskR);
    if (a.allocatedRiskR > a.requestedRiskR + EPS) {
      out.push(`INVARIANT: ${a.opportunityId} allocated ${a.allocatedRiskR} > requested ${a.requestedRiskR}`);
    }
  }
  for (const [sid, sum] of byStrategy) {
    const cap = clampNonNegative(input.strategyEnvelopeR[sid] ?? 0);
    if (sum > cap + EPS) out.push(`INVARIANT: strategy ${sid} allocated ${sum} > envelope ${cap}`);
  }
  if (input.perSymbolCapR > 0) {
    for (const [sym, sum] of bySymbol) {
      const used = clampNonNegative(input.perSymbolUsedR?.[sym] ?? 0);
      if (sum + used > input.perSymbolCapR + EPS) {
        out.push(`INVARIANT: symbol ${sym} allocated ${sum} + used ${used} > perSymbolCapR ${input.perSymbolCapR}`);
      }
    }
  }
  const deployableRemaining = clampNonNegative(input.deployableR - clampNonNegative(input.deployedR ?? 0));
  if (schedule.totalAllocatedR > deployableRemaining + EPS) {
    out.push(`INVARIANT: total allocated ${schedule.totalAllocatedR} > deployable remaining ${deployableRemaining}`);
  }
  return out;
}

/** Aggregate a regret journal into per-strategy feedback for the NEXT cycle. */
export function summarizeRegretFeedback(
  journal: ReadonlyArray<RegretJournalEntry>,
): RegretFeedbackEntry[] {
  const map = new Map<string, RegretFeedbackEntry>();
  for (const j of journal) {
    if (j.forgoneConservativeUtilityR <= 0) continue; // correct declines are not regret
    const cur = map.get(j.strategyId) ?? { strategyId: j.strategyId, missedCount: 0, forgoneUtilityR: 0 };
    cur.missedCount += 1;
    cur.forgoneUtilityR += j.forgoneConservativeUtilityR;
    map.set(j.strategyId, cur);
  }
  return [...map.values()];
}
