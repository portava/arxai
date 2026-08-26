// Deriv NEW API — request mappers and response normalizers (spec Phases 5-8).
//
// This is the ONLY place new-generation Deriv shapes are spoken. Strategy,
// risk, sizing and execution policy consume ARX's normalized types and must
// never see a raw Deriv payload — that boundary is what lets a second venue
// exist without duplicating strategy code (Phase 16).
//
// KNOWN BREAKING CHANGE from legacy, and the reason this module exists rather
// than a search-and-replace:
//     legacy proposal: symbol
//     new proposal:    underlying_symbol
// `loginid` is removed entirely — the authenticated session carries the
// account context, so a request that names an account is speaking the old
// generation's language.
//
// UNVERIFIED-UNTIL-CERTIFIED: these shapes follow Deriv's current published
// schema but have not been exercised against the venue from this codebase.
// Phase 14's read-only certification is what promotes them from "written" to
// "trusted"; a mismatch is confined to this file by design.

import type { DerivMultiplierContractIntent } from "@workspace/domain/deriv-contracts";
import { DerivNewApiError } from "./errors.js";

/** Fields the new API no longer accepts. Pinned so a legacy payload cannot be
 *  copied across by accident.
 *
 *  `passthrough` was previously listed here and does NOT belong: all eight
 *  new-generation request schemas permit it as an optional property. The pin
 *  was over-restrictive rather than wrong on the wire — ARX sends none — but a
 *  pin asserting a false fact is a pin that will mislead the next reader. */
export const LEGACY_ONLY_FIELDS = ["symbol", "loginid"] as const;

// ── Requests ────────────────────────────────────────────────────────────────

export interface NewProposalRequest {
  proposal: 1;
  /** NEW generation: replaces legacy `symbol`. */
  underlying_symbol: string;
  contract_type: "MULTUP" | "MULTDOWN";
  amount: number;
  basis: "stake";
  currency: string;
  multiplier: number;
  limit_order?: { stop_loss?: number; take_profit?: number };
}

/**
 * Map an ARX intent to a new-API proposal.
 *
 * Does NOT re-validate limits: the intent is expected to have passed
 * `validateMultiplierContractIntent` against the account's discovered
 * capability. Silently clamping here would hide a rejected intent.
 */
export function mapProposalRequest(
  intent: DerivMultiplierContractIntent,
): NewProposalRequest {
  const req: NewProposalRequest = {
    proposal: 1,
    underlying_symbol: intent.symbol,
    contract_type: intent.contractType,
    amount: intent.stake,
    basis: "stake",
    currency: intent.currency,
    multiplier: intent.multiplier,
  };
  // Protection is OMITTED when unset — an explicit null means something
  // different to the venue than an absent block.
  const limit: { stop_loss?: number; take_profit?: number } = {};
  if (typeof intent.stopLoss === "number") limit.stop_loss = intent.stopLoss;
  if (typeof intent.takeProfit === "number") limit.take_profit = intent.takeProfit;
  if (Object.keys(limit).length > 0) req.limit_order = limit;
  return req;
}

export interface NewBuyRequest { buy: string; price: number }

/**
 * Map a buy. `maxPrice` is REQUIRED and must be finite and positive: the price
 * is a CEILING, and an unbounded buy accepts arbitrary repricing between quote
 * and execution. Refuses rather than substituting a default.
 */
export function mapBuyRequest(
  proposalId: string,
  maxPrice: number,
): NewBuyRequest | DerivNewApiError {
  if (typeof proposalId !== "string" || proposalId.length === 0) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "missing proposal id" });
  }
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "invalid max price" });
  }
  return { buy: proposalId, price: maxPrice };
}

export interface NewSellRequest { sell: number; price: number }

export function mapSellRequest(
  contractId: number,
  minProceeds: number,
): NewSellRequest | DerivNewApiError {
  if (!Number.isInteger(contractId) || contractId <= 0) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "invalid contract id" });
  }
  // 0 is legal — Deriv's documented sell-at-market sentinel.
  if (!Number.isFinite(minProceeds) || minProceeds < 0) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "invalid min proceeds" });
  }
  return { sell: contractId, price: minProceeds };
}

