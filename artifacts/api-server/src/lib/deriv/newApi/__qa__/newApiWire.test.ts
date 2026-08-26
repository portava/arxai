// Deriv NEW API wire mappers/normalizers (spec Phases 5-8).
//
// The normalizer tests are the important half. A mapper that is wrong fails
// loudly at the venue; a normalizer that is wrong invents a position that
// does not exist, or hides one that does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mapProposalRequest, mapBuyRequest, mapSellRequest, mapContractsForRequest,
  mapOpenContractRequest, normalizeProposal, normalizePurchase,
  normalizeOpenContract, normalizePortfolio, normalizeBalance, numeric,
  normalizeProtection, verifyProtection,
  LEGACY_ONLY_FIELDS,
} from "../wire.js";
import { DerivNewApiError } from "../errors.js";

const INTENT = {
  symbol: "R_100", contractType: "MULTUP" as const, stake: 10,
  currency: "USD", multiplier: 100,
};

// ── The generation change itself ────────────────────────────────────────────

test("proposal sends underlying_symbol and NEVER legacy symbol", () => {
  const req = mapProposalRequest(INTENT as never) as unknown as Record<string, unknown>;
  assert.equal(req["underlying_symbol"], "R_100");
  // The rename is the whole reason this module exists. A payload carrying
  // both would be accepted by a lenient venue and silently keep the legacy
  // field alive in the codebase.
  assert.ok(!("symbol" in req), "legacy `symbol` must not be present");
});

test("proposal carries no loginid — the session owns account context", () => {
  const req = mapProposalRequest(INTENT as never) as unknown as Record<string, unknown>;
  assert.ok(!("loginid" in req));
  assert.ok(!("passthrough" in req));
});

test("protection block is OMITTED when unset, not sent empty", () => {
  const bare = mapProposalRequest(INTENT as never);
  assert.ok(!("limit_order" in bare), "absent protection must not become an empty block");
  const guarded = mapProposalRequest({ ...INTENT, stopLoss: 5 } as never);
  assert.deepEqual(guarded.limit_order, { stop_loss: 5 });
  assert.ok(!("take_profit" in (guarded.limit_order ?? {})), "unset TP must not be invented");
});

// ── Refusals that protect capital ───────────────────────────────────────────

test("buy REFUSES an unbounded price", () => {
  // price is a ceiling; without one the venue may reprice between quote and
  // fill and ARX has consented to nothing.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.ok(mapBuyRequest("p1", bad) instanceof DerivNewApiError, `accepted ${bad}`);
  }
  assert.deepEqual(mapBuyRequest("p1", 10.5), { buy: "p1", price: 10.5 });
});

test("sell accepts 0 (sell-at-market) but refuses negative proceeds", () => {
  assert.deepEqual(mapSellRequest(42, 0), { sell: 42, price: 0 });
  assert.ok(mapSellRequest(42, -1) instanceof DerivNewApiError);
  assert.ok(mapSellRequest(0, 1) instanceof DerivNewApiError, "contract id 0 is not valid");
  assert.ok(mapSellRequest(1.5, 1) instanceof DerivNewApiError, "contract id must be integral");
});

test("contracts_for sends ONLY its own key — no currency, no contract_type", () => {
  // The live InputValidationFailed. Deriv's schema is additionalProperties:
  // false and permits exactly {contracts_for, passthrough, req_id}; ARX sent
  // two surplus keys, one of which (contract_type) never existed on this
  // operation in either generation.
  const req = mapContractsForRequest("R_100");
  // deepStrictEqual on the WHOLE object is load-bearing: a subset assertion is
  // exactly what would let a surplus key through again.
  assert.deepStrictEqual(req, { contracts_for: "R_100" });
  assert.deepStrictEqual(Object.keys(req as object), ["contracts_for"]);
});

test("contracts_for validates the symbol against the schema's own pattern", () => {
  assert.ok(mapContractsForRequest("") instanceof DerivNewApiError);
  assert.ok(mapContractsForRequest("x") instanceof DerivNewApiError, "under 2 chars");
  assert.ok(mapContractsForRequest("has space") instanceof DerivNewApiError);
  assert.ok(mapOpenContractRequest(-1) instanceof DerivNewApiError);
});

// ── Normalizer honesty ──────────────────────────────────────────────────────

test("a quote without an id is a protocol error, not a half-filled object", () => {
  assert.ok(normalizeProposal({ proposal: { ask_price: 10 } }) instanceof DerivNewApiError);
  assert.ok(normalizeProposal({}) instanceof DerivNewApiError);
  const ok = normalizeProposal({ proposal: { id: "abc", ask_price: 10 } });
  assert.equal((ok as { proposalId: string }).proposalId, "abc");
});

test("a quote's missing numbers stay NULL rather than becoming 0", () => {
  const q = normalizeProposal({ proposal: { id: "abc" } }) as unknown as Record<string, unknown>;
  // 0 would read as a free contract. Null reads as "Deriv did not say".
  assert.equal(q["askPrice"], null);
  assert.equal(q["payout"], null);
});

