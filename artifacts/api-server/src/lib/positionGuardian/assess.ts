// Position Guardian — post-fill protection check (pure).
//
// After a broker fill, and on every broker position snapshot after it, the
// guardian compares what the broker actually holds against what ARX governed:
// the stop and size the Risk Governor approved at entry, as moved since by
// approved modifies. This file only decides; lib/positionGuardian/reconcile.ts
// loads the facts, applies the correction and writes the audit row.
//
// Invariant: the guardian only ever moves a stop back to the governed level,
// which is always tighter than what the broker holds. It never widens risk,
// never closes a position and never adds size. Anything it cannot fix that
// way is escalated to the trader with the exact discrepancy.

export type GuardianFinding =
  | "PROTECTED"              // broker stop matches the governed stop
  | "PROTECTED_TIGHTER"      // broker stop is tighter than governed (allowed)
  | "STOP_MISSING"           // broker position has no stop
  | "STOP_WIDENED"           // broker stop is further from price than governed
  | "TAKE_PROFIT_ALTERED"    // target differs; adds no risk, reported only
  | "SIZE_REDUCED"           // broker holds less than governed (partial close)
  | "SIZE_EXCEEDED"          // broker holds more than governed
  | "SIDE_MISMATCH"          // broker holds the opposite side
  | "POSITION_NOT_FOUND"     // fill confirmed but the broker does not list it
  | "SNAPSHOT_STALE"         // broker position facts are too old to judge
  | "PRICE_THROUGH_STOP"     // price is already past the governed stop
  | "NO_GOVERNED_STOP"       // ARX has no approved stop to restore
  | "CORRECTION_PENDING";    // a guardian correction is already on its way

export type GuardianAction = "NONE" | "RESTORE_STOP" | "ESCALATE" | "WAIT";

export interface GovernedProtection {
  ticket: string;
  symbol: string;
  side: "BUY" | "SELL";
  lots: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** The command that last set the governed stop (entry or approved modify). */
  sourceCommandId: string;
  /** When the governed state took effect (fill or modify time). */
  governedAt: Date | null;
}

export interface BrokerProtection {
  present: boolean;
  side: string | null;
  lots: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  currentPrice: number | null;
  /** When the broker last reported this position (or the book, if absent). */
  observedAt: Date | null;
}

export interface AssessOptions {
  now: Date;
  /** Broker facts older than this cannot be judged. */
  maxSnapshotAgeMs: number;
  /** After a fill, how long the broker may take to list the position. */
  fillGraceMs: number;
  correctionPending?: boolean;
}

export interface GuardianAssessment {
  findings: GuardianFinding[];
  action: GuardianAction;
  /** Set when action is RESTORE_STOP: the governed stop to put back. */
  restoreStopTo: number | null;
  /** Tell the trader: always on ESCALATE, and alongside a restore that leaves something unfixed. */
  escalate: boolean;
  reason: string;
}

export const GUARDIAN_DEFAULTS = { maxSnapshotAgeMs: 2 * 60_000, fillGraceMs: 2 * 60_000 } as const;

const EPS = 1e-9;

function priceThroughStop(side: "BUY" | "SELL", price: number | null, stop: number): boolean {
  if (price == null || !Number.isFinite(price)) return false;
  return side === "BUY" ? price <= stop + EPS : price >= stop - EPS;
}

/** True when `broker` is further from price than `governed` (or missing). */
export function stopIsWider(side: "BUY" | "SELL", governed: number, broker: number | null): boolean {
  if (broker == null) return true;
  return side === "BUY" ? broker < governed - EPS : broker > governed + EPS;
}

