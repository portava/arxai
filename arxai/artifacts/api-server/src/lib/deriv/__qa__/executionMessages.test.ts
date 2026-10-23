// Deriv execution wire layer — pure build/parse. No socket is opened here, and
// none can be: the module has no transport.
//
// These fixtures pin BEHAVIOUR (refuse rather than guess; never report a
// purchase without a contract id). They cannot pin that Deriv's field NAMES are
// correct — only certification against a live demo account can, which is
// exactly why the adapter stays inert until then.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProposalRequest,
  buildBuyRequest,
  buildSellRequest,
  buildOpenContractRequest,
  buildPortfolioRequest,
  buildContractsForRequest,
  parseBuyResponse,
  parsePortfolioResponse,
  isDerivError,
} from "../executionMessages.js";
import type { DerivMultiplierContractIntent } from "@workspace/domain/deriv-contracts";

const intent: DerivMultiplierContractIntent = {
  kind: "DERIV_MULTIPLIER_CONTRACT",
  contractType: "MULTUP",
  symbol: "R_75",
  currency: "USD",
  stake: 10,
  multiplier: 100,
};

test("a multiplier proposal is bought for a STAKE, never a payout", () => {
  const req = buildProposalRequest(intent, { reqId: 1, apiGeneration: "legacy" });
  assert.equal(req.basis, "stake");
  assert.equal(req.amount, 10);
  assert.equal(req.contract_type, "MULTUP");
  assert.equal(req.multiplier, 100);
});

test("the API generation selects the underlying field — never both, never guessed", () => {
  const legacy = buildProposalRequest(intent, { reqId: 1, apiGeneration: "legacy" });
  assert.equal(legacy.symbol, "R_75");
  assert.equal(legacy.underlying_symbol, undefined);

  const current = buildProposalRequest(intent, { reqId: 1, apiGeneration: "current" });
  assert.equal(current.underlying_symbol, "R_75");
  assert.equal(current.symbol, undefined);
});

test("protection is OMITTED when unset, not sent as null", () => {
  const bare = buildProposalRequest(intent, { reqId: 1, apiGeneration: "legacy" });
  assert.ok(!("limit_order" in bare), "no limit_order block when neither is set");

  const protectedIntent = { ...intent, stopLoss: 5, takeProfit: 20 };
  const withLimits = buildProposalRequest(protectedIntent, { reqId: 2, apiGeneration: "legacy" });
  assert.deepEqual(withLimits.limit_order, { stop_loss: 5, take_profit: 20 });

  const slOnly = buildProposalRequest({ ...intent, stopLoss: 5 }, { reqId: 3, apiGeneration: "legacy" });
  assert.deepEqual(slOnly.limit_order, { stop_loss: 5 });
});

test("a buy REFUSES rather than defaulting an unbounded price", () => {
  assert.deepEqual(buildBuyRequest("prop-1", 0, 1), { refused: "INVALID_MAX_PRICE" });
  assert.deepEqual(buildBuyRequest("prop-1", -5, 1), { refused: "INVALID_MAX_PRICE" });
  assert.deepEqual(buildBuyRequest("prop-1", Number.NaN, 1), { refused: "INVALID_MAX_PRICE" });
  assert.deepEqual(buildBuyRequest("", 10, 1), { refused: "MISSING_PROPOSAL_ID" });
  assert.deepEqual(buildBuyRequest("prop-1", 10.5, 7), { buy: "prop-1", price: 10.5, req_id: 7 });
});

test("sell and open-contract refuse malformed contract ids", () => {
  assert.deepEqual(buildSellRequest(0, 0, 1), { refused: "INVALID_CONTRACT_ID" });
  assert.deepEqual(buildSellRequest(1.5, 0, 1), { refused: "INVALID_CONTRACT_ID" });
  assert.deepEqual(buildOpenContractRequest(-2, 1), { refused: "INVALID_CONTRACT_ID" });
  // price 0 IS legal for sell — Deriv's documented sell-at-market sentinel.
  assert.deepEqual(buildSellRequest(123, 0, 4), { sell: 123, price: 0, req_id: 4 });
  assert.deepEqual(buildPortfolioRequest(9), { portfolio: 1, req_id: 9 });
});

