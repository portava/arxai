// Phase 6 — the Personal Trading Constitution.
//
// The owner-authority policy layer. Every rule here is SERVER-AUTHORITATIVE:
// this module is pure and takes the constitution as data, and the only writer
// is the server-side repository. A client may submit a proposal; it can never
// submit the rules the proposal is judged against.
//
// Three invariants shape the whole design.
//
// 1. DEFAULT-DENY. An absent limit is not "no limit" — it is a refusal. A
//    constitution missing `maxRiskPerTradeUsd` refuses every trade rather than
//    permitting an unbounded one. This is the opposite of the usual config
//    default and is deliberate: the failure mode of a missing rule must be a
//    blocked trade, never an unlimited one.
//
// 2. TIGHTEN-ONLY COMPOSITION. A downstream setting (a strategy profile, a
//    session preference) may make a rule STRICTER. It may never weaken one.
//    `tightenConstitution` enforces that structurally by taking the min of
//    every ceiling and the intersection of every allow-list, so a downstream
//    layer literally cannot express "allow more".
//
// 3. RUBY MAY NEVER AUTHORIZE. The authority ladder is EXPLAIN → RECOMMEND →
//    PREPARE_TICKET, and there is no fourth rung. "Ruby authorized it" is not
//    representable in this type system, so no future edit can grant it by
//    setting a field.
//
// Contract-only: importing this evaluates nothing and dispatches nothing.

/** How far the AI may go. There is deliberately no AUTHORIZE rung. */
export const RUBY_AUTHORITY_LEVELS = ["EXPLAIN", "RECOMMEND", "PREPARE_TICKET"] as const;
export type RubyAuthorityLevel = (typeof RUBY_AUTHORITY_LEVELS)[number];

/** A UTC trading window. Minutes from midnight, [openMin, closeMin). */
export interface TradingWindow {
  /** 0=Sunday … 6=Saturday, matching Date#getUTCDay. */
  daysOfWeekUtc: number[];
  openMinuteUtc: number;
  closeMinuteUtc: number;
}

export interface LossStreakCooldown {
  /** Consecutive losses that trigger the cooldown. */
  losses: number;
  cooldownMinutes: number;
}

export interface TradingConstitution {
  constitutionId: string;
  userId: number;
  /** Monotonic. An approval ticket records the version that governed it. */
  version: number;

  allowedBrokers: string[];
  allowedAccountRefs: string[];
  allowedInstruments: string[];
  allowedMarketCategories: string[];
  allowedSessionsUtc: TradingWindow[];

  maxRiskPerTradeUsd: number;
  maxDailyLossUsd: number;
  /** null = not configured, which DENIES rather than permits (see evaluate). */
  maxWeeklyLossUsd: number | null;
  maxSimultaneousPositions: number;
  maxExposurePerSymbolUsd: number;
  maxTradesPerDay: number;

  requireStopLoss: boolean;
  requireTakeProfit: boolean;

  minStakeUsd: number;
  maxStakeUsd: number;
  minMultiplier: number;
  maxMultiplier: number;

  lossStreakCooldown: LossStreakCooldown | null;

  forbiddenInstruments: string[];
  forbiddenConditions: string[];

  rubyAuthority: RubyAuthorityLevel;
}

/** The venue-neutral order the Constitution judges. No lots, no venue shapes. */
export interface ConstitutionProposal {
  userId: number;
  broker: string;
  accountRef: string;
  instrument: string;
  marketCategory: string;
  side: "BUY" | "SELL";
  stakeUsd: number;
  multiplier: number;
  riskUsd: number;
  hasStopLoss: boolean;
  hasTakeProfit: boolean;
  /** Conditions observed at proposal time, e.g. "HIGH_IMPACT_NEWS_WINDOW". */
  conditions: string[];
}

/** Observed account state. Every field is required — absence denies. */
export interface ConstitutionObservedState {
  nowIso: string;
  realisedDailyLossUsd: number;
  realisedWeeklyLossUsd: number;
  openPositionCount: number;
  openExposureForSymbolUsd: number;
  tradesTakenToday: number;
  consecutiveLosses: number;
  /** ISO time of the most recent loss, for the cooldown clock. null = none. */
  lastLossAtIso: string | null;
}