test("a success-shaped buy WITHOUT a contract id is NOT reported as a purchase", () => {
  // Same rule the MT5 path enforces: no ticket is never a fill. This is the
  // single most consequential assertion in the file — the alternative is a
  // position ARX believes it holds and the venue has never heard of.
  const r = normalizePurchase({ buy: { buy_price: 10, transaction_id: 7 } });
  assert.ok(r instanceof DerivNewApiError);
  assert.match(r.message, /not reported as a purchase/);
});

test("an open contract with NO settlement evidence is treated as OPEN", () => {
  // Assuming settlement would strand the position outside reconciliation.
  const r = normalizeOpenContract({ proposal_open_contract: { contract_id: 5 } });
  assert.equal((r as { isSettled: boolean }).isSettled, false);
  assert.equal((r as { profit: number | null }).profit, null, "absent P/L must not become 0");
  const sold = normalizeOpenContract({ proposal_open_contract: { contract_id: 5, is_sold: 1 } });
  assert.equal((sold as { isSettled: boolean }).isSettled, true);
});

test("portfolio SKIPS malformed rows and counts them, never coercing ids", () => {
  const r = normalizePortfolio({ portfolio: { contracts: [
    { contract_id: 1, underlying_symbol: "R_100" },
    { buy_price: 3 },        // no id — cannot be reconciled
    null,
    { contract_id: 2, symbol: "R_50" },  // legacy spelling still readable
  ] } }) as { contracts: unknown[]; skipped: number };
  assert.equal(r.contracts.length, 2);
  // The count is what makes the drop visible; a silent skip would let a real
  // open position vanish from reconciliation with no signal.
  assert.equal(r.skipped, 2);
  assert.equal((r.contracts[1] as { underlyingSymbol: string }).underlyingSymbol, "R_50");
});

test("balance absent stays null — 0 would read as a funded empty account", () => {
  const r = normalizeBalance({ balance: { currency: "USD" } }) as { balance: number | null };
  assert.equal(r.balance, null);
});

// ── Source pin ──────────────────────────────────────────────────────────────

test("wire module emits no legacy-generation request keys", () => {
  const url = new URL("../wire.ts", import.meta.url);
  let code = readFileSync(url, "utf8")
    // Strip comments first: this file DISCUSSES the legacy names it forbids,
    // and matching prose instead of code is a false pass. (Fourth time this
    // trap has bitten in this workstream.)
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // Also strip the deny-list declaration itself — it NAMES the forbidden
  // fields as data, and its first run failed this test on its own contents.
  code = code.replace(/export const LEGACY_ONLY_FIELDS[\s\S]*?;\n/, "");

  // Driven by the module's own deny-list so the two cannot drift apart.
  for (const field of LEGACY_ONLY_FIELDS) {
    // Matches `field:` — which is an emitted object key OR a typed
    // declaration, and the regex cannot tell them apart. So the rule this
    // pin actually enforces is the stronger, simpler one: inside this module
    // nothing may be NAMED after a legacy field, whether key, parameter, or
    // property. That is what caught `mapContractsForRequest(symbol: string)`
    // and got it renamed to `underlyingSymbol`.
    //
    // Substring matching is deliberately NOT used: it would flag
    // `underlying_symbol` for containing `symbol`, and would flag the
    // legacy-spelling READER `e["symbol"]` that exists on purpose so
    // certification can pin which spelling actually arrives on the wire.
    const named = new RegExp("\\b" + field + "\\s*:");
    assert.ok(!named.test(code), `wire.ts names something \`${field}\``);
  }
  // The rename is the whole point, so pin the replacement is really there.
  assert.ok(/underlying_symbol:\s/.test(code), "wire.ts must emit underlying_symbol");
});

// ── Numeric tolerance (an UNRESOLVED docs conflict, held open on purpose) ───

test("price fields accept BOTH numbers and numeric strings", () => {
  // Deriv's proposal_response schema types ask_price/payout/spot as `number`,
  // while Deriv's own migration page says those fields "now accept both
  // numbers and strings". One source is stale and the docs do not say which,
  // so both are accepted rather than guessing — the approach that resolved
  // the OTP nesting. Picking wrong here silently nulls a real price.
  assert.equal(numeric(10.5), 10.5);
  assert.equal(numeric("10.5"), 10.5);
  assert.equal(numeric("0"), 0, "a genuine zero must survive");
  const q = normalizeProposal({ proposal: { id: "abc", ask_price: "5.50", payout: "11" } });
  assert.equal((q as { askPrice: number | null }).askPrice, 5.5);
  assert.equal((q as { payout: number | null }).payout, 11);
});

test("tolerance does NOT extend to junk — absent stays null, never 0", () => {
  // The whole null-not-zero rule would be defeated by a loose parse: Number("")
  // is 0, which would read as a free contract.
  for (const junk of ["", "   ", "abc", null, undefined, {}, [], true, NaN, Infinity]) {
    assert.equal(numeric(junk), null, `accepted junk: ${JSON.stringify(junk)}`);
  }
});