export const mapPortfolioRequest = (): { portfolio: 1 } => ({ portfolio: 1 });
export const mapBalanceRequest = (): { balance: 1 } => ({ balance: 1 });
export const mapActiveSymbolsRequest = (): { active_symbols: "brief" } =>
  ({ active_symbols: "brief" });

/**
 * Map a contracts_for query.
 *
 * Deriv's contracts_for_request schema is additionalProperties:false and
 * permits exactly three keys: contracts_for, passthrough, req_id. The symbol
 * is the VALUE, not a separate field — the proposal rename
 * (symbol -> underlying_symbol) does NOT propagate here.
 *
 * ARX previously sent `currency` (legacy-only, removed in this generation) and
 * `contract_type: "multiplier"` — which never existed on this operation in
 * EITHER generation, and whose value is not a member of any contract_type enum
 * (those are uppercase MULTUP/MULTDOWN). Two surplus keys against a strict
 * schema is exactly the InputValidationFailed the live run hit.
 *
 * Multiplier capability is discovered from the RESPONSE: available[] carries
 * contract_type and multiplier_range. It was never a request-side filter.
 */
export function mapContractsForRequest(
  underlyingSymbol: string,
): { contracts_for: string } | DerivNewApiError {
  // The schema's own constraint, rather than a bare falsy check.
  if (!/^\w{2,30}$/.test(underlyingSymbol)) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", {
      detail: "underlying symbol must match ^\\w{2,30}$",
    });
  }
  return { contracts_for: underlyingSymbol };
}

export function mapOpenContractRequest(
  contractId: number,
): { proposal_open_contract: 1; contract_id: number } | DerivNewApiError {
  if (!Number.isInteger(contractId) || contractId <= 0) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "invalid contract id" });
  }
  return { proposal_open_contract: 1, contract_id: contractId };
}

/**
 * Read a numeric field that Deriv may send as either a number or a string.
 *
 * Returns null for anything else — never 0. A missing price must stay unstated
 * rather than becoming a free contract.
 */
export function numeric(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ── Normalized responses (ARX types, not Deriv types) ───────────────────────

export interface ArxProposal {
  proposalId: string;
  /** The price ARX would pay. Null when Deriv omitted it — never defaulted. */
  askPrice: number | null;
  payout: number | null;
  spotPrice: number | null;
}

/**
 * Normalize a proposal response.
 *
 * A quote WITHOUT an id is unusable — it cannot be bought — so it is a protocol
 * error rather than a half-populated object that fails later at buy time.
 */
export function normalizeProposal(msg: unknown): ArxProposal | DerivNewApiError {
  const p = (msg as { proposal?: unknown } | null)?.proposal;
  if (typeof p !== "object" || p === null) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "no proposal block" });
  }
  const r = p as Record<string, unknown>;
  const id = r["id"];
  if (typeof id !== "string" || id.length === 0) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "proposal carried no id" });
  }
  // DOCS CONFLICT, deliberately unresolved: proposal_response.schema.json types
  // ask_price/payout/spot as `number`, while Deriv's own migration page says
  // "Several response fields now accept both numbers and strings". One is
  // stale and the documentation does not say which, so both are accepted —
  // the same approach that resolved the OTP nesting. A numeric string is a
  // value Deriv states it may send; "" and "abc" are still null.
  const num = numeric;
  return {
    proposalId: id,
    askPrice: num(r["ask_price"]),
    payout: num(r["payout"]),
    spotPrice: num(r["spot"]),
  };
}

export interface ArxPurchase {
  contractId: number;
  transactionId: number | null;
  buyPrice: number | null;
}

/**
 * Normalize a buy response.
 *
 * HONESTY: a purchase is only reported when a numeric contract_id is present.
 * A success-shaped payload without one is NOT a fill — same rule the MT5 path
 * enforces (no ticket is never a fill), so an ambiguous reply becomes an
 * unresolved outcome rather than a fabricated position.
 */
