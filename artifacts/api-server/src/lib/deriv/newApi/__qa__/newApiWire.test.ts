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
  normalizeOpenContract, normalizePortfolio, normalizeBalance,
  LEGACY_ONLY_FIELDS,
} from "../wire.js";
import { DerivNewApiError } from "../errors.js";

const INTENT = {
  symbol: "R_100", contractType: "MULTUP" as const, stake: 10,
  currency: "USD", multiplier: 100,
};

// ── The generation change itself ────────────────────────────────────────────

test("proposal sends underlying_symbol and NEVER legacy symbol", () => {
  const req = mapProposalRequest(INTENT as never) as Record<string, unknown>;
  assert.equal(req["underlying_symbol"], "R_100");
  // The rename is the whole reason this module exists. A payload carrying
  // both would be accepted by a lenient venue and silently keep the legacy
  // field alive in the codebase.
  assert.ok(!("symbol" in req), "legacy `symbol` must not be present");
});

test("proposal carries no loginid — the session owns account context", () => {
  const req = mapProposalRequest(INTENT as never) as Record<string, unknown>;
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

test("contracts_for and open-contract requests refuse empty inputs", () => {
  assert.ok(mapContractsForRequest("", "USD") instanceof DerivNewApiError);
  assert.ok(mapContractsForRequest("R_100", "") instanceof DerivNewApiError);
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
  const q = normalizeProposal({ proposal: { id: "abc" } }) as Record<string, unknown>;
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
