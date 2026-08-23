// Cross-package canonicalization parity.
//
// `stableStringify` is implemented independently in THREE packages —
// @workspace/discovery (pre-registration hashes), @workspace/features
// (the tamper-evident event chain), and @workspace/risk (sizing determinism).
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
// either hasher crashed the caller. All three now match features' encoding.
import { stableStringify as discoveryStringify } from "@workspace/discovery";
import { stableStringify as featuresStringify } from "@workspace/features";
import { stableStringify as riskStringify } from "@workspace/risk";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const IMPLS: ReadonlyArray<readonly [string, (v: unknown) => string]> = [
  ["discovery", discoveryStringify],
  ["features", featuresStringify],
  ["risk", riskStringify],
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

  console.log("\nstableStringifyParityTest — three packages, one canonicalization\n");

  for (const [label, value] of CORPUS) {
    const rendered = IMPLS.map(([name, fn]) => {
      try { return [name, fn(value)] as const; }
      catch (e) { return [name, `THREW:${(e as Error).constructor.name}`] as const; }
    });
    const distinct = new Set(rendered.map(([, out]) => out));
    if (distinct.size === 1 && !rendered[0]![1].startsWith("THREW:")) {
      pass(`${label} → all three agree`);
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
