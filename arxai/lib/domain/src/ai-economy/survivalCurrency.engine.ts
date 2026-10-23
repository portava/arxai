import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Survival Currency — chips earned by NOT BLOWING UP. Core project rule:
// survival quality matters more than raw profit. Currency is earned from
// survival quality (drawdown control + capital preservation), and it
// determines the agent's CLAIM on capital allocation. Spending currency
// "buys" allocation; bad survival burns it.
//
// All mutation happens through the SurvivalCurrencyLedgerPort. Pure
// functions compute the deltas; the port records them.
// ═══════════════════════════════════════════════════════════════════════════

export const SurvivalCurrencyEventSchema = z.object({
  agentId: z.string().min(1),
  survivalScore01: z.number().min(0).max(1),
  windowSampleCount: z.int().nonnegative(),
  drawdownIncidents: z.int().nonnegative(),  // catastrophic incidents in window
  observedAtIso: z.string(),
});
export type SurvivalCurrencyEvent = z.infer<typeof SurvivalCurrencyEventSchema>;

export const SurvivalCurrencyLedgerEntrySchema = z.object({
  agentId: z.string().min(1),
  delta: z.number(),                         // signed
  reason: z.enum(["EARN", "SPEND", "BURN"]),
  recordedAtIso: z.string(),
  notes: z.array(z.string()),
});
export type SurvivalCurrencyLedgerEntry = z.infer<typeof SurvivalCurrencyLedgerEntrySchema>;

export interface SurvivalCurrencyLedgerPort {
  append(entry: SurvivalCurrencyLedgerEntry): Promise<void>;
  list(agentId: string): Promise<SurvivalCurrencyLedgerEntry[]>;
}

export const SURVIVAL_CURRENCY_TUNING = {
  // Per-window earnable currency. Scaled by survivalScore².
  maxEarnPerWindow: 100,
  // Burn rate per drawdown incident in the window.
  burnPerIncident: 50,
  // Earn requires minimum survivalScore floor — below it, earn is zero.
  earnFloor: 0.50,
  // Defensive: minimum window samples to earn anything.
  minSamplesToEarn: 25,
} as const;

export interface EarnResult {
  earned: number;
  burned: number;
  netDelta: number;
  reasons: string[];
  blockers: string[];
}

export function computeEarnDelta(event: SurvivalCurrencyEvent): EarnResult {
  const T = SURVIVAL_CURRENCY_TUNING;
  const reasons: string[] = [];
  const blockers: string[] = [];

  let earned = 0;
  if (event.windowSampleCount < T.minSamplesToEarn) {
    blockers.push(`window samples ${event.windowSampleCount} < ${T.minSamplesToEarn} — no earn`);
  } else if (event.survivalScore01 < T.earnFloor) {
    blockers.push(`survival ${event.survivalScore01.toFixed(3)} < earn floor ${T.earnFloor} — no earn`);
  } else {
    // Quadratic in survivalScore — strongly rewards excellent survival.
    earned = T.maxEarnPerWindow * event.survivalScore01 * event.survivalScore01;
    reasons.push(`earn = ${T.maxEarnPerWindow} × survival² (${event.survivalScore01.toFixed(3)}²) = ${earned.toFixed(2)}`);
  }

  const burned = event.drawdownIncidents * T.burnPerIncident;
  if (burned > 0) reasons.push(`burn = ${event.drawdownIncidents} × ${T.burnPerIncident} = ${burned.toFixed(2)}`);

  const netDelta = earned - burned;
  reasons.push(`netDelta = earn ${earned.toFixed(2)} − burn ${burned.toFixed(2)} = ${netDelta.toFixed(2)}`);
  return { earned, burned, netDelta, reasons, blockers };
}

export interface SpendDecision {
  approved: boolean;
  spent: number;
  remaining: number;
  reasons: string[];
  blockers: string[];
}

// computeSpend — agent requests N currency to "buy" capital allocation.
// Defensive: cannot spend below zero (no debt). If requested > balance,
// REJECT entirely (no partial spends — keeps allocation negotiation clean).
export function computeSpend(currentBalance: number, requested: number): SpendDecision {
  const reasons: string[] = [];
  const blockers: string[] = [];
  if (requested <= 0) {
    blockers.push(`requested ${requested} must be > 0`);
    return { approved: false, spent: 0, remaining: currentBalance, reasons, blockers };
  }
  if (requested > currentBalance) {
    blockers.push(`requested ${requested.toFixed(2)} > balance ${currentBalance.toFixed(2)} — REJECT`);
    return { approved: false, spent: 0, remaining: currentBalance, reasons, blockers };
  }
  const remaining = Math.max(0, currentBalance - requested);
  reasons.push(`spent ${requested.toFixed(2)} of ${currentBalance.toFixed(2)} → remaining ${remaining.toFixed(2)}`);
  return { approved: true, spent: requested, remaining, reasons, blockers };
}

export function createInMemorySurvivalCurrencyLedger(): SurvivalCurrencyLedgerPort {
  const entries: SurvivalCurrencyLedgerEntry[] = [];
  return {
    async append(e) { entries.push({ ...e, notes: [...e.notes] }); },
    async list(agentId) {
      return entries
        .filter((e) => e.agentId === agentId)
        .map((e) => ({ ...e, notes: [...e.notes] }));
    },
  };
}