export const CONSTITUTION_REFUSALS = [
  "CONSTITUTION_MISSING",
  "CONSTITUTION_MALFORMED",
  "USER_MISMATCH",
  "BROKER_NOT_ALLOWED",
  "ACCOUNT_NOT_ALLOWED",
  "INSTRUMENT_NOT_ALLOWED",
  "INSTRUMENT_FORBIDDEN",
  "MARKET_CATEGORY_NOT_ALLOWED",
  "OUTSIDE_TRADING_SESSION",
  "RISK_PER_TRADE_EXCEEDED",
  "DAILY_LOSS_LIMIT_REACHED",
  "WEEKLY_LOSS_LIMIT_REACHED",
  "MAX_SIMULTANEOUS_POSITIONS_REACHED",
  "SYMBOL_EXPOSURE_EXCEEDED",
  "DAILY_TRADE_COUNT_REACHED",
  "STOP_LOSS_REQUIRED",
  "TAKE_PROFIT_REQUIRED",
  "STAKE_OUT_OF_BOUNDS",
  "MULTIPLIER_OUT_OF_BOUNDS",
  "LOSS_STREAK_COOLDOWN_ACTIVE",
  "FORBIDDEN_CONDITION_PRESENT",
] as const;
export type ConstitutionRefusal = (typeof CONSTITUTION_REFUSALS)[number];

export interface ConstitutionVerdict {
  decision: "PERMIT" | "REFUSE";
  refusals: ConstitutionRefusal[];
  primaryRefusal: ConstitutionRefusal | null;
  /** The version that governed. Recorded on the approval ticket. */
  constitutionVersion: number | null;
  evaluatedAt: string;
}