export function assessProtection(g: GovernedProtection, b: BrokerProtection, opts: AssessOptions): GuardianAssessment {
  const findings: GuardianFinding[] = [];
  const done = (action: GuardianAction, reason: string, restoreStopTo: number | null = null, escalate = action === "ESCALATE"): GuardianAssessment =>
    ({ findings, action, restoreStopTo, escalate, reason });
  const inGrace = g.governedAt != null && opts.now.getTime() - g.governedAt.getTime() <= opts.fillGraceMs;

  if (opts.correctionPending) {
    findings.push("CORRECTION_PENDING");
    return done("WAIT", `A guardian correction for ticket ${g.ticket} is already on its way to the broker.`);
  }

  const age = b.observedAt ? opts.now.getTime() - b.observedAt.getTime() : null;
  if (age == null || age > opts.maxSnapshotAgeMs) {
    findings.push("SNAPSHOT_STALE");
    const when = b.observedAt ? `last reported ${Math.round((age ?? 0) / 1000)}s ago` : "never reported";
    return inGrace
      ? done("WAIT", `Waiting for the broker to report ticket ${g.ticket} (${when}).`)
      : done("ESCALATE", `Cannot verify the stop on ticket ${g.ticket}: broker position data is ${when}.`);
  }

  if (!b.present) {
    findings.push("POSITION_NOT_FOUND");
    return inGrace
      ? done("WAIT", `The fill for ticket ${g.ticket} is confirmed; waiting for the broker to list the position.`)
      : done("ESCALATE", `The broker does not list ticket ${g.ticket}, although ARX recorded its fill.`);
  }

  if (b.side != null && b.side.toUpperCase() !== g.side) {
    findings.push("SIDE_MISMATCH");
    return done("ESCALATE", `Ticket ${g.ticket} is ${b.side.toUpperCase()} at the broker but ARX governed a ${g.side}.`);
  }

  if (b.lots != null) {
    if (b.lots > g.lots + 1e-6) findings.push("SIZE_EXCEEDED");
    else if (b.lots < g.lots - 1e-6) findings.push("SIZE_REDUCED");
  }

  if (g.takeProfit != null && b.takeProfit != null && Math.abs(g.takeProfit - b.takeProfit) > EPS) {
    findings.push("TAKE_PROFIT_ALTERED");
  }

  if (g.stopLoss == null) {
    findings.push("NO_GOVERNED_STOP");
    return done("ESCALATE", `ARX has no approved stop for ticket ${g.ticket}, so it cannot verify or restore one.`);
  }

  const wider = stopIsWider(g.side, g.stopLoss, b.stopLoss);
  if (wider) {
    findings.push(b.stopLoss == null ? "STOP_MISSING" : "STOP_WIDENED");
    if (priceThroughStop(g.side, b.currentPrice, g.stopLoss)) {
      findings.push("PRICE_THROUGH_STOP");
      return done("ESCALATE",
        `Ticket ${g.ticket} has ${b.stopLoss == null ? "no stop" : `a stop at ${b.stopLoss}`} and price ${b.currentPrice} is already past the governed stop ${g.stopLoss}; it cannot be restored and needs your decision.`);
    }
  } else {
    findings.push(b.stopLoss != null && Math.abs(b.stopLoss - g.stopLoss) > EPS ? "PROTECTED_TIGHTER" : "PROTECTED");
  }

  const oversize = findings.includes("SIZE_EXCEEDED")
    ? ` It also holds ${b.lots} lots at the broker, more than the ${g.lots} ARX governed; ARX never trims size on its own.`
    : "";
  if (wider) {
    return done("RESTORE_STOP",
      (b.stopLoss == null
        ? `Ticket ${g.ticket} has no stop at the broker; restoring the governed stop ${g.stopLoss}.`
        : `The stop on ticket ${g.ticket} was moved to ${b.stopLoss}, wider than the governed ${g.stopLoss}; restoring it.`) + oversize,
      g.stopLoss, oversize !== "");
  }
  if (oversize) return done("ESCALATE", `Ticket ${g.ticket} is protected by its stop.${oversize}`);
  return done("NONE", `Ticket ${g.ticket} is protected (broker stop ${b.stopLoss}, governed ${g.stopLoss}).`);
}