export function normalizePurchase(msg: unknown): ArxPurchase | DerivNewApiError {
  const b = (msg as { buy?: unknown } | null)?.buy;
  if (typeof b !== "object" || b === null) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "no buy block" });
  }
  const r = b as Record<string, unknown>;
  const contractId = r["contract_id"];
  if (typeof contractId !== "number") {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", {
      detail: "buy carried no contract id — not reported as a purchase",
    });
  }
  return {
    contractId,
    transactionId: numeric(r["transaction_id"]),
    buyPrice: numeric(r["buy_price"]),
  };
}

export interface ArxSale {
  contractId: number | null;
  proceeds: number | null;
  transactionId: number | null;
}

/**
 * Normalize a sell response.
 *
 * HONESTY: Deriv's sell_response marks the `sell` receipt as NOT required, so
 * an error-free reply can legitimately arrive without one. A reply with no
 * receipt is NOT evidence of a close — the same rule normalizePurchase
 * enforces on the buy side, where no contract id is never a fill.
 */
export function normalizeSale(msg: unknown): ArxSale | DerivNewApiError {
  // Deriv's schema names the receipt `sell`. `sold` is accepted because the
  // harness's own early fixtures used it and the venue has not been observed
  // rejecting either; the schema name is checked first.
  const raw = (msg as { sell?: unknown; sold?: unknown } | null);
  const s = raw?.sell ?? raw?.sold;
  if (typeof s !== "object" || s === null) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", {
      detail: "sell carried no receipt — not reported as a close",
    });
  }
  const r = s as Record<string, unknown>;
  return {
    contractId: typeof r["contract_id"] === "number" ? r["contract_id"] : null,
    proceeds: numeric(r["sold_for"]) ?? numeric(r["amount"]),
    transactionId: numeric(r["transaction_id"]),
  };
}

/**
 * What the venue actually said about settlement.
 *
 * SOLD          the venue asserts the contract is sold — the only closure evidence
 * NOT_SOLD      the venue asserts it is NOT sold — evidence it is still open
 * ABSENT        the venue said nothing — no evidence either way
 * UNRECOGNISED  is_sold present in a type ARX does not accept — also no evidence,
 *               but it must be reported differently from silence so a schema
 *               drift is attributable instead of looking like an open position
 */
export type SettlementEvidence = "SOLD" | "NOT_SOLD" | "ABSENT" | "UNRECOGNISED";

/**
 * Protection as the VENUE reports it, not as ARX asked for it.
 *
 * Each level is null when Deriv did not state it — and null is UNKNOWN, never
 * "no protection". Concluding a stop-loss is absent from silence is as wrong
 * as concluding it is present.
 */
export interface ArxContractProtection {
  stopLoss: number | null;
  takeProfit: number | null;
  /** The venue's OWN forced-close level for a multiplier. ARX does not set
   *  this and previously did not read it, so a hard floor on the position
   *  existed that ARX knew nothing about. */
  stopOut: number | null;
  /** False when the venue sent no limit_order block at all. Distinguishes
   *  "the venue reported no protection" from "the venue said nothing". */
  reportedByVenue: boolean;
}

/**
 * Read one protection level.
 *
 * `order_amount` is DEPRECATED in Deriv's schema in favour of the STRING
 * `display_order_amount`, so the string is preferred and the deprecated
 * number is a fallback. Both route through `numeric`, so "" and junk stay
 * null rather than becoming 0 — a stop-loss of 0 would be a catastrophic
 * misreading of "unstated".
 */
function readProtectionLevel(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return numeric(r["display_order_amount"]) ?? numeric(r["order_amount"]);
}

export function normalizeProtection(rawLimitOrder: unknown): ArxContractProtection {
  if (typeof rawLimitOrder !== "object" || rawLimitOrder === null) {
    return { stopLoss: null, takeProfit: null, stopOut: null, reportedByVenue: false };
  }
  const l = rawLimitOrder as Record<string, unknown>;
  return {
    stopLoss: readProtectionLevel(l["stop_loss"]),
    takeProfit: readProtectionLevel(l["take_profit"]),
    stopOut: readProtectionLevel(l["stop_out"]),
    reportedByVenue: true,
  };
}

