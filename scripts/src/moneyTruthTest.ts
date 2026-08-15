// Test: the Money value object (@workspace/money).
//
// The three lies a bare `number` tells about money, each pinned by a test:
//
//   1. FLOAT DRIFT. 0.1 + 0.2 !== 0.3 in binary floating point, and summing a
//      ledger of such amounts drifts from the sum of its parts. The suite adds
//      ten thousand amounts and asserts the total is EXACT — the float version of
//      the same loop is asserted to be wrong, so the test proves the problem
//      exists rather than just asserting the fix works.
//
//   2. NO CURRENCY. `usd.add(jpy)` must THROW. Coercing would produce a total
//      off by a factor of ~150 that looks entirely reasonable, and a plausible
//      wrong number is worse than an error.
//
//   3. NO SCALE. $1.005 is not representable in cents, so the rounding must be
//      named and consistent rather than left to whichever call site got there
//      first. Every mode is checked on both signs, because `Math.round`'s
//      half-to-+Infinity behaviour is asymmetric about zero and biases any
//      ledger holding both credits and debits.
//
// Pure unit test — no DB, no network, no clock. Offline CI lane.

import {
  Money,
  sumMoney,
  scaleForCurrency,
  isIso4217Code,
} from "@workspace/money";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;

  function assert(cond: boolean, label: string) {
    if (cond) {
      passes++;
      console.log(`  ✓ ${label}`);
    } else {
      failures++;
      console.error(`  ✗ ${label}`);
    }
  }
  function throws(fn: () => unknown, label: string) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    assert(threw, label);
  }

  console.log("moneyTruthTest");
  console.log("==============\n");

  // ── 1. Float drift — the problem, then the fix ─────────────────────────────
  console.log("Float drift");
  {
    // The problem, demonstrated rather than asserted from memory.
    assert(0.1 + 0.2 !== 0.3, "binary float: 0.1 + 0.2 !== 0.3 (the defect being removed)");

    const a = Money.of("0.10", "USD");
    const b = Money.of("0.20", "USD");
    assert(a.add(b).equals(Money.of("0.30", "USD")), "Money: 0.10 + 0.20 === 0.30 exactly");

    // Ten thousand additions of an amount with no exact binary representation.
    let float = 0;
    let money = Money.zero("USD");
    const cent = Money.of("0.01", "USD");
    for (let i = 0; i < 10_000; i++) {
      float += 0.01;
      money = money.add(cent);
    }
    assert(float !== 100, `float: 10,000 × 0.01 drifted to ${float} (not 100)`);
    assert(money.toDecimalString() === "100.00", "Money: 10,000 × 0.01 is exactly 100.00");
    assert(money.minor === 10_000n, "…carried as exactly 10000 minor units");
  }

  // ── 2. Currency mismatch throws ────────────────────────────────────────────
  console.log("\nCurrency and scale mismatches throw");
  {
    const usd = Money.of("100.00", "USD");
    const jpy = Money.of("100", "JPY");
    const eur = Money.of("100.00", "EUR");

    throws(() => usd.add(jpy), "add across USD/JPY THROWS (never coerced)");
    throws(() => usd.sub(eur), "sub across USD/EUR THROWS");
    throws(() => usd.compare(eur), "compare across currencies THROWS");
    throws(() => sumMoney([usd, eur]), "sumMoney across currencies THROWS");
    assert(!usd.equals(eur), "equals across currencies is false, not an error");
    assert(usd.add(Money.of("1.00", "USD")).toDecimalString() === "101.00",
      "same-currency addition still works");

    // Same currency, different scale — a USD amount carried at 4dp is not
    // interchangeable with one at 2dp, and silently mixing them mis-scales.
    const usd4 = Money.of("100.0000", "USD", { scale: 4 });
    throws(() => usd.add(usd4), "add across scales within one currency THROWS");
    assert(!usd.equals(usd4), "equals is false across scales");
  }

  // ── 3. Scale and rounding, named and symmetric ─────────────────────────────
  console.log("\nScale is per-currency, never assumed");
  {
    assert(scaleForCurrency("USD") === 2, "USD scale is 2");
    assert(scaleForCurrency("JPY") === 0, "JPY scale is 0 (no sen in circulation)");
    assert(scaleForCurrency("KWD") === 3, "KWD scale is 3");
    assert(scaleForCurrency("XYZ") === null, "an unknown code has no scale — null, not 2");

    assert(Money.of("1500", "JPY").minor === 1500n, "¥1500 is 1500 minor units, not 150000");
    assert(Money.of("1500", "JPY").toDecimalString() === "1500", "…and renders with no decimals");
    assert(Money.of("1.234", "KWD").minor === 1234n, "KWD carries 3 decimal places");

    // The honest default-deny: an unknown currency must be given a scale.
    throws(() => Money.of("1.00", "XYZ"), "an unknown currency with no explicit scale THROWS");
    assert(Money.of("1.00", "XYZ", { scale: 2 }).minor === 100n,
      "…and is accepted once the caller names the scale");

    throws(() => Money.of("1.00", "US"), "a 2-letter code is rejected");
    throws(() => Money.of("1.00", "USDD"), "a 4-letter code is rejected");
    throws(() => Money.of("1.00", "us1"), "a non-alpha code is rejected");
    assert(isIso4217Code("USD") && !isIso4217Code("usd"), "the code check requires uppercase alpha-3");
    assert(Money.of("1.00", "usd").currency === "USD", "…but construction normalises case");
  }

  console.log("\nRounding is named, and symmetric about zero");
  {
    // $1.005 at scale 2 — the classic. Each mode, on both signs.
    const cases: Array<[string, string, string]> = [
      ["HALF_UP", "1.005", "1.01"],
      ["HALF_UP", "-1.005", "-1.01"],
      ["HALF_EVEN", "1.005", "1.00"],
      ["HALF_EVEN", "1.015", "1.02"],
      ["HALF_EVEN", "-1.005", "-1.00"],
      ["TRUNCATE", "1.009", "1.00"],
      ["TRUNCATE", "-1.009", "-1.00"],
      ["FLOOR", "1.009", "1.00"],
      ["FLOOR", "-1.001", "-1.01"],
      ["CEIL", "1.001", "1.01"],
      ["CEIL", "-1.009", "-1.00"],
    ];
    for (const [mode, input, expected] of cases) {
      const got = Money.of(input, "USD", { mode: mode as never }).toDecimalString();
      assert(got === expected, `${mode}: ${input} → ${expected} (got ${got})`);
    }

    // HALF_UP is symmetric: rounding a credit and its matching debit cancels.
    const up = Money.of("1.005", "USD");
    const down = Money.of("-1.005", "USD");
    assert(up.add(down).isZero(), "HALF_UP: +1.005 and −1.005 round to a net of exactly zero");
    // Math.round would not: it sends both halves toward +Infinity.
    assert(Math.round(100.5) + Math.round(-100.5) === 1,
      "…whereas Math.round leaves a 1-unit bias on the same pair (the defect avoided)");
  }

  // ── 4. Construction ────────────────────────────────────────────────────────
  console.log("\nConstruction");
  {
    assert(Money.of("1234.56", "USD").minor === 123456n, "string parses exactly");
    assert(Money.of(1234.56, "USD").minor === 123456n, "a number is accepted and rounded at scale");
    assert(Money.of(1234, "USD").minor === 123400n, "an integer number scales up");
    assert(Money.of(1234n, "USD").minor === 123400n, "a bigint is taken as whole units");
    assert(Money.of("-0.01", "USD").minor === -1n, "negatives parse");
    assert(Money.of(".5", "USD").minor === 50n, 'a leading-dot decimal ".5" parses as 0.50');
    assert(Money.of("5.", "USD").minor === 500n, 'a trailing-dot "5." parses as 5.00');
    assert(Money.of(1e-7, "USD").minor === 0n, "an exponent-form number does not break the parser");
    assert(Money.of("1e-7", "USD").minor === 0n, "…nor does an exponent-form string (String(1e-7))");
    assert(Money.of(String(1e21), "USD").minor === 100000000000000000000000n,
      "…nor does a large exponent-form string");
    assert(Money.fromMinor(1234n, "USD").toDecimalString() === "12.34", "fromMinor is exact");
    assert(Money.fromMinor(1234, "USD").minor === 1234n, "fromMinor accepts a safe integer");
    assert(Money.zero("USD").isZero(), "zero() is zero");

    throws(() => Money.of(NaN, "USD"), "NaN is rejected");
    throws(() => Money.of(Infinity, "USD"), "Infinity is rejected");
    throws(() => Money.of("abc", "USD"), "a non-numeric string is rejected");
    throws(() => Money.of("", "USD"), "an empty string is rejected");
    throws(() => Money.fromMinor(1.5, "USD"), "a fractional minor-unit count is rejected");
    throws(() => Money.fromMinor(Number.MAX_SAFE_INTEGER + 2, "USD"),
      "an unsafe integer minor count is rejected (pass a bigint instead)");
  }

  // ── 5. bigint headroom ─────────────────────────────────────────────────────
  console.log("\nbigint headroom — beyond what a double can count");
  {
    const huge = Money.fromMinor(9_007_199_254_740_992n, "USD"); // 2^53
    const one = Money.fromMinor(1n, "USD");
    const bigger = huge.add(one);
    assert(bigger.minor === 9_007_199_254_740_993n,
      "addition is exact at 2^53, where a double can no longer count by ones");
    // 2^53 + 1 has no double representation, so a float total genuinely cannot
    // tell these two apart — this is the concrete reason minor units are bigint.
    assert(Number(huge.minor) === Number(bigger.minor),
      "…and a double cannot tell those two totals apart (the reason for bigint)");
    assert(huge.minor !== bigger.minor, "…while the bigint amounts are plainly different");
  }

  // ── 6. Scalar multiply / divide ────────────────────────────────────────────
  console.log("\nScalar arithmetic");
  {
    assert(Money.of("0.10", "USD").mul(3).toDecimalString() === "0.30",
      "0.10 × 3 is exactly 0.30 (float gives 0.30000000000000004)");
    assert(0.1 * 3 !== 0.3, "…and the float version genuinely is wrong");
    assert(Money.of("100.00", "USD").mul("1.5").toDecimalString() === "150.00", "× 1.5");
    assert(Money.of("100.00", "USD").mul(-1).toDecimalString() === "-100.00", "× −1 flips the sign");
    assert(Money.of("100.00", "USD").div(3).toDecimalString() === "33.33", "÷ 3 rounds at scale");
    assert(Money.of("100.00", "USD").div("0.5").toDecimalString() === "200.00", "÷ 0.5 doubles");
    throws(() => Money.of("1.00", "USD").div(0), "division by zero THROWS");

    assert(Money.of("10.00", "USD").negate().toDecimalString() === "-10.00", "negate");
    assert(Money.of("-10.00", "USD").abs().toDecimalString() === "10.00", "abs");
  }

  // ── 7. allocate — the split must balance ───────────────────────────────────
  console.log("\nallocate — a split that always sums back");
  {
    // The classic: a dollar three ways. Naive rounding loses a cent.
    const parts = Money.of("1.00", "USD").allocate([1, 1, 1]);
    const total = sumMoney(parts)!;
    assert(total.toDecimalString() === "1.00", "1.00 split three ways sums back to exactly 1.00");
    assert(parts.map((p) => p.toDecimalString()).join(",") === "0.34,0.33,0.33",
      `…as 0.34/0.33/0.33 (got ${parts.map((p) => p.toDecimalString()).join(",")})`);

    const uneven = Money.of("100.00", "USD").allocate([70, 30]);
    assert(sumMoney(uneven)!.toDecimalString() === "100.00", "a 70/30 split sums back exactly");
    assert(uneven[0]!.toDecimalString() === "70.00", "…and honours the ratio");

    // Negative amounts split without conjuring a unit.
    const neg = Money.of("-1.00", "USD").allocate([1, 1, 1]);
    assert(sumMoney(neg)!.toDecimalString() === "-1.00", "a negative amount splits back exactly");

    // Determinism: the same split twice is byte-identical.
    const again = Money.of("1.00", "USD").allocate([1, 1, 1]);
    assert(parts.every((p, i) => p.equals(again[i]!)), "allocate is deterministic");

    throws(() => Money.of("1.00", "USD").allocate([]), "an empty ratio list THROWS");
    throws(() => Money.of("1.00", "USD").allocate([0, 0]), "ratios summing to zero THROW");
    throws(() => Money.of("1.00", "USD").allocate([1, -1]), "a negative ratio THROWS");
    throws(() => Money.of("1.00", "USD").allocate([1, NaN]), "a NaN ratio THROWS");
  }

  // ── 8. Comparison, rendering, round-trip, immutability ─────────────────────
  console.log("\nComparison, rendering, round-trip");
  {
    const ten = Money.of("10.00", "USD");
    const twenty = Money.of("20.00", "USD");
    assert(ten.lessThan(twenty) && twenty.greaterThan(ten), "ordering works");
    assert(ten.compare(ten) === 0 && ten.equals(Money.of("10.00", "USD")), "equality works");
    assert(ten.isPositive() && ten.negate().isNegative() && Money.zero("USD").isZero(),
      "sign predicates work");

    assert(ten.toString() === "10.00 USD", "toString carries the currency, never the bare number");
    assert(Money.of("-0.05", "USD").toDecimalString() === "-0.05", "small negatives render correctly");
    assert(Money.of("0.05", "USD").toDecimalString() === "0.05", "leading zero is preserved");

    const round = Money.fromJSON(JSON.parse(JSON.stringify(ten)));
    assert(round.equals(ten), "JSON round-trip preserves the exact amount");
    assert(typeof ten.toJSON().minor === "string",
      "…because minor units serialise as a STRING (a JSON number would lose bigint precision)");

    assert(ten.toNumberUnsafe() === 10, "toNumberUnsafe converts for display");
    // Immutability: an operation returns a new instance, never mutates.
    const before = ten.minor;
    ten.add(twenty);
    assert(ten.minor === before, "add does not mutate the receiver");
    assert(Object.isFrozen(ten), "instances are frozen");
  }

  // ── 9. A worked P/L, the way the codebase actually uses money ──────────────
  console.log("\nWorked example — a realised P/L ledger that balances");
  {
    // EURUSD 1.00 lot, +100 pips, contract size 100,000 → +$1000.00 exactly.
    const pnl = Money.of("0.00100", "USD", { scale: 5 }).mul(1_000_00n);
    assert(pnl.toDecimalString() === "100.00000", "a 10-pip move × 100,000 units is $100 exactly");

    // A ledger of wins and losses sums exactly, with no drift to explain away.
    const ledger = [
      Money.of("1000.00", "USD"),
      Money.of("-337.42", "USD"),
      Money.of("12.07", "USD"),
      Money.of("-0.01", "USD"),
    ];
    assert(sumMoney(ledger)!.toDecimalString() === "674.64", "the ledger sums to exactly 674.64");

    // Float arithmetic is not always wrong — it is UNRELIABLY right, which is
    // worse, because a ledger that balances in testing can fail in production on
    // a different set of amounts. This one balances:
    const floatSum = 1000.0 - 337.42 + 12.07 - 0.01;
    assert(floatSum === 674.64, `this particular float ledger happens to land exactly (${floatSum})`);
    // …and this one, three amounts long, does not:
    const drifting = [Money.of("0.10", "USD"), Money.of("0.20", "USD"), Money.of("-0.30", "USD")];
    const driftFloat = 0.1 + 0.2 - 0.3;
    assert(driftFloat !== 0, `float: 0.10 + 0.20 − 0.30 = ${driftFloat}, not 0`);
    assert(sumMoney(drifting)!.isZero(), "Money: the same three amounts sum to exactly zero");
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "moneyTruthTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[moneyTruthTest] FAILED:", err);
      process.exit(1);
    },
  );
}
