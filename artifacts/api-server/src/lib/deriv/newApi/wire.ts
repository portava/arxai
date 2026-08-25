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
 *  copied across by accident. */
export const LEGACY_ONLY_FIELDS = ["symbol", "loginid", "passthrough"] as const;

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

export function mapContractsForRequest(
  underlyingSymbol: string,
  currency: string,
): { contracts_for: string; currency: string; contract_type: string } | DerivNewApiError {
  if (!underlyingSymbol) return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "missing underlying symbol" });
  if (!currency) return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "missing currency" });
  return { contracts_for: underlyingSymbol, currency, contract_type: "multiplier" };
}

export function mapOpenContractRequest(
  contractId: number,
): { proposal_open_contract: 1; contract_id: number } | DerivNewApiError {
  if (!Number.isInteger(contractId) || contractId <= 0) {
    return new DerivNewApiError("DERIV_NEW_API_PROTOCOL_ERROR", { detail: "invalid contract id" });
  }
  return { proposal_open_contract: 1, contract_id: contractId };
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
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
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
    transactionId: typeof r["transaction_id"] === "number" ? r["transaction_id"] : null,
    buyPrice: typeof r["buy_price"] === "number" ? r["buy_price"] : null,
  };
}

export interface ArxOpenContract {
  contractId: number;
  isSettled: boolean;
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
  // `is_sold`/`is_expired` are the settlement evidence; absence means STILL
  // OPEN, not settled — assuming settlement would strand reconciliation.
  const settled = r["is_sold"] === 1 || r["is_sold"] === true
    || r["is_expired"] === 1 || r["is_expired"] === true;
  return {
    contractId,
    isSettled: settled,
    profit: typeof r["profit"] === "number" && Number.isFinite(r["profit"]) ? r["profit"] : null,
    currentSpot: typeof r["current_spot"] === "number" ? r["current_spot"] : null,
    status: typeof r["status"] === "string" ? r["status"] : null,
  };
}

export interface ArxPortfolioEntry {
  contractId: number;
  underlyingSymbol: string | null;
  contractType: string | null;
  buyPrice: number | null;
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
      buyPrice: typeof e["buy_price"] === "number" ? e["buy_price"] : null,
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
    balance: typeof r["balance"] === "number" && Number.isFinite(r["balance"]) ? r["balance"] : null,
    currency: typeof r["currency"] === "string" ? r["currency"] : null,
  };
}
