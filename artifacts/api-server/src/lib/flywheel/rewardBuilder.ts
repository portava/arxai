// ── B1 — RewardBuilder (pure) ───────────────────────────────────────────────
//
// Rewards come ONLY from broker-reconciled money truth: the balanced journals
// in economic_postings (lib/accounting's double-entry spine) — NEVER from
// theoretical prices, chart marks, or the draft's own pnl field. The reward is
// the net log-return  ln(1 + netPnl / equityBase)  where
//
//   netPnl     = realized P&L − fees − funding, summed over the case's
//                posting legs (corrections included naturally: a reversal's
//                negated legs cancel the journal they reverse), and
//   equityBase = the broker-reconciled equity in force at the close
//                (reconciliation baseline + posting-ledger cash — both from
//                the accounting spine, supplied by the caller).
//
// HONESTY CONTRACT (inviolable):
//   * UNKNOWN IS EXCLUDED, NEVER GUESSED. Any value_unknown leg among the
//     case's P&L/fee/funding postings (the broker reported an event but not
//     its amount) makes the reward UNRECONCILED with reason UNKNOWN_FEES /
//     UNKNOWN_PNL — it is excluded downstream, not approximated.
//   * NO POSTINGS, NO REWARD (reason NO_POSTINGS). A draft's pnl column is a
//     display convenience, not settlement evidence.
//   * NO EQUITY BASE, NO REWARD (reason NO_EQUITY_BASE). A log-return without
//     a denominator would be a fabricated normalization.
//   * A growth factor ≤ 0 (netPnl ≤ −equityBase) refuses with
//     GROWTH_FACTOR_NONPOSITIVE — ln of a non-positive number is not a number
//     to feed a posterior; the case is surfaced, not clamped.
//
// FLYWHEEL INVARIANT: pure — no IO, no clock, no randomness, no import from
// any gate/floor/stop/dispatch path.

export type RewardStatus = "RECONCILED" | "UNRECONCILED";

/** The posting-leg slice the builder reads (economic_postings columns). */
export interface RewardPostingLeg {
  journalId: string;
  kind: string;          // TRADE_CLOSE_PNL | TRADE_CLOSE_FEE | ... | CORRECTION_*
  account: string;       // lib/accounting ECONOMIC_ACCOUNTS code
  amountMinor: bigint;
  currency: string;
  scale: number;
  valueUnknown: boolean;
  ledger: string;
}

export interface RewardBuildInput {
  caseId: string;
  userId: number;
  strategyId: string;
  regimeLabel: string;
  instrument: string;
  /** ALL posting legs recorded for the case's commandId. */
  postings: readonly RewardPostingLeg[];
  /** Broker-reconciled equity base (minor units) at close; null = not known. */
  equityBaseMinor: bigint | null;
}

export interface FlywheelReward {
  rewardId: string;
  caseId: string;
  userId: number;
  ledger: string | null;
  strategyId: string;
  regimeLabel: string;
  instrument: string;
  status: RewardStatus;
  /** Present exactly when status === "RECONCILED". */
  netLogReturn: number | null;
  netPnlMinor: bigint | null;
  equityBaseMinor: bigint | null;
  currency: string | null;
  scale: number | null;
  journalIds: string[];
  reasons: string[];
}

/** Accounts whose legs constitute the trade's net economic outcome. The signs
 *  follow lib/accounting's conventions: the REALIZED_PNL leg is posted as
 *  −pnl (income convention), FEES/FUNDING legs are posted as +cost. */
const PNL_ACCOUNT = "REALIZED_PNL";
const COST_ACCOUNTS = new Set(["FEES_EXPENSE", "FUNDING_EXPENSE"]);

function unreconciled(
  input: RewardBuildInput,
  ledger: string | null,
  journalIds: string[],
  reasons: string[],
): FlywheelReward {
  return {
    rewardId: `rw_${input.caseId}`,
    caseId: input.caseId,
    userId: input.userId,
    ledger,
    strategyId: input.strategyId,
    regimeLabel: input.regimeLabel,
    instrument: input.instrument,
    status: "UNRECONCILED",
    netLogReturn: null,
    netPnlMinor: null,
    equityBaseMinor: input.equityBaseMinor,
    currency: null,
    scale: null,
    journalIds,
    reasons,
  };
}

