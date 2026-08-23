// R5 Phase 2 — Deriv execution wire messages (PURE build/parse, no transport).
//
// ⚠ VERIFICATION STATUS — READ BEFORE TRUSTING THIS FILE
// The shapes below follow Deriv's published WebSocket schema, but they have
// NOT been exercised against a live venue from this codebase. Deriv also ships
// TWO API generations whose proposal request differs (legacy `symbol` vs newer
// `underlying_symbol`), so a field name here can be right for one generation
// and wrong for the other. Consequently:
//
//   * Everything here is PURE — build a request object, parse a response
//     object. Nothing opens a socket or sends anything.
//   * The adapter that would use these refuses to execute until a
//     certification run confirms the shapes against a real DEMO account
//     (spec §16: "An adapter cannot advertise a capability until a test
//     demonstrates it").
//   * `apiGeneration` is explicit rather than assumed, so a mismatch surfaces
//     as a caller decision instead of a silent wrong-field-name failure.
//
// This isolation is the point: when certification reveals a shape error, the
// fix is confined to this file and its fixtures — not spread through a
// transport layer.

import type { DerivMultiplierContractIntent } from "@workspace/domain/deriv-contracts";

/**
 * Which Deriv API generation the request targets. Deriv renamed the proposal
 * underlying field between generations; there is no safe default, so callers
 * state it and certification pins which one this account speaks.
 */
export type DerivApiGeneration = "legacy" | "current";

export interface DerivProposalRequest {
  proposal: 1;
  amount: number;
  basis: "stake";
  contract_type: "MULTUP" | "MULTDOWN";
  currency: string;
  multiplier: number;
  /** Legacy generation. Exactly one of symbol/underlying_symbol is set. */
  symbol?: string;
  /** Current generation. */
  underlying_symbol?: string;
  limit_order?: {
    stop_loss?: number;
    take_profit?: number;
  };
  /** Correlates the response on a multiplexed socket. */
  req_id: number;
}

export interface DerivBuyRequest {
  buy: string;
  /** Max price the caller will pay. NEVER 0/unbounded: an unbounded buy would
   *  accept any repricing between proposal and execution. */
  price: number;
  req_id: number;
}

export interface DerivSellRequest {
  sell: number;
  /** Minimum acceptable proceeds. 0 means "sell at market" — Deriv's documented
   *  sentinel — and is only ever used for an explicit close-at-any-price. */
  price: number;
  req_id: number;
}

export interface DerivPortfolioRequest {
  portfolio: 1;
  req_id: number;
}

export interface DerivOpenContractRequest {
  proposal_open_contract: 1;
  contract_id: number;
  req_id: number;
}

/** Deriv reports failures as a top-level `error` object rather than an HTTP code. */
export interface DerivErrorEnvelope {
  error: { code: string; message: string };
}

export function isDerivError(msg: unknown): msg is DerivErrorEnvelope {
  if (typeof msg !== "object" || msg === null) return false;
  const err = (msg as { error?: unknown }).error;
  return typeof err === "object" && err !== null
    && typeof (err as { code?: unknown }).code === "string";
}

/**
 * Build a multiplier proposal request from a validated intent.
 *
 * The intent is expected to have passed
 * `validateMultiplierContractIntent` against the account's discovered
 * capability first — this function does NOT re-validate limits, because
 * silently clamping a caller's numbers here would hide a rejected intent.
 */
export function buildProposalRequest(
  intent: DerivMultiplierContractIntent,
  opts: { reqId: number; apiGeneration: DerivApiGeneration },
): DerivProposalRequest {
  const req: DerivProposalRequest = {
    proposal: 1,
    amount: intent.stake,
    // "stake" (not "payout"): a multiplier contract is bought for a stake.
    basis: "stake",
    contract_type: intent.contractType,
    currency: intent.currency,
    multiplier: intent.multiplier,
    req_id: opts.reqId,
  };
  if (opts.apiGeneration === "legacy") req.symbol = intent.symbol;
  else req.underlying_symbol = intent.symbol;

  // Protection is omitted entirely when unset — sending explicit nulls has a
  // different meaning to the venue than omitting the block.
  const limit: { stop_loss?: number; take_profit?: number } = {};
  if (typeof intent.stopLoss === "number") limit.stop_loss = intent.stopLoss;
  if (typeof intent.takeProfit === "number") limit.take_profit = intent.takeProfit;
  if (Object.keys(limit).length > 0) req.limit_order = limit;

  return req;
}

/**
 * Build the buy request for a proposal.
 *
 * `maxPrice` is REQUIRED and must be finite and positive: Deriv treats the
 * price as a ceiling, and an unbounded buy would accept arbitrary repricing
 * between quote and execution. Refuses rather than substituting a default.
 */
