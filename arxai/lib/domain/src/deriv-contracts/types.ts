// Deriv contract domain model — MULTIPLIER contracts first (R5 Phase 2 pure slice).
//
// CONSTRAINT (multi-broker spec §17:1040; audit-deriv.md G3 + §2 contract-type
// modeling note): Deriv contracts are modeled as their OWN domain types,
// explicitly DISTINCT from MT5 CFD position semantics. A Deriv multiplier
// contract is {stake, multiplier, optional stop-loss/take-profit AMOUNTS,
// optional deal cancellation} with a contract_id lifecycle. It has:
//   - NO volume / lots            (stake is the risk unit, not position size)
//   - NO SL/TP *prices*           (stopLoss/takeProfit are currency amounts)
//   - NO position ticket / netting semantics
// Constructing a Deriv intent from an MT5 command row (volume/SL-price/TP-price
// shaped) must be a type error at compile time and a coded refusal at runtime —
// never a best-effort mapping.
//
// CONSTRAINT (spec §10:749, §7; audit G5): stake bounds and allowed multiplier
// values come ONLY from a venue `contracts_for` capability payload supplied by
// the caller. Nothing in this module hardcodes venue limits; absent evidence
// yields UNKNOWN → refusal (honesty doctrine: UNKNOWN is a valid, blocking
// outcome — a guessed bound is worse than a refusal).
//
// Pure module: no I/O, no env reads, no logging, no network. Deterministic
// functions over caller-supplied evidence only.

/**
 * Account identity retained from a Deriv `authorize` response (audit G2).
 * The canonical shape shared by the WS client (retention) and the virtual
 * gate (consumption). Fields are null when the venue did not state them —
 * absence is preserved, never defaulted (a missing `is_virtual` must read
 * as UNKNOWN and refuse execution, not as demo).
 */
export interface DerivAccountIdentity {
  loginid: string | null;
  /** true = virtual/demo account; false = REAL account; null = venue never
   *  stated it (fail-closed: the virtual gate refuses null). */
  isVirtual: boolean | null;
  currency: string | null;
  landingCompany: string | null;
  /** Normalized DERIV_ENVIRONMENT declared by the operator at retention time
   *  ("demo" | "real" | other free text), or null when unset. Evidence only. */
  declaredEnvironment: string | null;
  /** true when the operator declared DERIV_ENVIRONMENT=demo but the venue
   *  reported a REAL account (is_virtual === false). Contradictory evidence —
   *  execution slices must refuse until the operator resolves it. */
  identityMismatch: boolean;
  /** When this identity was retained (ISO + epoch ms of the same instant). */
  retainedAt: string;
  retainedAtMs: number;
}

/** Deriv multiplier contract directions. Options/accumulators are LATER
 *  phases and get their own types when modeled — never widened onto this. */
export type DerivMultiplierContractType = "MULTUP" | "MULTDOWN";

/**
 * An intent to open ONE Deriv multiplier contract. Pure data — this slice
 * contains NO buy/sell/proposal network code; the intent exists so validators
 * and gates can be built and pinned before any execution client lands.
 */
export interface DerivMultiplierContractIntent {
  /** Discriminant. Its presence (and the absence of volume/lots fields) is
   *  what keeps MT5 CFD command rows structurally unassignable (spec §17). */
  readonly kind: "DERIV_MULTIPLIER_CONTRACT";
  contractType: DerivMultiplierContractType;
  /** Deriv venue symbol id (e.g. "R_75") — discovery-verified upstream. */
  symbol: string;
  /** Account currency the stake is denominated in. */
  currency: string;
  /** Stake amount — the money at risk (loss is stake-bounded). NOT lots. */
  stake: number;
  /** Venue multiplier value. Must be a member of the venue's advertised
   *  multiplier_range — exact membership, never rounded to nearest. */
  multiplier: number;
  /** Optional stop-loss AMOUNT in account currency. NOT a price level. */
  stopLoss?: number;
  /** Optional take-profit AMOUNT in account currency. NOT a price level. */
  takeProfit?: number;
  /** Optional deal-cancellation add-on request. Capability-gating of the
   *  cancellation window is a later slice (cancellation_range not yet modeled). */
  dealCancellation?: boolean;
}

/**
 * Multiplier capability for ONE symbol, distilled from a venue `contracts_for`
 * payload. Null-valued bounds mean the payload did not state them — validators
 * treat that as UNKNOWN and refuse, never substitute a guess.
 */
