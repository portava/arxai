// Synthetic shorthand resolver contract test (V<base> / V<base> 1s).
//
// Proves the alias layer added to symbolDirectory.resolveBrokerSymbol against
// the REAL enumerated Deriv volatility set (the 15 instruments the EA reported
// from connection 446 / userId 4):
//   - V75   → AMBIGUOUS (both "Volatility 75 Index" and "...(1s) Index" exist)
//   - V150  → resolves directly (only the (1s) instrument exists)
//   - V75 1s / V75(1s) → resolves directly to the (1s) variant
//   - V999  → no such base → no match (caller surfaces SYMBOL_NOT_FOUND)
//   - V10 ≠ V100 — EXACT base-number match, never a prefix collision
//   - never a silent pick: 2+ matches always return candidates
//
// Pure: exercises the exported matcher with an in-memory inventory (no DB), so
// it runs in the backend chain (typecheck + tsx) with no fixtures.

import {
  matchSyntheticShorthand,
  parseSyntheticShorthand,
} from "../../artifacts/api-server/src/lib/mt5/symbolDirectory.js";

type Sym = { symbol: string; brokerSymbol: string | null };
const mk = (name: string): Sym => ({ symbol: name, brokerSymbol: name });

// The real 15-name volatility set enumerated from connection 446 (userId 4).
// Bases with BOTH std + (1s): 10, 25, 50, 75, 100. (1s)-only: 15, 30, 90, 150, 250.
const REAL_NAMES = [
  "Volatility 10 (1s) Index", "Volatility 10 Index",
  "Volatility 100 (1s) Index", "Volatility 100 Index",
  "Volatility 15 (1s) Index",
  "Volatility 150 (1s) Index",
  "Volatility 25 (1s) Index", "Volatility 25 Index",
  "Volatility 250 (1s) Index",
  "Volatility 30 (1s) Index",
  "Volatility 50 (1s) Index", "Volatility 50 Index",
  "Volatility 75 (1s) Index", "Volatility 75 Index",
  "Volatility 90 (1s) Index",
];
const INV: Sym[] = [
  ...REAL_NAMES.map(mk),
  { symbol: "EURUSD", brokerSymbol: "EURUSD" },
  { symbol: "XAUUSD", brokerSymbol: "XAUUSD" },
];

