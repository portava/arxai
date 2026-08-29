// Cross-package canonicalization parity.
//
// `stableStringify` is implemented independently in FOUR packages —
// @workspace/discovery (pre-registration hashes), @workspace/features
// (the tamper-evident event chain), @workspace/risk (sizing determinism), and
// @workspace/validation (cost-model hashes + transfer-proof chain rows).
// They are deliberately NOT consolidated: these are independently-versioned
// research packages and coupling them would add a dependency edge for a
// ten-line function.
//
// The real hazard is DIVERGENCE, not duplication. If two of them canonicalize
// the same value differently, hashes stop being comparable across subsystems
// and a tamper-evident chain can disagree with the evidence that fed it. This
// suite pins that they agree.
//
// It also pins the bigint case specifically: discovery and risk used to fall
// through to JSON.stringify, which THROWS on a bigint — and @workspace/money
// represents every amount as bigint minor units, so a Money value reaching
// either hasher crashed the caller. Every copy now matches features' encoding.
import { stableStringify as discoveryStringify } from "@workspace/discovery";
import { stableStringify as featuresStringify } from "@workspace/features";
import { stableStringify as riskStringify } from "@workspace/risk";
import { stableStringify as validationStringify } from "@workspace/validation";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const IMPLS: ReadonlyArray<readonly [string, (v: unknown) => string]> = [
  ["discovery", discoveryStringify],
  ["features", featuresStringify],
  ["risk", riskStringify],
  // C7/C8: cost-model hashes and transfer-proof pre-registration/chain rows
  // canonicalize through validation's own copy; the transfer-proof chain is
  // only verifiable by @workspace/features if these two agree byte-for-byte.
  ["validation", validationStringify],
];

/** Values chosen to exercise every branch: ordering, absence, non-finite,
 *  nesting, arrays, and the bigint case that used to throw. */
