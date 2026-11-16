// Test: the real-markets fixture and the volatility-forecast results measured on it.
//
// Claims:
//   1. THE DATA IS WHAT IT SAYS. scripts/fixtures/real-markets-v1 verifies
//      byte-for-byte against its manifest, its dataset hash equals the one pinned
//      in code, it declares syntheticData=false, and every series is a REAL market
//      (forex, metal, stock index), never a Deriv synthetic index.
//   2. THE PUBLISHED RESULTS ARE THE MEASURED RESULTS. Re-running the research on
//      that data reproduces the pinned result hash and survivor count exactly, and
//      docs/VOLATILITY_FORECAST_RESULTS.md carries the same numbers. Nothing in the
//      doc can drift from what the code measures.
//   3. THE CLAIM IS HONEST IN SHAPE. Every survivor is an out-of-sample QLIKE
//      improvement over the baseline that cleared Benjamini–Hochberg over the
//      whole family; no row is marked a survivor with improvement ≤ 0.
//
// Reads the pinned fixture only. No DB, no network, no clock.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVerifiedMarketsFixture, PINNED_MARKETS_DATASET_HASH } from "./research/marketsHistoryFixture.js";
import { runVolResearch, renderMarkdown } from "./research/volForecastResearch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");
const DOC = join(HERE, "..", "..", "docs", "VOLATILITY_FORECAST_RESULTS.md");

/** Pinned from the one research run on the pinned fixture. Change only on purpose. */
const PINNED_RESULT_HASH = "0aa2686c40697f47e97aaee84bd1b98c98f3a7669f8edb020a97346c7f32b4b2";
const PINNED_SURVIVORS = 132;
const PINNED_FAMILY = 200;

let passed = 0;
const t = (name: string, fn: () => void) => { fn(); passed++; console.log(`ok - ${name}`); };

const REAL_SYMBOL = /^(frx[A-Z]{6}|OTC_[A-Z0-9]+)$/;

t("the real-markets fixture verifies and is real", () => {
  const { manifest, instruments } = loadVerifiedMarketsFixture(FIXTURES);
  assert.equal(manifest.datasetHash, PINNED_MARKETS_DATASET_HASH);
  assert.equal(manifest.syntheticData, false);
  assert.ok(instruments.length >= 20, `expected the deep set, got ${instruments.length} series`);
  for (const i of instruments) {
    assert.match(i.spec.symbol, REAL_SYMBOL, `${i.spec.symbol} is not a real-market symbol`);
    assert.ok(["fx", "metal", "index"].includes(i.spec.assetClass), `${i.spec.symbol}: asset class ${i.spec.assetClass}`);
    assert.ok(i.bars.length >= 2000, `${i.spec.symbol} ${i.spec.timeframe}: only ${i.bars.length} bars`);
  }
});

const result = runVolResearch();

t("re-running the research reproduces the pinned results", () => {
  assert.equal(result.datasetHash, PINNED_MARKETS_DATASET_HASH);
  assert.equal(result.family, PINNED_FAMILY);
  assert.equal(result.survivors, PINNED_SURVIVORS);
  assert.equal(result.resultHash, PINNED_RESULT_HASH);
});

t("no survivor without a real out-of-sample improvement", () => {
  for (const r of result.rows) {
    if (r.survives) assert.ok(r.improvement > 0 && r.p < 0.05, `${r.key} marked a survivor with improvement ${r.improvement}, p ${r.p}`);
    assert.ok(r.n >= 500, `${r.key}: only ${r.n} scored forecasts`);
  }
});

t("the results doc is exactly what the code measures", () => {
  assert.equal(readFileSync(DOC, "utf8").split("\n## Reading these results")[0]!.trimEnd(), renderMarkdown(result).trimEnd());
});

console.log(`\n${passed} passed`);