export interface DerivMultiplierCapability {
  /** The symbol this capability evidence was fetched for. */
  symbol: string;
  /** Multiplier contract directions the account/symbol actually supports. */
  contractTypes: DerivMultiplierContractType[];
  /** Exact allowed multiplier values advertised by the venue (deduped,
   *  ascending). Empty means the payload advertised none. */
  multiplierRange: number[];
  /** Most restrictive stake bounds found in the payload, or null when the
   *  payload carried none (contracts_for does not always state stake limits;
   *  a later slice may add proposal-derived bounds — until then, UNKNOWN). */
  minStake: number | null;
  maxStake: number | null;
  /** Currency the payload declared, when it declared one. */
  currency: string | null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isMultiplierContractType(v: unknown): v is DerivMultiplierContractType {
  return v === "MULTUP" || v === "MULTDOWN";
}

/**
 * Parse a raw venue `contracts_for` payload into a multiplier capability for
 * `expectedSymbol`. Accepts either the full response object ({ contracts_for })
 * or the contracts_for object itself. Returns null when the payload contains
 * no multiplier availability for the symbol — null is honest absence, and the
 * validator refuses on it. Malformed entries are skipped, never repaired;
 * entries whose underlying_symbol names a DIFFERENT symbol are excluded
 * (evidence for another instrument is not evidence for this one).
 */
export function parseMultiplierCapability(
  raw: unknown,
  expectedSymbol: string,
): DerivMultiplierCapability | null {
  if (typeof raw !== "object" || raw === null) return null;
  let container = raw as Record<string, unknown>;
  if (typeof container.contracts_for === "object" && container.contracts_for !== null) {
    container = container.contracts_for as Record<string, unknown>;
  }
  const available = container.available;
  if (!Array.isArray(available)) return null;

  const contractTypes = new Set<DerivMultiplierContractType>();
  const multipliers = new Set<number>();
  let minStake: number | null = null;
  let maxStake: number | null = null;
  let currency: string | null = null;

  for (const entry of available) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const isMultiplierEntry =
      rec.contract_category === "multiplier" || isMultiplierContractType(rec.contract_type);
    if (!isMultiplierEntry) continue;
    // Evidence scoping: an entry explicitly naming another underlying is not
    // capability evidence for expectedSymbol.
    if (typeof rec.underlying_symbol === "string" && rec.underlying_symbol !== expectedSymbol) {
      continue;
    }
    if (isMultiplierContractType(rec.contract_type)) contractTypes.add(rec.contract_type);
    if (Array.isArray(rec.multiplier_range)) {
      for (const m of rec.multiplier_range) {
        const n = asFiniteNumber(m);
        if (n !== null && n > 0) multipliers.add(n);
      }
    }
    // Most-restrictive intersection across entries: max of mins, min of maxes.
    const entryMin = asFiniteNumber(rec.min_stake);
    if (entryMin !== null) minStake = minStake === null ? entryMin : Math.max(minStake, entryMin);
    const entryMax = asFiniteNumber(rec.max_stake);
    if (entryMax !== null) maxStake = maxStake === null ? entryMax : Math.min(maxStake, entryMax);
    if (currency === null && typeof rec.currency === "string" && rec.currency.length > 0) {
      currency = rec.currency;
    }
  }

  if (contractTypes.size === 0) return null;
  return {
    symbol: expectedSymbol,
    contractTypes: [...contractTypes].sort() as DerivMultiplierContractType[],
    multiplierRange: [...multipliers].sort((a, b) => a - b),
    minStake,
    maxStake,
    currency,
  };
}

export type DerivContractValidationCode =
  | "INTENT_KIND_INVALID"
  | "CAPABILITY_MISSING"
  | "CAPABILITY_SYMBOL_MISMATCH"
  | "CONTRACT_TYPE_NOT_AVAILABLE"
  | "STAKE_NOT_A_POSITIVE_FINITE_NUMBER"
  | "STAKE_BOUNDS_UNKNOWN"
  | "STAKE_BELOW_VENUE_MINIMUM"
  | "STAKE_ABOVE_VENUE_MAXIMUM"
  | "MULTIPLIER_NOT_A_POSITIVE_FINITE_NUMBER"
  | "MULTIPLIER_RANGE_UNKNOWN"
  | "MULTIPLIER_NOT_IN_VENUE_RANGE"
  | "STOP_LOSS_NOT_A_POSITIVE_FINITE_AMOUNT"
  | "TAKE_PROFIT_NOT_A_POSITIVE_FINITE_AMOUNT"
  | "CURRENCY_MISMATCH";

export interface DerivContractValidationIssue {
  code: DerivContractValidationCode;
  message: string;
}

export interface DerivContractValidationResult {
  ok: boolean;
  /** ALL violations found, not just the first — deterministic order. */
  issues: DerivContractValidationIssue[];
}