test("a success-shaped buy WITHOUT a contract id is never reported as a purchase", () => {
  const r = parseBuyResponse({ buy: { transaction_id: 55, buy_price: 10 } });
  assert.equal(r.ok, false, "no contract id means no confirmed purchase");
  assert.equal(r.contractId, null);
  assert.equal(r.reason, "MISSING_CONTRACT_ID");
});

test("a confirmed buy yields the venue ticket", () => {
  const r = parseBuyResponse({
    buy: { contract_id: 987, transaction_id: 55, buy_price: 10.2 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.contractId, 987);
  assert.equal(r.buyPrice, 10.2);
  assert.equal(r.reason, null);
});

test("a venue error surfaces its code, never a silent failure", () => {
  const r = parseBuyResponse({ error: { code: "InsufficientBalance", message: "no funds" } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "DERIV_ERROR:InsufficientBalance");
  assert.equal(isDerivError({ error: { code: "X", message: "y" } }), true);
  assert.equal(isDerivError({ buy: {} }), false);
});

test("garbage payloads refuse instead of throwing", () => {
  for (const bad of [null, undefined, 42, "str", {}, { buy: null }]) {
    const r = parseBuyResponse(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must not parse as a purchase`);
    assert.ok(r.reason, "a refusal must carry a reason");
  }
});

test("portfolio SKIPS malformed rows rather than dropping the batch or inventing ids", () => {
  const r = parsePortfolioResponse({
    portfolio: {
      contracts: [
        { contract_id: 1, symbol: "R_75", contract_type: "MULTUP", buy_price: 10 },
        { symbol: "R_50" },        // no contract_id → skipped
        null,                       // not an object → skipped
        { contract_id: 2 },
      ],
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.contracts.length, 2);
  assert.equal(r.skipped, 2);
  assert.deepEqual(r.contracts.map((c) => c.contractId), [1, 2]);
  // Absent optional fields stay null — never coerced to a placeholder.
  assert.equal(r.contracts[1]!.symbol, null);
});

test("a portfolio error or missing array is a refusal, not an empty book", () => {
  const err = parsePortfolioResponse({ error: { code: "AuthorizationRequired", message: "x" } });
  assert.equal(err.ok, false);
  assert.equal(err.reason, "DERIV_ERROR:AuthorizationRequired");

  const missing = parsePortfolioResponse({ portfolio: {} });
  assert.equal(missing.ok, false, "an unusable payload must not look like a flat book");
  assert.equal(missing.reason, "MISSING_CONTRACTS_ARRAY");
});

test("contracts_for asks the VENUE for its limits rather than hardcoding them", () => {
  assert.deepEqual(
    buildContractsForRequest("R_75", "USD", 3),
    { contracts_for: "R_75", currency: "USD", contract_type: "multiplier", req_id: 3 },
  );
  assert.deepEqual(buildContractsForRequest("", "USD", 1), { refused: "MISSING_SYMBOL" });
  assert.deepEqual(buildContractsForRequest("R_75", "", 1), { refused: "MISSING_CURRENCY" });
});

test("the capability parser consumes a raw contracts_for envelope end to end", async () => {
  const { parseMultiplierCapability } = await import("@workspace/domain/deriv-contracts");
  const cap = parseMultiplierCapability({
    contracts_for: {
      available: [
        {
          contract_category: "multiplier",
          contract_type: "MULTUP",
          multiplier_range: [50, 100],
          min_stake: 1,
          max_stake: 2000,
          currency: "USD",
        },
      ],
    },
  }, "R_75");
  assert.ok(cap, "a well-formed payload must parse");
  assert.equal(cap!.symbol, "R_75");
});