type CheckResult = { id: number; name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function record(id: number, name: string, ok: boolean, detail: string) {
  results.push({ id, name, ok, detail });
}

// Mirror of resolveBrokerSymbol's shorthand-branch mapping.
type Outcome =
  | { kind: "FALLTHROUGH" }                       // not a shorthand
  | { kind: "RESOLVED"; broker: string }
  | { kind: "AMBIGUOUS"; candidates: string[] }
  | { kind: "NO_MATCH" };                         // shorthand, but no base hit
function outcome(requested: string): Outcome {
  const hits = matchSyntheticShorthand(requested, INV);
  if (hits === null) return { kind: "FALLTHROUGH" };
  if (hits.length === 0) return { kind: "NO_MATCH" };
  if (hits.length === 1) return { kind: "RESOLVED", broker: hits[0]!.brokerSymbol! };
  return { kind: "AMBIGUOUS", candidates: hits.map((h) => h.brokerSymbol!) };
}

// 1. V75 → ambiguous with BOTH real candidates (never a silent pick).
const o1 = outcome("V75");
record(1, "V75 → ambiguous with both candidates",
  o1.kind === "AMBIGUOUS" && o1.candidates.length === 2 &&
  o1.candidates.includes("Volatility 75 Index") &&
  o1.candidates.includes("Volatility 75 (1s) Index"),
  JSON.stringify(o1));

// 2. V150 → resolves directly (only the (1s) instrument exists).
const o2 = outcome("V150");
record(2, "V150 → resolves (only one exists)",
  o2.kind === "RESOLVED" && o2.broker === "Volatility 150 (1s) Index", JSON.stringify(o2));

// 3. "V75 1s" → resolves to the (1s) variant.
const o3 = outcome("V75 1s");
record(3, "V75 1s → resolves to (1s) variant",
  o3.kind === "RESOLVED" && o3.broker === "Volatility 75 (1s) Index", JSON.stringify(o3));

// 4. "V75(1s)" parenthesised form resolves identically.
const o4 = outcome("V75(1s)");
record(4, "V75(1s) → resolves to (1s) variant",
  o4.kind === "RESOLVED" && o4.broker === "Volatility 75 (1s) Index", JSON.stringify(o4));

// 5. V999 → no such base → NO_MATCH (caller surfaces SYMBOL_NOT_FOUND).
const o5 = outcome("V999");
record(5, "V999 → no match", o5.kind === "NO_MATCH", JSON.stringify(o5));

// 6-8. V10 ≠ V100 — exact base, no prefix collision; disjoint candidate sets.
const o10 = outcome("V10");
const o100 = outcome("V100");
const v10 = o10.kind === "AMBIGUOUS" ? new Set(o10.candidates) : new Set<string>();
const v100 = o100.kind === "AMBIGUOUS" ? new Set(o100.candidates) : new Set<string>();
record(6, "V10 → exactly the two base-10 instruments",
  v10.size === 2 && v10.has("Volatility 10 Index") && v10.has("Volatility 10 (1s) Index"),
  JSON.stringify([...v10]));
record(7, "V100 → exactly the two base-100 instruments",
  v100.size === 2 && v100.has("Volatility 100 Index") && v100.has("Volatility 100 (1s) Index"),
  JSON.stringify([...v100]));
record(8, "V10 and V100 candidate sets are disjoint",
  v10.size > 0 && v100.size > 0 && [...v10].every((c) => !v100.has(c)),
  JSON.stringify({ v10: [...v10], v100: [...v100] }));

// 9-10. Non-shorthand input falls through to the normal resolver.
record(9, "EURUSD is not a shorthand (fall-through)",
  outcome("EURUSD").kind === "FALLTHROUGH", JSON.stringify(outcome("EURUSD")));
record(10, "'Volatility 75' is not a shorthand (fall-through)",
  outcome("Volatility 75").kind === "FALLTHROUGH", "");

// 11-12. parseSyntheticShorthand base / oneSecond correctness.
const p1 = parseSyntheticShorthand("V75");
const p2 = parseSyntheticShorthand("V75 1s");
record(11, "parse V75 → base 75, any variant",
  !!p1 && p1.base === 75 && p1.oneSecond === null, JSON.stringify(p1));
record(12, "parse 'V75 1s' → base 75, oneSecond",
  !!p2 && p2.base === 75 && p2.oneSecond === true, JSON.stringify(p2));

// 13. V250 (1s)-only base resolves directly.
const o13 = outcome("V250");
record(13, "V250 → resolves (only (1s) exists)",
  o13.kind === "RESOLVED" && o13.broker === "Volatility 250 (1s) Index", JSON.stringify(o13));

// 14. V0 → base 0 rejected (not a positive base) → not a shorthand (fall-through).
record(14, "V0 → not a shorthand (fall-through)",
  parseSyntheticShorthand("V0") === null && outcome("V0").kind === "FALLTHROUGH",
  JSON.stringify(parseSyntheticShorthand("V0")));

// 15. V075 → leading zeros normalise to base 75 (still ambiguous, never silent).
const o15 = outcome("V075");
record(15, "V075 → base 75, ambiguous (leading zeros)",
  o15.kind === "AMBIGUOUS" && o15.candidates.length === 2, JSON.stringify(o15));

// 16. "V75abc" → junk suffix rejected (not a shorthand).
record(16, "V75abc → not a shorthand (fall-through)",
  parseSyntheticShorthand("V75abc") === null, JSON.stringify(parseSyntheticShorthand("V75abc")));

const passed = results.filter((r) => r.ok).length;
for (const r of results) {
  // eslint-disable-next-line no-console
  console.log(`${r.ok ? "PASS" : "FAIL"}  #${String(r.id).padStart(2, "0")}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
}
// eslint-disable-next-line no-console
console.log(`\n${passed}/${results.length} synthetic-shorthand checks passed`);
if (passed !== results.length) process.exit(1);