const isFiniteNonNegative = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Minutes from UTC midnight for an ISO instant. */
function utcMinuteOfDay(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function withinAnyWindow(d: Date, windows: TradingWindow[]): boolean {
  const day = d.getUTCDay();
  const minute = utcMinuteOfDay(d);
  return windows.some((w) => {
    if (!Array.isArray(w.daysOfWeekUtc) || !w.daysOfWeekUtc.includes(day)) return false;
    // A window that wraps midnight (close <= open) covers [open, 1440) ∪ [0, close).
    if (w.closeMinuteUtc <= w.openMinuteUtc) {
      return minute >= w.openMinuteUtc || minute < w.closeMinuteUtc;
    }
    return minute >= w.openMinuteUtc && minute < w.closeMinuteUtc;
  });
}

/**
 * Structural validity. A constitution that is missing a ceiling, or carries a
 * nonsensical one, must REFUSE rather than be treated as permissive. Note that
 * `maxWeeklyLossUsd: null` is malformed on purpose: the owner listed a weekly
 * cap as required, so "not configured" denies instead of meaning "unlimited".
 */
export function constitutionIsWellFormed(c: TradingConstitution | null | undefined): c is TradingConstitution {
  if (!c || typeof c !== "object") return false;
  if (typeof c.constitutionId !== "string" || c.constitutionId.trim() === "") return false;
  if (!Number.isInteger(c.userId) || c.userId <= 0) return false;
  if (!Number.isInteger(c.version) || c.version < 1) return false;
  const lists: (keyof TradingConstitution)[] = [
    "allowedBrokers", "allowedAccountRefs", "allowedInstruments",
    "allowedMarketCategories", "forbiddenInstruments", "forbiddenConditions",
  ];
  for (const k of lists) if (!Array.isArray(c[k])) return false;
  if (!Array.isArray(c.allowedSessionsUtc)) return false;
  const ceilings: (keyof TradingConstitution)[] = [
    "maxRiskPerTradeUsd", "maxDailyLossUsd", "maxSimultaneousPositions",
    "maxExposurePerSymbolUsd", "maxTradesPerDay", "minStakeUsd", "maxStakeUsd",
    "minMultiplier", "maxMultiplier",
  ];
  for (const k of ceilings) if (!isFiniteNonNegative(c[k])) return false;
  if (!isFiniteNonNegative(c.maxWeeklyLossUsd)) return false;
  if (c.maxStakeUsd < c.minStakeUsd) return false;
  if (c.maxMultiplier < c.minMultiplier) return false;
  if (typeof c.requireStopLoss !== "boolean") return false;
  if (typeof c.requireTakeProfit !== "boolean") return false;
  if (!(RUBY_AUTHORITY_LEVELS as readonly string[]).includes(c.rubyAuthority)) return false;
  if (c.lossStreakCooldown !== null) {
    const ls = c.lossStreakCooldown;
    if (!ls || !Number.isInteger(ls.losses) || ls.losses < 1) return false;
    if (!isFiniteNonNegative(ls.cooldownMinutes)) return false;
  }
  return true;
}

/**
 * The evaluation. Pure, total, and default-deny at every branch: a missing
 * constitution, a malformed one, or an observed-state field that is not a
 * finite number all REFUSE.
 */
export function evaluateConstitution(
  constitution: TradingConstitution | null | undefined,
  proposal: ConstitutionProposal,
  observed: ConstitutionObservedState,
): ConstitutionVerdict {
  const evaluatedAt = observed?.nowIso ?? "";
  const refuse = (r: ConstitutionRefusal[], version: number | null): ConstitutionVerdict => ({
    decision: "REFUSE",
    refusals: r,
    primaryRefusal: r[0] ?? null,
    constitutionVersion: version,
    evaluatedAt,
  });

  if (constitution === null || constitution === undefined) {
    return refuse(["CONSTITUTION_MISSING"], null);
  }
  if (!constitutionIsWellFormed(constitution)) {
    return refuse(["CONSTITUTION_MALFORMED"], null);
  }
  const v = constitution.version;

  // An observed state we cannot trust denies. Treating an unreadable daily loss
  // as zero would let a blown account keep trading.
  const numericObserved: (keyof ConstitutionObservedState)[] = [
    "realisedDailyLossUsd", "realisedWeeklyLossUsd", "openPositionCount",
    "openExposureForSymbolUsd", "tradesTakenToday", "consecutiveLosses",
  ];
  for (const k of numericObserved) {
    if (!isFiniteNonNegative(observed?.[k])) return refuse(["CONSTITUTION_MALFORMED"], v);
  }
  const now = new Date(observed.nowIso);
  if (Number.isNaN(now.getTime())) return refuse(["CONSTITUTION_MALFORMED"], v);

  const out: ConstitutionRefusal[] = [];

  // An approval may only ever govern its own user's account.
  if (proposal.userId !== constitution.userId) out.push("USER_MISMATCH");

  if (!constitution.allowedBrokers.includes(proposal.broker)) out.push("BROKER_NOT_ALLOWED");
  if (!constitution.allowedAccountRefs.includes(proposal.accountRef)) out.push("ACCOUNT_NOT_ALLOWED");

  // Forbidden beats allowed: listing an instrument in both refuses it.
  if (constitution.forbiddenInstruments.includes(proposal.instrument)) out.push("INSTRUMENT_FORBIDDEN");
  else if (!constitution.allowedInstruments.includes(proposal.instrument)) out.push("INSTRUMENT_NOT_ALLOWED");

  if (!constitution.allowedMarketCategories.includes(proposal.marketCategory)) {
    out.push("MARKET_CATEGORY_NOT_ALLOWED");
  }

  // No configured session means no permitted time, not "any time".
  if (!withinAnyWindow(now, constitution.allowedSessionsUtc)) out.push("OUTSIDE_TRADING_SESSION");

  if (!isFiniteNonNegative(proposal.riskUsd) || proposal.riskUsd > constitution.maxRiskPerTradeUsd) {
    out.push("RISK_PER_TRADE_EXCEEDED");
  }
  if (observed.realisedDailyLossUsd >= constitution.maxDailyLossUsd) out.push("DAILY_LOSS_LIMIT_REACHED");
  // Re-checked explicitly rather than asserted: a null weekly cap DENIES, and
  // narrowing it away with `!` would turn "not configured" into "unlimited" —
  // the precise inversion this module exists to prevent.
  const weeklyCap = constitution.maxWeeklyLossUsd;
  if (weeklyCap === null) out.push("CONSTITUTION_MALFORMED");
  else if (observed.realisedWeeklyLossUsd >= weeklyCap) out.push("WEEKLY_LOSS_LIMIT_REACHED");
  if (observed.openPositionCount >= constitution.maxSimultaneousPositions) {
    out.push("MAX_SIMULTANEOUS_POSITIONS_REACHED");
  }
  // The NEW stake adds to existing exposure — checking the existing figure
  // alone would let each order pass while the total breaches.
  if (observed.openExposureForSymbolUsd + (isFiniteNonNegative(proposal.stakeUsd) ? proposal.stakeUsd : Infinity)
      > constitution.maxExposurePerSymbolUsd) {
    out.push("SYMBOL_EXPOSURE_EXCEEDED");
  }
  if (observed.tradesTakenToday >= constitution.maxTradesPerDay) out.push("DAILY_TRADE_COUNT_REACHED");

  if (constitution.requireStopLoss && proposal.hasStopLoss !== true) out.push("STOP_LOSS_REQUIRED");
  if (constitution.requireTakeProfit && proposal.hasTakeProfit !== true) out.push("TAKE_PROFIT_REQUIRED");

  if (!isFiniteNonNegative(proposal.stakeUsd)
      || proposal.stakeUsd < constitution.minStakeUsd
      || proposal.stakeUsd > constitution.maxStakeUsd) {
    out.push("STAKE_OUT_OF_BOUNDS");
  }
  if (!isFiniteNonNegative(proposal.multiplier)
      || proposal.multiplier < constitution.minMultiplier
      || proposal.multiplier > constitution.maxMultiplier) {
    out.push("MULTIPLIER_OUT_OF_BOUNDS");
  }

  const cd = constitution.lossStreakCooldown;
  if (cd && observed.consecutiveLosses >= cd.losses) {
    // Streak reached. Still cooling unless a valid last-loss time proves the
    // window has elapsed — an unreadable timestamp keeps the cooldown ON.
    const last = observed.lastLossAtIso ? new Date(observed.lastLossAtIso) : null;
    const elapsedMs = last && !Number.isNaN(last.getTime()) ? now.getTime() - last.getTime() : -1;
    if (elapsedMs < cd.cooldownMinutes * 60_000) out.push("LOSS_STREAK_COOLDOWN_ACTIVE");
  }

  const conditions = Array.isArray(proposal.conditions) ? proposal.conditions : null;
  if (conditions === null) out.push("CONSTITUTION_MALFORMED");
  else if (conditions.some((c) => constitution.forbiddenConditions.includes(c))) {
    out.push("FORBIDDEN_CONDITION_PRESENT");
  }

  return out.length === 0
    ? { decision: "PERMIT", refusals: [], primaryRefusal: null, constitutionVersion: v, evaluatedAt }
    : refuse(out, v);
}

/**
 * Compose a downstream layer onto the Constitution. Structurally tighten-only:
 * every ceiling becomes the MINIMUM of the two, every floor the MAXIMUM, every
 * allow-list the INTERSECTION, every deny-list the UNION, and every boolean
 * requirement an OR. There is no code path by which the result is looser than
 * `base` on any field — which is why a downstream setting cannot weaken the
 * Constitution even if it tries.
 *
 * `version` and identity always come from the base: a downstream layer refines
 * a constitution, it does not become one.
 */
export function tightenConstitution(
  base: TradingConstitution,
  downstream: Partial<Omit<TradingConstitution, "constitutionId" | "userId" | "version">>,
): TradingConstitution {
  const minOf = (a: number, b: number | undefined) =>
    typeof b === "number" && Number.isFinite(b) ? Math.min(a, b) : a;
  const maxOf = (a: number, b: number | undefined) =>
    typeof b === "number" && Number.isFinite(b) ? Math.max(a, b) : a;
  const intersect = (a: string[], b: string[] | undefined) =>
    Array.isArray(b) ? a.filter((x) => b.includes(x)) : a;
  const union = (a: string[], b: string[] | undefined) =>
    Array.isArray(b) ? Array.from(new Set([...a, ...b])) : a;

  // Sessions intersect by INTERSECTION of the window sets: a downstream layer
  // may only remove permitted time, never add it.
  const sessions = Array.isArray(downstream.allowedSessionsUtc)
    ? base.allowedSessionsUtc.filter((w) =>
        downstream.allowedSessionsUtc!.some((d) =>
          d.openMinuteUtc <= w.openMinuteUtc
          && d.closeMinuteUtc >= w.closeMinuteUtc
          && w.daysOfWeekUtc.every((day) => d.daysOfWeekUtc.includes(day))))
    : base.allowedSessionsUtc;

  // Authority may only be REDUCED down the ladder.
  const rank = (l: RubyAuthorityLevel) => RUBY_AUTHORITY_LEVELS.indexOf(l);
  const authority = downstream.rubyAuthority
    && rank(downstream.rubyAuthority) < rank(base.rubyAuthority)
      ? downstream.rubyAuthority
      : base.rubyAuthority;

  return {
    constitutionId: base.constitutionId,
    userId: base.userId,
    version: base.version,
    allowedBrokers: intersect(base.allowedBrokers, downstream.allowedBrokers),
    allowedAccountRefs: intersect(base.allowedAccountRefs, downstream.allowedAccountRefs),
    allowedInstruments: intersect(base.allowedInstruments, downstream.allowedInstruments),
    allowedMarketCategories: intersect(base.allowedMarketCategories, downstream.allowedMarketCategories),
    allowedSessionsUtc: sessions,
    maxRiskPerTradeUsd: minOf(base.maxRiskPerTradeUsd, downstream.maxRiskPerTradeUsd),
    maxDailyLossUsd: minOf(base.maxDailyLossUsd, downstream.maxDailyLossUsd),
    maxWeeklyLossUsd: base.maxWeeklyLossUsd === null
      ? null
      : minOf(base.maxWeeklyLossUsd, downstream.maxWeeklyLossUsd ?? undefined),
    maxSimultaneousPositions: minOf(base.maxSimultaneousPositions, downstream.maxSimultaneousPositions),
    maxExposurePerSymbolUsd: minOf(base.maxExposurePerSymbolUsd, downstream.maxExposurePerSymbolUsd),
    maxTradesPerDay: minOf(base.maxTradesPerDay, downstream.maxTradesPerDay),
    requireStopLoss: base.requireStopLoss || downstream.requireStopLoss === true,
    requireTakeProfit: base.requireTakeProfit || downstream.requireTakeProfit === true,
    minStakeUsd: maxOf(base.minStakeUsd, downstream.minStakeUsd),
    maxStakeUsd: minOf(base.maxStakeUsd, downstream.maxStakeUsd),
    minMultiplier: maxOf(base.minMultiplier, downstream.minMultiplier),
    maxMultiplier: minOf(base.maxMultiplier, downstream.maxMultiplier),
    lossStreakCooldown: (() => {
      const d = downstream.lossStreakCooldown;
      if (!d) return base.lossStreakCooldown;
      if (!base.lossStreakCooldown) return d;
      // Stricter = triggers on FEWER losses and cools for LONGER.
      return {
        losses: Math.min(base.lossStreakCooldown.losses, d.losses),
        cooldownMinutes: Math.max(base.lossStreakCooldown.cooldownMinutes, d.cooldownMinutes),
      };
    })(),
    forbiddenInstruments: union(base.forbiddenInstruments, downstream.forbiddenInstruments),
    forbiddenConditions: union(base.forbiddenConditions, downstream.forbiddenConditions),
    rubyAuthority: authority,
  };
}
