// Test: FX / Indices / Synthetic intelligence payloads carry NO fabricated
// market data (P0-4).
//
// These three endpoints used to invent market data with Math.random() and
// serve it, unlabeled, to auto-refreshing pages: a jittered VIX, a jittered US
// 10Y yield, a coin-flip risk regime, jittered index levels, and randomised
// per-index confidence — plus hardcoded macro readings and hardcoded synthetic
// ATR values presented as live readings.
//
// This test locks the honest not-connected contract. The decisive assertion is
// DETERMINISM: two consecutive calls must be byte-identical. Any surviving
// Math.random() in these payloads fails that immediately, which is why this
// test fails against the pre-fix code.
//
// It also asserts, structurally, that no fabricated market field is present at
// all — an empty array plus a `providerConnected: false` flag, never a
// partially-populated grid and never a "SIMULATED"-labelled invented number.
//
// Pure unit test — no DB, no network, safe to wire into CI.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getForexIntelligence } from "../../artifacts/api-server/src/lib/forexIntelligence.js";
import {
  getIndicesIntelligence,
  getSyntheticAnalysis,
} from "../../artifacts/api-server/src/lib/indicesIntelligence.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");

export async function run(): Promise<CiTestResultLike> {
let failures = 0;
let passes = 0;

function assert(cond: boolean, label: string) {
  if (cond) { passes++; console.log(`  ✓ ${label}`); }
  else { failures++; console.error(`  ✗ ${label}`); }
}

/** Recursively collect every numeric leaf in a payload. */
function numericLeaves(v: unknown, path = "$", out: string[] = []): string[] {
  if (typeof v === "number") { out.push(`${path}=${v}`); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => numericLeaves(x, `${path}[${i}]`, out)); return out; }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) numericLeaves(x, `${path}.${k}`, out);
  }
  return out;
}

console.log("intelligenceHonestyTest");
console.log("=======================\n");

// ── 1. Determinism — the assertion the fabricated payloads cannot pass ──────
console.log("Determinism: repeated calls must be byte-identical (no Math.random)");
for (const [name, fn] of [
  ["forex", getForexIntelligence],
  ["indices", getIndicesIntelligence],
  ["synthetic", getSyntheticAnalysis],
] as const) {
  const a = JSON.stringify(fn());
  const b = JSON.stringify(fn());
  const c = JSON.stringify(fn());
  assert(a === b && b === c, `${name}: three consecutive payloads are identical`);
}

// ── 2. Honest not-connected contract ───────────────────────────────────────
console.log("\nHonest not-connected contract");
const fx = getForexIntelligence();
const ix = getIndicesIntelligence();
const sy = getSyntheticAnalysis();

assert(fx.providerConnected === false, "forex: providerConnected === false");
assert(ix.providerConnected === false, "indices: providerConnected === false");
assert(sy.providerConnected === false, "synthetic: providerConnected === false");

assert(typeof fx.safetyNote === "string" && fx.safetyNote.length > 20, "forex: carries a safetyNote");
assert(typeof ix.safetyNote === "string" && ix.safetyNote.length > 20, "indices: carries a safetyNote");
assert(typeof sy.safetyNote === "string" && sy.safetyNote.length > 20, "synthetic: carries a safetyNote");

assert(Array.isArray(fx.currencies) && fx.currencies.length === 0, "forex: currencies is empty");
assert(Array.isArray(fx.pairs) && fx.pairs.length === 0, "forex: pairs is empty");
assert(Array.isArray(ix.indices) && ix.indices.length === 0, "indices: indices is empty");
assert(Array.isArray(sy.symbols) && sy.symbols.length === 0, "synthetic: symbols is empty");

// ── 3. No fabricated market field survives anywhere in the payloads ────────
console.log("\nNo fabricated market fields present");
const BANNED_FIELDS = [
  "vixEstimate", "bondYield10Y", "currentLevel", "strength", "confidence",
  "atr", "baseStrength", "quoteStrength", "dollarStrength", "fedExpectation",
  "riskSentiment", "marketSummary", "bondYieldBias", "recommendedLotSize",
  "volatilityLevel", "trend", "atrState", "macroBias", "technicalBias",
  "combinedBias", "rateDifferential", "marketCondition", "sessionNotes",
];
for (const [name, payload] of [["forex", fx], ["indices", ix], ["synthetic", sy]] as const) {
  const json = JSON.stringify(payload);
  const present = BANNED_FIELDS.filter((f) => new RegExp(`"${f}"\\s*:`).test(json));
  assert(present.length === 0, `${name}: no fabricated market field (found: ${present.join(", ") || "none"})`);
}

// The ONLY numbers allowed in these payloads are none at all: every market
// figure is withheld, and `session` is a string label.
for (const [name, payload] of [["forex", fx], ["indices", ix], ["synthetic", sy]] as const) {
  const nums = numericLeaves(payload);
  assert(nums.length === 0, `${name}: payload contains no numeric market value (found: ${nums.join(", ") || "none"})`);
}

// ── 4. Session stays a clock-derived FACT, not a market reading ─────────────
console.log("\nSession label is a clock-derived fact");
assert(typeof fx.session === "string" && fx.session.length > 0, "forex: session is a non-empty label");
assert(typeof ix.session === "string" && ix.session.length > 0, "indices: session is a non-empty label");

// ── 5. Source scan — the modules themselves must be free of Math.random ────
console.log("\nSource scan: no Math.random in the intelligence modules");
for (const rel of [
  "artifacts/api-server/src/lib/forexIntelligence.ts",
  "artifacts/api-server/src/lib/indicesIntelligence.ts",
]) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  // Strip line comments so the explanatory header (which names the removed
  // expressions) cannot false-positive against itself.
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert(!/Math\.random/.test(code), `${rel}: contains no Math.random in code`);
}

console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "intelligenceHonestyTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[intelligenceHonestyTest] FAILED:", err);
      process.exit(1);
    },
  );
}