/** What ARX asked for, versus what the venue says it attached. */
export type ProtectionVerdict =
  /** The venue confirms the level ARX requested. */
  | { level: "stopLoss" | "takeProfit"; status: "CONFIRMED"; value: number }
  /** ARX requested it; the venue reported protection and this level is absent.
   *  ARX believes it is protected and is NOT. */
  | { level: "stopLoss" | "takeProfit"; status: "MISSING"; requested: number }
  /** The venue attached a DIFFERENT level than requested. */
  | { level: "stopLoss" | "takeProfit"; status: "ALTERED"; requested: number; actual: number }
  /** The venue said nothing about protection. Unknown, not absent. */
  | { level: "stopLoss" | "takeProfit"; status: "UNSTATED"; requested: number };

/**
 * Compare requested protection against the venue's report.
 *
 * ARX previously SENT protection and never read it back, so a stop-loss the
 * venue silently dropped or altered would have left ARX certain of a safety
 * mechanism it did not have. That is false certainty about the one control
 * that bounds a loss.
 *
 * Compared in whole cents for the same reason reconciliation is: a float
 * epsilon can accept a genuine one-cent difference.
 */
export function verifyProtection(
  requested: { stopLoss?: number | null; takeProfit?: number | null },
  reported: ArxContractProtection,
): ProtectionVerdict[] {
  const out: ProtectionVerdict[] = [];
  const check = (level: "stopLoss" | "takeProfit", want: number | null | undefined): void => {
    if (typeof want !== "number") return;      // not requested: nothing to verify
    if (!reported.reportedByVenue) {
      out.push({ level, status: "UNSTATED", requested: want });
      return;
    }
    const actual = reported[level];
    if (actual === null) {
      out.push({ level, status: "MISSING", requested: want });
      return;
    }
    if (Math.round(actual * 100) !== Math.round(want * 100)) {
      out.push({ level, status: "ALTERED", requested: want, actual });
      return;
    }
    out.push({ level, status: "CONFIRMED", value: actual });
  };
  check("stopLoss", requested.stopLoss);
  check("takeProfit", requested.takeProfit);
  return out;
}

export interface ArxOpenContract {
  contractId: number;
  /** True ONLY on evidence of a SALE. Expiry alone does not set this. */
  isSettled: boolean;
  /** The venue's settlement statement, three-valued rather than boolean. */
  settlementEvidence: SettlementEvidence;
  /** Venue settleability when stated; null when absent — absent is not false. */
  isSettleable: boolean | null;
  /** The venue's own status string, when stated. */
  venueStatus: string | null;
  /** Expired per the venue. Not settlement — see isSettled. */
  isExpired: boolean;
  /** Protection as the VENUE reports it. */
  protection: ArxContractProtection;
  /** The venue's OWN entry/exit for this contract. Schema types both as
   *  ["null","string"], so they route through `numeric`. Null when Deriv did
   *  not state them — never substituted from a quote or a streaming tick. */
  entrySpot: number | null;
  exitSpot: number | null;
  /** Realized or running P/L as reported; null when absent, never 0. */
  profit: number | null;
  currentSpot: number | null;
  status: string | null;
}