test("a string profit does not become a silently-missing profit", () => {
  const c = normalizeOpenContract({ proposal_open_contract: { contract_id: 5, profit: "-2.25" } });
  assert.equal((c as { profit: number | null }).profit, -2.25);
});

// ── Protection read-back (Phase 5: "protection") ───────────────────────────
//
// ARX previously SENT stop-loss/take-profit and never read them back. A level
// the venue silently dropped or altered would have left ARX certain of a
// safety mechanism it did not have — false certainty about the one control
// that bounds a loss.

test("protection is read from the venue's DISPLAY field, not the deprecated one", () => {
  // Deriv's schema marks order_amount deprecated in favour of the STRING
  // display_order_amount, so the string wins and the number is a fallback.
  const p = normalizeProtection({
    stop_loss: { display_order_amount: "5.50", order_amount: 9.99, order_date: 1 },
    take_profit: { order_amount: 12.25, order_date: 1 },
  });
  assert.equal(p.stopLoss, 5.5, "preferred the deprecated field");
  assert.equal(p.takeProfit, 12.25, "did not fall back to order_amount");
  assert.equal(p.reportedByVenue, true);
});

test("the venue's OWN stop_out is captured — a floor ARX did not know existed", () => {
  const p = normalizeProtection({ stop_out: { display_order_amount: "-1.00", order_date: 1 } });
  assert.equal(p.stopOut, -1);
});

test("SILENCE about protection is UNKNOWN, never 'no protection'", () => {
  const silent = normalizeProtection(undefined);
  assert.equal(silent.reportedByVenue, false);
  assert.equal(silent.stopLoss, null);
  // The distinction that matters: the venue reporting a limit_order WITHOUT a
  // stop_loss is a statement; sending no limit_order at all is not.
  const stated = normalizeProtection({ take_profit: { display_order_amount: "2", order_date: 1 } });
  assert.equal(stated.reportedByVenue, true);
  assert.equal(stated.stopLoss, null);
});

test("a protection level of ZERO is never invented from junk", () => {
  // A stop-loss read as 0 would be a catastrophic misreading of "unstated".
  for (const junk of ["", "  ", "abc", null, {}]) {
    const p = normalizeProtection({ stop_loss: { display_order_amount: junk, order_date: 1 } });
    assert.equal(p.stopLoss, null, `accepted junk ${JSON.stringify(junk)}`);
  }
});

test("verifyProtection: a DROPPED stop-loss is reported MISSING", () => {
  // The case that matters most. ARX asked for protection, the venue reported
  // its protection block, and the level is not in it.
  const v = verifyProtection({ stopLoss: 5 },
    normalizeProtection({ take_profit: { display_order_amount: "10", order_date: 1 } }));
  assert.equal(v.length, 1);
  assert.equal(v[0]!.status, "MISSING");
});

test("verifyProtection: an ALTERED level is reported with both values", () => {
  const v = verifyProtection({ stopLoss: 5 },
    normalizeProtection({ stop_loss: { display_order_amount: "3.00", order_date: 1 } }));
  assert.equal(v[0]!.status, "ALTERED");
  if (v[0]!.status === "ALTERED") {
    assert.equal(v[0]!.requested, 5);
    assert.equal(v[0]!.actual, 3);
  }
});

test("verifyProtection: venue SILENCE is UNSTATED, distinct from MISSING", () => {
  // Missing means the venue told us and the level is absent. Unstated means
  // the venue told us nothing. Conflating them would either cry wolf or hide
  // a genuinely unprotected position.
  const v = verifyProtection({ stopLoss: 5 }, normalizeProtection(undefined));
  assert.equal(v[0]!.status, "UNSTATED");
});

test("verifyProtection: a CONFIRMED level, compared in whole cents", () => {
  const v = verifyProtection({ stopLoss: 5, takeProfit: 10 },
    normalizeProtection({
      stop_loss: { display_order_amount: "5.00", order_date: 1 },
      take_profit: { display_order_amount: "10.00", order_date: 1 },
    }));
  assert.equal(v.length, 2);
  assert.ok(v.every((x) => x.status === "CONFIRMED"));
  // A genuine one-cent difference is NOT confirmation.
  const off = verifyProtection({ stopLoss: 5 },
    normalizeProtection({ stop_loss: { display_order_amount: "5.01", order_date: 1 } }));
  assert.equal(off[0]!.status, "ALTERED");
});

test("verifyProtection reports nothing for a level ARX never requested", () => {
  // Silence about something we did not ask for is not a finding.
  const v = verifyProtection({}, normalizeProtection({ stop_loss: { display_order_amount: "5", order_date: 1 } }));
  assert.deepEqual(v, []);
});

test("an open contract carries the venue's protection through normalization", () => {
  const c = normalizeOpenContract({
    proposal_open_contract: {
      contract_id: 555, profit: 0,
      limit_order: { stop_loss: { display_order_amount: "4.25", order_date: 1 } },
    },
  });
  assert.equal((c as { protection: { stopLoss: number | null } }).protection.stopLoss, 4.25);
});
