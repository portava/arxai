// Broker-statement reconciliation — the PURE comparison (#29/#30/#31).
//
// The worker (api-server economicReconciliationWorker) gathers the inputs;
// THIS module decides the verdict, deterministically, using the truth-
// hierarchy contract. It cannot write, adjust, or correct anything — its
// output type has no "fix" field on purpose. A discrepancy is SURFACED as a
// record for journaling; adjusting the ledger to match the broker (or vice
// versa) is a human decision that must arrive as an explicit correction
// journal, never as a side effect of a comparison.
//
// BASELINE, honestly: the posting ledger starts empty mid-life of a broker
// account, so absolute balances cannot match on day one. The first successful
// comparison ESTABLISHES a baseline (broker balance minus ledger cash at that
// moment) and says so loudly (verdict BASELINE_ESTABLISHED — not MATCHED,
// because nothing was verified). Every later run checks
//   broker_balance == baseline + sum(BROKER_CASH postings)
// and any drift is a DISCREPANCY naming both sides and the truth winner.

import { Money } from "@workspace/money";
import {
  outranks, type TruthSource,
} from "@workspace/domain/safety-contracts/truthHierarchy";

export const RECONCILIATION_VERDICTS = [
  "MATCHED",
  "DISCREPANCY",
  "BASELINE_ESTABLISHED",
  "UNKNOWN",
] as const;
export type ReconciliationVerdict = (typeof RECONCILIATION_VERDICTS)[number];

export interface LedgerBrokerComparisonInput {
  /** Broker-reported account balance, or null when unavailable. */
  brokerBalance: Money | null;
  /** Which truth source the broker figure is (BROKER_STATEMENT or BROKER_EVENT). */
  brokerSource: TruthSource;
  /** Sum of BROKER_CASH postings for this user+ledger (exact minor units). */
  ledgerCash: Money;
  /** The truth source the ledger sum is derived from (LOCAL_EXECUTION). */
  ledgerSource: TruthSource;
  /** Established baseline (broker − ledger at first observation), or null. */
  baseline: Money | null;
  /** Age of the broker figure in ms, or null when its freshness is unknown. */
  snapshotAgeMs: number | null;
  /** Oldest broker figure still comparable (older → honest UNKNOWN). */
  staleAfterMs: number;
}

export interface LedgerBrokerComparison {
  verdict: ReconciliationVerdict;
  /** Non-null only for BASELINE_ESTABLISHED: the baseline to persist. */
  establishedBaseline: Money | null;
  /** broker − (baseline + ledgerCash); non-null only when comparable. */
  difference: Money | null;
  /** For a DISCREPANCY: which source prevails per the truth hierarchy. */
  truthWinner: TruthSource | null;
  /** Human-readable, honest reason. Always present. */
  reason: string;
}

/**
 * Compare the posting ledger against the broker's reported balance.
 * Deterministic, total (never throws on honest-null inputs), and adjustment-
 * free by construction.
 */
export function compareLedgerToBroker(input: LedgerBrokerComparisonInput): LedgerBrokerComparison {
  if (input.brokerBalance == null) {
    return {
      verdict: "UNKNOWN",
      establishedBaseline: null,
      difference: null,
      truthWinner: null,
      reason: "broker balance unavailable — comparison degraded to honest UNKNOWN, nothing synthesized",
    };
  }
  if (input.snapshotAgeMs == null || input.snapshotAgeMs > input.staleAfterMs) {
    return {
      verdict: "UNKNOWN",
      establishedBaseline: null,
      difference: null,
      truthWinner: null,
      reason: `broker balance is stale (age ${input.snapshotAgeMs == null ? "unknown" : `${input.snapshotAgeMs}ms`} > ${input.staleAfterMs}ms) — stale data is reported stale, never compared as fresh`,
    };
  }
  if (
    input.brokerBalance.currency !== input.ledgerCash.currency
    || input.brokerBalance.scale !== input.ledgerCash.scale
  ) {
    return {
      verdict: "UNKNOWN",
      establishedBaseline: null,
      difference: null,
      truthWinner: null,
      reason: `currency mismatch: broker reports ${input.brokerBalance.currency}@${input.brokerBalance.scale}, ledger holds ${input.ledgerCash.currency}@${input.ledgerCash.scale} — refusing to compare across currencies`,
    };
  }
  if (input.baseline == null) {
    const baseline = input.brokerBalance.sub(input.ledgerCash);
    return {
      verdict: "BASELINE_ESTABLISHED",
      establishedBaseline: baseline,
      difference: null,
      truthWinner: null,
      reason: `first comparison — baseline ${baseline.toString()} established (broker ${input.brokerBalance.toString()} minus ledger cash ${input.ledgerCash.toString()}); nothing verified yet`,
    };
  }
  const expected = input.baseline.add(input.ledgerCash);
  const difference = input.brokerBalance.sub(expected);
  if (difference.isZero()) {
    return {
      verdict: "MATCHED",
      establishedBaseline: null,
      difference,
      truthWinner: null,
      reason: `broker ${input.brokerBalance.toString()} equals baseline+ledger ${expected.toString()}`,
    };
  }
  // Deterministic precedence: the higher source prevails AND the disagreement
  // is surfaced. Equal rank would be unresolvable; the worker's sources are
  // broker-vs-local so the broker side wins here, but the contract decides.
  const winner: TruthSource | null =
    outranks(input.brokerSource, input.ledgerSource) ? input.brokerSource
      : outranks(input.ledgerSource, input.brokerSource) ? input.ledgerSource
      : null;
  return {
    verdict: "DISCREPANCY",
    establishedBaseline: null,
    difference,
    truthWinner: winner,
    reason: `broker ${input.brokerBalance.toString()} differs from baseline+ledger ${expected.toString()} by ${difference.toString()} — ${winner == null ? "sources are equally ranked: UNRESOLVED" : `${winner} prevails per the truth hierarchy`}; SURFACED ONLY, no auto-adjustment`,
  };
}

/** Broker snapshot older than this is not comparable (matches the account-sync staleness idea, generous for a daily pass). */
export const DEFAULT_BROKER_SNAPSHOT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