export function normalizeOpenContract(msg: unknown): ArxOpenContract | DerivNewApiError {
  const c = (msg as { proposal_open_contract?: unknown } | null)?.proposal_open_contract;
  if (typeof c !== "object" || c === null) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "no open-contract block" });
  }
  const r = c as Record<string, unknown>;
  const contractId = r["contract_id"];
  if (typeof contractId !== "number") {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "open contract carried no id" });
  }
  // SETTLEMENT REQUIRES A SALE. `is_expired` alone is NOT settlement: for a
  // multiplier the close path is a sale, and Deriv can report an expired
  // contract that is neither sold nor settleable. Treating expiry as closure
  // CLEARED the open-position alarm on a contract the venue still called
  // unsold.
  //
  // Three-valued on purpose. "not SOLD" and "no usable evidence" are
  // different facts, and collapsing them into a boolean makes an unreadable
  // reply indistinguishable from a venue statement that the contract is open.
  // An unrecognised TYPE is evidence of nothing, and the resulting failure
  // must name itself rather than surfacing as a generic "not confirmed".
  const rawSold = r["is_sold"];
  const settlementEvidence: SettlementEvidence =
    rawSold === 1 || rawSold === true ? "SOLD"
      : rawSold === 0 || rawSold === false ? "NOT_SOLD"
        : rawSold === undefined || rawSold === null ? "ABSENT"
          : "UNRECOGNISED";
  const settled = settlementEvidence === "SOLD";
  const expired = r["is_expired"] === 1 || r["is_expired"] === true;
  return {
    contractId,
    isSettled: settled,
    settlementEvidence,
    protection: normalizeProtection(r["limit_order"]),
    // The venue's own settleability flag, when stated. Absent is not false.
    isSettleable: r["is_settleable"] === 1 || r["is_settleable"] === true ? true
      : r["is_settleable"] === 0 || r["is_settleable"] === false ? false : null,
    venueStatus: typeof r["status"] === "string" ? r["status"] : null,
    // Reported separately so an expired-but-unsold contract is visible rather
    // than silently folded into either verdict.
    isExpired: expired,
    profit: numeric(r["profit"]),
    entrySpot: numeric(r["entry_spot"]),
    exitSpot: numeric(r["exit_spot"]),
    // The live STREAMING quote at read time — NOT the contract's exit. Named
    // for what it is so it cannot be mistaken for one again.
    currentSpot: numeric(r["current_spot"]),
    status: typeof r["status"] === "string" ? r["status"] : null,
  };
}

export interface ArxPortfolioEntry {
  contractId: number;
  underlyingSymbol: string | null;
  contractType: string | null;
  buyPrice: number | null;
  /** Venue purchase time, epoch seconds, when stated. Needed by restart
   *  recovery to tell a contract opened by THIS order from one that already
   *  existed — without it, a real position cannot be dated and therefore
   *  cannot block an absence conclusion. */
  purchaseTimeSec: number | null;
}

/** Malformed rows are SKIPPED, never coerced: reconciliation compares this
 *  against ARX's records, so an invented id would corrupt the comparison and
 *  dropping the batch over one bad row would hide real positions. */
export function normalizePortfolio(msg: unknown): {
  contracts: ArxPortfolioEntry[]; skipped: number;
} | DerivNewApiError {
  const p = (msg as { portfolio?: { contracts?: unknown } } | null)?.portfolio;
  const raw = p?.contracts;
  if (!Array.isArray(raw)) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "no contracts array" });
  }
  const contracts: ArxPortfolioEntry[] = [];
  let skipped = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) { skipped += 1; continue; }
    const e = entry as Record<string, unknown>;
    const id = e["contract_id"];
    if (typeof id !== "number") { skipped += 1; continue; }
    contracts.push({
      contractId: id,
      // Accept either spelling: the underlying field is exactly what the
      // generation change renamed, and certification pins which one arrives.
      underlyingSymbol: typeof e["underlying_symbol"] === "string" ? e["underlying_symbol"]
        : typeof e["symbol"] === "string" ? e["symbol"] : null,
      contractType: typeof e["contract_type"] === "string" ? e["contract_type"] : null,
      buyPrice: numeric(e["buy_price"]),
      purchaseTimeSec: numeric(e["purchase_time"]),
    });
  }
  return { contracts, skipped };
}

/** Normalize a balance read. Null when absent — never 0, which would read as
 *  a funded-but-empty account. */
export function normalizeBalance(msg: unknown): { balance: number | null; currency: string | null } | DerivNewApiError {
  const b = (msg as { balance?: unknown } | null)?.balance;
  if (typeof b !== "object" || b === null) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "no balance block" });
  }
  const r = b as Record<string, unknown>;
  return {
    balance: numeric(r["balance"]),
    currency: typeof r["currency"] === "string" ? r["currency"] : null,
  };
}