/**
 * PURE — build one reward from the case's postings. Never throws; every
 * refusal is an UNRECONCILED reward with machine reasons.
 */
export function buildReward(input: RewardBuildInput): FlywheelReward {
  const reasons: string[] = [];
  const relevant = input.postings.filter(
    (p) => p.account === PNL_ACCOUNT || COST_ACCOUNTS.has(p.account) || p.valueUnknown,
  );
  const journalIds = [...new Set(input.postings.map((p) => p.journalId))];
  const ledgers = new Set(input.postings.map((p) => p.ledger));
  const ledger = ledgers.size === 1 ? [...ledgers][0]! : null;

  if (input.postings.length === 0) {
    return unreconciled(input, ledger, journalIds, [
      "NO_POSTINGS: no economic postings exist for this case — a reward without settlement evidence is not built",
    ]);
  }
  if (ledgers.size > 1) {
    reasons.push(`LEDGER_AMBIGUOUS: postings span ${[...ledgers].join(",")}`);
    return unreconciled(input, null, journalIds, reasons);
  }

  // UNKNOWN legs: the broker reported an event whose amount ARX does not
  // know. The flagged zero is honesty, not a value — the reward is excluded.
  const unknowns = relevant.filter((p) => p.valueUnknown);
  if (unknowns.length > 0) {
    const kinds = [...new Set(unknowns.map((p) => p.kind))];
    for (const kind of kinds) {
      reasons.push(
        kind === "TRADE_CLOSE_PNL"
          ? "UNKNOWN_PNL: realized P&L amount not reported by the broker — excluded, not guessed"
          : `UNKNOWN_FEES: ${kind} amount not reported by the broker — excluded, not guessed`,
      );
    }
    return unreconciled(input, ledger, journalIds, reasons);
  }

  const pnlLegs = relevant.filter((p) => p.account === PNL_ACCOUNT);
  if (pnlLegs.length === 0) {
    return unreconciled(input, ledger, journalIds, [
      "NO_PNL_POSTING: no realized-P&L journal exists for this case",
    ]);
  }

  // One currency/scale or refuse — mixed-currency netting is a plug in disguise.
  const currencies = new Set(relevant.map((p) => `${p.currency}:${p.scale}`));
  if (currencies.size > 1) {
    return unreconciled(input, ledger, journalIds, [
      `MIXED_CURRENCY: postings span ${[...currencies].join(",")} — refused, never converted here`,
    ]);
  }
  const currency = relevant[0]!.currency;
  const scale = relevant[0]!.scale;

  // netPnl = pnl − fees − funding. REALIZED_PNL legs carry −pnl, cost legs
  // carry +cost, so netPnl = −(Σ pnlLegs) − (Σ costLegs). Correction
  // reversals negate their originals and cancel in the same sums.
  const sumPnlLegs = pnlLegs.reduce((s, p) => s + p.amountMinor, 0n);
  const sumCostLegs = relevant
    .filter((p) => COST_ACCOUNTS.has(p.account))
    .reduce((s, p) => s + p.amountMinor, 0n);
  const netPnlMinor = -sumPnlLegs - sumCostLegs;

  if (input.equityBaseMinor === null || input.equityBaseMinor <= 0n) {
    return unreconciled(input, ledger, journalIds, [
      "NO_EQUITY_BASE: no broker-reconciled equity base at close — a log-return without a real denominator would be fabricated",
    ]);
  }

  const growth = 1 + Number(netPnlMinor) / Number(input.equityBaseMinor);
  if (!(growth > 0)) {
    return unreconciled(input, ledger, journalIds, [
      `GROWTH_FACTOR_NONPOSITIVE: netPnl ${netPnlMinor} vs equity ${input.equityBaseMinor} — ln undefined; surfaced, not clamped`,
    ]);
  }

  return {
    rewardId: `rw_${input.caseId}`,
    caseId: input.caseId,
    userId: input.userId,
    ledger,
    strategyId: input.strategyId,
    regimeLabel: input.regimeLabel,
    instrument: input.instrument,
    status: "RECONCILED",
    netLogReturn: Math.log(growth),
    netPnlMinor,
    equityBaseMinor: input.equityBaseMinor,
    currency,
    scale,
    journalIds,
    reasons: [],
  };
}