export function buildBuyRequest(
  proposalId: string,
  maxPrice: number,
  reqId: number,
): DerivBuyRequest | { refused: string } {
  if (typeof proposalId !== "string" || proposalId.length === 0) {
    return { refused: "MISSING_PROPOSAL_ID" };
  }
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
    return { refused: "INVALID_MAX_PRICE" };
  }
  return { buy: proposalId, price: maxPrice, req_id: reqId };
}

export function buildSellRequest(
  contractId: number,
  minProceeds: number,
  reqId: number,
): DerivSellRequest | { refused: string } {
  if (!Number.isInteger(contractId) || contractId <= 0) {
    return { refused: "INVALID_CONTRACT_ID" };
  }
  if (!Number.isFinite(minProceeds) || minProceeds < 0) {
    return { refused: "INVALID_MIN_PROCEEDS" };
  }
  return { sell: contractId, price: minProceeds, req_id: reqId };
}

export function buildPortfolioRequest(reqId: number): DerivPortfolioRequest {
  return { portfolio: 1, req_id: reqId };
}

export function buildOpenContractRequest(
  contractId: number,
  reqId: number,
): DerivOpenContractRequest | { refused: string } {
  if (!Number.isInteger(contractId) || contractId <= 0) {
    return { refused: "INVALID_CONTRACT_ID" };
  }
  return { proposal_open_contract: 1, contract_id: contractId, req_id: reqId };
}

/** What a buy response yields once parsed. */
export interface DerivBuyOutcome {
  ok: boolean;
  /** Present ONLY on a confirmed purchase — this is the venue's ticket. */
  contractId: number | null;
  transactionId: number | null;
  buyPrice: number | null;
  /** Set when the venue reported an error, or the payload was unusable. */
  reason: string | null;
}

/**
 * Parse a buy response.
 *
 * HONESTY: `ok: true` requires a numeric contract_id. A success-shaped payload
 * without one is NOT reported as a purchase — it becomes an unusable-response
 * refusal, which the pipeline maps to UNKNOWN rather than a fabricated fill.
 * This mirrors mapBridgedLiveOutcome's no-ticket-is-never-a-fill rule.
 */
export function parseBuyResponse(msg: unknown): DerivBuyOutcome {
  const miss = (reason: string): DerivBuyOutcome =>
    ({ ok: false, contractId: null, transactionId: null, buyPrice: null, reason });

  if (isDerivError(msg)) return miss(`DERIV_ERROR:${msg.error.code}`);
  if (typeof msg !== "object" || msg === null) return miss("UNPARSEABLE_RESPONSE");

  const buy = (msg as { buy?: unknown }).buy;
  if (typeof buy !== "object" || buy === null) return miss("MISSING_BUY_BLOCK");

  const b = buy as Record<string, unknown>;
  const contractId = typeof b["contract_id"] === "number" ? b["contract_id"] : null;
  if (contractId === null) return miss("MISSING_CONTRACT_ID");

  return {
    ok: true,
    contractId,
    transactionId: typeof b["transaction_id"] === "number" ? b["transaction_id"] : null,
    buyPrice: typeof b["buy_price"] === "number" ? b["buy_price"] : null,
    reason: null,
  };
}

/** One open position as reported by `portfolio`, used for reconciliation. */
export interface DerivPortfolioContract {
  contractId: number;
  symbol: string | null;
  contractType: string | null;
  buyPrice: number | null;
}

/**
 * Parse a portfolio response into the open-contract set.
 *
 * A malformed entry is SKIPPED rather than coerced: reconciliation compares
 * this against ARX's records, and inventing a contract id (or dropping the
 * whole batch over one bad row) would corrupt that comparison.
 */
export function parsePortfolioResponse(msg: unknown): {
  ok: boolean;
  contracts: DerivPortfolioContract[];
  skipped: number;
  reason: string | null;
} {
  if (isDerivError(msg)) {
    return { ok: false, contracts: [], skipped: 0, reason: `DERIV_ERROR:${msg.error.code}` };
  }
  const portfolio = (msg as { portfolio?: { contracts?: unknown } } | null)?.portfolio;
  const raw = portfolio?.contracts;
  if (!Array.isArray(raw)) {
    return { ok: false, contracts: [], skipped: 0, reason: "MISSING_CONTRACTS_ARRAY" };
  }

  const contracts: DerivPortfolioContract[] = [];
  let skipped = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) { skipped += 1; continue; }
    const e = entry as Record<string, unknown>;
    const id = e["contract_id"];
    if (typeof id !== "number") { skipped += 1; continue; }
    contracts.push({
      contractId: id,
      symbol: typeof e["symbol"] === "string" ? e["symbol"] : null,
      contractType: typeof e["contract_type"] === "string" ? e["contract_type"] : null,
      buyPrice: typeof e["buy_price"] === "number" ? e["buy_price"] : null,
    });
  }
  return { ok: true, contracts, skipped, reason: null };
}
