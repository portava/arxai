// THEME D2 — the self-trading ENTRY sizer must convert quote → account currency.
//
// `computeRiskAwareLot` sizes from `riskPerLot = stopDistance ×
// valuePerUnitPerLot`, and compares that against a risk budget expressed in the
// ACCOUNT currency. So `valuePerUnitPerLot` has to be
// `contractSize × quoteToAccountFx`.
//
// `valuePerUnitPerLotFor` returned the contract size ALONE. For any pair whose
// quote half is not the account currency, the stop distance is measured in
// quote currency while the budget is in account currency, so the two sides of
// the division are in different units and the lot comes out wrong. The
// function's own header even documented "contractSize × quote-conv" — the
// conversion was described but never applied.
//
// This is the ENTRY-side analogue of the P0-2 close-side bug, and it reuses
// exactly the same helper that fix introduced (`resolveQuoteToAccountFx`),
// rather than a second implementation that could drift from it.
//
// Worked example — USDJPY, USD account, entry 150.00:
//   P/L accrues in JPY; the account is USD; USD is the BASE half, so the
//   factor is 1/150 (INVERSE_QUOTE).
//   Without it, riskPerLot is ~150× too large and the lot ~150× too small.
//
// HONESTY: when the factor cannot be resolved the sizer must REFUSE (block),
// never fall back to 1. Silently assuming parity is precisely how a non-USD
// cross gets mis-sized.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { resolveQuoteToAccountFx } from "../../mt5/contractSize.js";
import { computeRiskAwareLot } from "@workspace/domain/self-trade";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXECUTOR = resolve(HERE, "../agentExecutor.ts");

function executorSource(): string {
  return readFileSync(EXECUTOR, "utf8");
}

/** The `valuePerUnitPerLotFor` function body. */
function sizerFn(src: string): string {
  const start = src.indexOf("async function valuePerUnitPerLotFor");
  assert.ok(start > -1, "valuePerUnitPerLotFor must still exist");
  const end = src.indexOf("function entryPriceFromThesis", start);
  assert.ok(end > start);
  return src.slice(start, end);
}

describe("D2 — the entry sizer applies the quote→account factor", () => {
  it("resolves the FX factor rather than using contract size alone", () => {
    const fn = sizerFn(executorSource());
    assert.ok(
      /resolveQuoteToAccountFx\(/.test(fn),
      "the entry sizer must apply the same conversion the close side does",
    );
    assert.ok(
      !/return\s+sizing\.contractSize;\s*$/m.test(fn),
      "returning the raw contract size skips the conversion entirely",
    );
  });

  it("reuses the P0-2 helper instead of a second implementation", () => {
    const src = executorSource();
    assert.ok(/resolveQuoteToAccountFx,?\s*\n?/.test(src));
    assert.ok(/from "\.\.\/mt5\/contractSize\.js"/.test(src));
  });

  it("takes the entry price, which the conversion needs", () => {
    const fn = sizerFn(executorSource());
    assert.ok(
      /entryPrice/.test(fn),
      "an INVERSE_QUOTE factor is 1/price — the sizer cannot compute it without one",
    );
  });

  it("refuses to size when the factor cannot be resolved", () => {
    const fn = sizerFn(executorSource());
    assert.ok(
      /fx\.factor == null/.test(fn) && /ok:\s*false/.test(fn),
      "an unresolvable factor must refuse, never silently assume parity",
    );
    assert.ok(
      !/factor\s*\?\?\s*1\b/.test(fn),
      "falling back to 1 is exactly the mis-sizing this fixes",
    );
  });

  it("distinguishes a missing spec from an unresolvable rate", () => {
    // Both refuse, but they are different operator problems: one needs a
    // symbol spec synced, the other needs a cross rate the resolver cannot
    // derive. Collapsing them into one code sends the operator to the wrong fix.
    const fn = sizerFn(executorSource());
    assert.ok(/NO_CONTRACT_SPEC/.test(fn));
    assert.ok(/NO_QUOTE_FX/.test(fn));
  });

  it("surfaces an honest block reason for the FX failure", () => {
    const src = executorSource();
    assert.ok(
      /NO_QUOTE_FX/.test(src),
      "an FX-resolution failure should not be reported as a missing contract spec",
    );
  });
});

describe("D2 — the conversion arithmetic is correct", () => {
  it("USDJPY on a USD account uses the inverse quote", () => {
    const fx = resolveQuoteToAccountFx({
      symbol: "USDJPY",
      profitCurrency: "JPY",
      accountCurrency: "USD",
      closePrice: 150,
    });
    assert.equal(fx.source, "INVERSE_QUOTE");
    assert.ok(fx.factor != null);
    assert.ok(Math.abs(fx.factor - 1 / 150) < 1e-12);
  });

  it("a USD-quoted pair on a USD account is a no-op factor of 1", () => {
    const fx = resolveQuoteToAccountFx({
      symbol: "EURUSD",
      profitCurrency: "USD",
      accountCurrency: "USD",
      closePrice: 1.1,
    });
    assert.equal(fx.source, "SAME_CURRENCY");
    assert.equal(fx.factor, 1);
  });

  it("an unresolvable cross yields no factor at all", () => {
    const fx = resolveQuoteToAccountFx({
      symbol: "EURGBP",
      profitCurrency: "GBP",
      accountCurrency: "USD",
      closePrice: 0.85,
    });
    assert.equal(fx.factor, null);
    assert.equal(fx.reason, "NO_CROSS_RATE_AVAILABLE");
  });
});

describe("D2 — the factor materially changes the sized lot", () => {
  const base = {
    side: "BUY" as const,
    entryPrice: 150,
    stopLossPrice: 149.5, // 0.5 JPY stop
    riskBudgetUsd: 100,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
    agentMaxLot: 100,
    sizeMultiplier: 1,
  };
  const CONTRACT = 100_000;

  it("USDJPY sizes differently with and without the conversion", () => {
    const withoutFx = computeRiskAwareLot({ ...base, valuePerUnitPerLot: CONTRACT });
    const withFx = computeRiskAwareLot({ ...base, valuePerUnitPerLot: CONTRACT * (1 / 150) });
    assert.ok(!withoutFx.cannotSize && !withFx.cannotSize);
    assert.ok(
      withFx.lot > withoutFx.lot,
      `the converted lot must differ: withFx=${withFx.lot} withoutFx=${withoutFx.lot}`,
    );
  });

  it("only the converted lot spends the intended risk budget", () => {
    const withFx = computeRiskAwareLot({ ...base, valuePerUnitPerLot: CONTRACT * (1 / 150) });
    // risk = stopDistance(JPY) × contract × fx × lot, in USD.
    const riskUsd = 0.5 * CONTRACT * (1 / 150) * withFx.lot;
    assert.ok(
      riskUsd <= base.riskBudgetUsd + 1e-6,
      `converted risk ${riskUsd} must respect the ${base.riskBudgetUsd} budget`,
    );
    assert.ok(riskUsd > base.riskBudgetUsd * 0.9, "and should use most of it");
  });

  it("a same-currency pair is unaffected by the change", () => {
    const eurusd = {
      ...base,
      entryPrice: 1.1,
      stopLossPrice: 1.095,
      valuePerUnitPerLot: CONTRACT,
    };
    const before = computeRiskAwareLot(eurusd);
    const after = computeRiskAwareLot({ ...eurusd, valuePerUnitPerLot: CONTRACT * 1 });
    assert.equal(after.lot, before.lot);
  });
});