/**
 * Validate a multiplier contract intent against venue capability evidence.
 * Fail-closed throughout: missing capability, unknown bounds, or an empty
 * multiplier range are refusals, not passes. Multiplier membership is exact —
 * the venue enumerates allowed values; nothing here rounds to the nearest.
 */
export function validateMultiplierContractIntent(
  intent: DerivMultiplierContractIntent,
  capability: DerivMultiplierCapability | null | undefined,
): DerivContractValidationResult {
  const issues: DerivContractValidationIssue[] = [];
  const add = (code: DerivContractValidationCode, message: string) => {
    issues.push({ code, message });
  };

  // Runtime discriminant guard: an MT5 command row (volume/SL-price shaped)
  // smuggled in via a cast must be refused here, not mapped (spec §17:1040).
  const rec = intent as unknown as Record<string, unknown>;
  if (rec.kind !== "DERIV_MULTIPLIER_CONTRACT") {
    add("INTENT_KIND_INVALID", "intent is not a DERIV_MULTIPLIER_CONTRACT (MT5 CFD shapes are never mapped onto Deriv contracts)");
    return { ok: false, issues };
  }

  if (!capability) {
    add("CAPABILITY_MISSING", "no contracts_for capability evidence supplied — UNKNOWN capability refuses, it never passes");
    return { ok: false, issues };
  }
  if (capability.symbol !== intent.symbol) {
    add("CAPABILITY_SYMBOL_MISMATCH", `capability evidence is for ${capability.symbol}, intent is for ${intent.symbol}`);
  }
  if (!capability.contractTypes.includes(intent.contractType)) {
    add("CONTRACT_TYPE_NOT_AVAILABLE", `venue capability does not advertise ${intent.contractType} for ${capability.symbol}`);
  }

  // Stake: positive finite, then venue bounds (bounds UNKNOWN → refuse).
  if (!(typeof intent.stake === "number" && Number.isFinite(intent.stake) && intent.stake > 0)) {
    add("STAKE_NOT_A_POSITIVE_FINITE_NUMBER", "stake must be a positive finite amount");
  } else if (capability.minStake === null || capability.maxStake === null) {
    add("STAKE_BOUNDS_UNKNOWN", "venue stake bounds are not present in the capability evidence — refusing rather than guessing limits");
  } else {
    if (intent.stake < capability.minStake) {
      add("STAKE_BELOW_VENUE_MINIMUM", `stake ${intent.stake} is below the venue minimum ${capability.minStake}`);
    }
    if (intent.stake > capability.maxStake) {
      add("STAKE_ABOVE_VENUE_MAXIMUM", `stake ${intent.stake} is above the venue maximum ${capability.maxStake}`);
    }
  }

  // Multiplier: positive finite, then EXACT membership in the advertised range.
  if (!(typeof intent.multiplier === "number" && Number.isFinite(intent.multiplier) && intent.multiplier > 0)) {
    add("MULTIPLIER_NOT_A_POSITIVE_FINITE_NUMBER", "multiplier must be a positive finite number");
  } else if (capability.multiplierRange.length === 0) {
    add("MULTIPLIER_RANGE_UNKNOWN", "venue advertised no multiplier values — refusing rather than assuming a range");
  } else if (!capability.multiplierRange.includes(intent.multiplier)) {
    add("MULTIPLIER_NOT_IN_VENUE_RANGE", `multiplier ${intent.multiplier} is not one of the venue's advertised values [${capability.multiplierRange.join(", ")}]`);
  }

  if (intent.stopLoss !== undefined &&
      !(typeof intent.stopLoss === "number" && Number.isFinite(intent.stopLoss) && intent.stopLoss > 0)) {
    add("STOP_LOSS_NOT_A_POSITIVE_FINITE_AMOUNT", "stopLoss, when present, must be a positive finite AMOUNT (not a price)");
  }
  if (intent.takeProfit !== undefined &&
      !(typeof intent.takeProfit === "number" && Number.isFinite(intent.takeProfit) && intent.takeProfit > 0)) {
    add("TAKE_PROFIT_NOT_A_POSITIVE_FINITE_AMOUNT", "takeProfit, when present, must be a positive finite AMOUNT (not a price)");
  }

  // Currency is checked only when the capability evidence declared one —
  // contracts_for does not always carry currency; the venue re-validates at
  // proposal time. Checking absent evidence would be fabrication.
  if (capability.currency !== null && capability.currency !== intent.currency) {
    add("CURRENCY_MISMATCH", `intent currency ${intent.currency} does not match capability currency ${capability.currency}`);
  }

  return { ok: issues.length === 0, issues };
}