const CORPUS: ReadonlyArray<readonly [string, unknown]> = [
  ["key order is normalized", { b: 1, a: 2 }],
  ["reversed key order hashes the same", { a: 2, b: 1 }],
  ["arrays keep positional order", [1, "x", null]],
  ["nested objects sort at every depth", { z: [{ q: 1, a: 2 }] }],
  ["deep nesting", { nested: { deep: { k: [1, { y: 2, x: 3 }] } } }],
  ["null", null],
  ["undefined is named, not dropped", undefined],
  ["NaN is named", Number.NaN],
  ["Infinity is named", Number.POSITIVE_INFINITY],
  ["-Infinity is named", Number.NEGATIVE_INFINITY],
  ["string", "s"],
  ["zero", 0],
  ["boolean", true],
  ["empty object", {}],
  ["empty array", []],
  ["bigint (used to THROW in discovery + risk)", { minorUnits: BigInt("9007199254740993") }],
  ["bigint nested in an array", [BigInt(0), BigInt(-5)]],
];

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;
  const pass = (m: string) => { passes += 1; console.log(`  ✓ ${m}`); };
  const fail = (m: string) => { failures += 1; console.log(`  ✗ ${m}`); };

  console.log("\nstableStringifyParityTest — four packages, one canonicalization\n");

  for (const [label, value] of CORPUS) {
    const rendered = IMPLS.map(([name, fn]) => {
      try { return [name, fn(value)] as const; }
      catch (e) { return [name, `THREW:${(e as Error).constructor.name}`] as const; }
    });
    const distinct = new Set(rendered.map(([, out]) => out));
    if (distinct.size === 1 && !rendered[0]![1].startsWith("THREW:")) {
      pass(`${label} → all four agree`);
    } else {
      fail(`${label} → DIVERGED: ${JSON.stringify(rendered)}`);
    }
  }

  // Order-independence must hold WITHIN each impl, not just across them.
  for (const [name, fn] of IMPLS) {
    const a = fn({ x: 1, y: { m: 1, n: 2 }, z: [3, 4] });
    const b = fn({ z: [3, 4], y: { n: 2, m: 1 }, x: 1 });
    if (a === b) pass(`${name}: key order does not change the hash input`);
    else fail(`${name}: key order changed the output (${a} vs ${b})`);
  }

  // ── Type-distinction across the bigint boundary (review request) ──────────
  // A bigint must not be confusable with the number or string that prints the
  // same, or a Money amount could be substituted for a plain scalar without
  // changing the hash.
  for (const [name, fn] of IMPLS) {
    const checks: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ["1n vs 1", BigInt(1), 1],
      ["1n vs '1'", BigInt(1), "1"],
      ["0n vs 0", BigInt(0), 0],
      ["-5n vs -5", BigInt(-5), -5],
      ["0n vs '0'", BigInt(0), "0"],
      ["bigint in array vs number in array", [BigInt(1)], [1]],
      ["bigint in object vs number in object", { v: BigInt(1) }, { v: 1 }],
      ["large bigint vs lossy number", BigInt("9007199254740993"), 9007199254740993],
    ];
    for (const [label, a, b] of checks) {
      if (fn(a) !== fn(b)) pass(`${name}: distinguishes ${label}`);
      else fail(`${name}: COLLISION on ${label} → both "${fn(a)}"`);
    }
  }

  // ── KNOWN LIMITATION, pinned deliberately ─────────────────────────────────
  // A bigint encodes as `"<digits>n"`, which is exactly what JSON.stringify
  // produces for the STRING "<digits>n". So BigInt(1) and "1n" share a
  // canonical form. Two structurally different payloads therefore hash
  // identically — narrow, but it is precisely the ambiguity the event chain
  // exists to prevent.
  //
  // NOT fixed here on purpose: any injective encoding changes bigint output,
  // which would invalidate every stored hash that contains one. That is an
  // owner decision about existing evidence, not a refactor. Recorded in
  // docs/OWNER_DECISIONS.md. This test pins the CURRENT behaviour so the
  // collision stays visible and a future fix must consciously break it.
  for (const [name, fn] of IMPLS) {
    if (fn(BigInt(1)) === fn("1n")) {
      pass(`${name}: known bigint/string collision is still pinned (1n vs "1n")`);
    } else {
      fail(
        `${name}: the bigint/string collision changed. If this was intentional, `
        + `stored hashes containing a bigint are now INVALID and the chain must be `
        + `re-verified — update docs/OWNER_DECISIONS.md before removing this pin.`,
      );
    }
  }

  // ── Nested value objects (review request) ─────────────────────────────────
  // Money is bigint-backed; a Money nested in a payload must hash, and two
  // different amounts must not collapse together.
  {
    const { Money } = await import("@workspace/money");
    const a = Money.fromMinor(BigInt(12345), "USD");
    const b = Money.fromMinor(BigInt(12346), "USD");
    const c = Money.fromMinor(BigInt(12345), "EUR");
    for (const [name, fn] of IMPLS) {
      if (fn({ amount: a }) === fn({ amount: a })) pass(`${name}: nested Money is stable`);
      else fail(`${name}: nested Money is unstable`);
      if (fn({ amount: a }) !== fn({ amount: b })) pass(`${name}: distinguishes Money amounts`);
      else fail(`${name}: collapsed two different Money amounts`);
      if (fn({ amount: a }) !== fn({ amount: c })) pass(`${name}: distinguishes Money currencies`);
      else fail(`${name}: collapsed USD and EUR at the same minor units`);
    }
  }

  // Sensitivity: canonicalization must still DISTINGUISH different values, or
  // it would silently collapse distinct evidence onto one hash.
  for (const [name, fn] of IMPLS) {
    const distinct = new Set([
      fn({ a: 1 }), fn({ a: 2 }), fn({ a: "1" }),
      fn({ a: null }), fn({ a: undefined }), fn([1]),
    ]);
    if (distinct.size === 6) pass(`${name}: distinct values stay distinct`);
    else fail(`${name}: collapsed distinct values (${distinct.size}/6 unique)`);
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "stableStringifyParityTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => { console.error("[stableStringifyParityTest] FAILED:", err); process.exit(1); },
  );
}
