// Test: the real-data validation lane (scripts/src/research/realDataValidation.ts).
//
// Runs the full validation stack — every strategyEngine family, walk-forward
// selection, purged/embargoed CPCV, Deflated Sharpe, PBO, one family-wide BH
// pass — over the PINNED REAL-HISTORY FIXTURE and asserts the pipeline's
// honesty properties, not merely that it runs:
//
//   1. DATA     the fixture is real and is the fixture: every file re-hashes to
//               its manifest, the dataset hash equals the one pinned in code, a
//               single flipped byte is refused, and nothing in it is synthetic.
//   2. NO LOOKAHEAD  CPCV purge+embargo and walk-forward gaps are re-verified
//               from the index sets; every variant passes a prefix-invariance
//               check on real bars. Each verifier is shown to CATCH a planted
//               leak, so a zero is a measurement, not a verifier that never fires.
//   3. MULTIPLE TESTING  BH runs once over the whole search with m = every
//               test supplied, the DSR is charged the same m, and the naive
//               per-test reading of the same p-values is shown to differ.
//   4. POSITIVE CONTROL  a seeded synthetic edge mixed into a real family IS
//               detected and is the only survivor — so "nothing survived" on
//               real data is a finding, not thresholds nothing can clear.
//   5. FINDING  the real-data result is pinned: zero survivors. If a code or
//               data change ever produces one, this fails and a human looks.
//   6. CEILING  every survivor anywhere is ceiling SHADOW and liveAllowed=false.
//
// Pure: no DB, no network, no clock. Deterministic.

import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpcvSplits, allStrategyVariants, FAMILY_KEYS, type StrategyVariant } from "@workspace/validation";
import { loadVerifiedFixture, FixtureIntegrityError, datasetHashOf } from "./research/realHistoryFixture.js";
import {
  runRealDataValidation,
  cpcvIsolationViolations,
  walkForwardViolations,
  walkForwardFolds,
  lookaheadViolation,
  DEFAULT_RUNNER_PARAMS,
  REAL_DATA_RUNNER_VERSION,
} from "./research/realDataValidation.js";
import { fixtureInstruments, FIXTURE_DIR, PINNED_FIXTURE_DATASET_HASH, formatFindings } from "./research/runRealDataValidation.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;
  const assert = (cond: boolean, label: string) => {
    if (cond) { passes++; console.log(`  ✓ ${label}`); } else { failures++; console.error(`  ✗ ${label}`); }
  };
  const throwsIntegrity = (fn: () => unknown): boolean => {
    try { fn(); return false; } catch (e) { return e instanceof FixtureIntegrityError; }
  };

  console.log("realDataValidationTest");
  console.log("======================\n");

  // ── 1. The data is real, and it is the pinned data ─────────────────────────
  console.log("1. Pinned real-history fixture");
  const { manifest, instruments: loaded } = loadVerifiedFixture(FIXTURE_DIR, PINNED_FIXTURE_DATASET_HASH);
  assert(manifest.datasetHash === PINNED_FIXTURE_DATASET_HASH, `dataset hash matches the hash pinned in code (${PINNED_FIXTURE_DATASET_HASH.slice(0, 16)}…)`);
  assert(manifest.syntheticData === false, "manifest attests syntheticData=false");
  assert(manifest.instruments.every((i) => i.source.name === "binance-public-data" || i.source.name === "fred"),
    "every instrument comes from a documented free real-market source (Binance archive or FRED)");
  assert(manifest.instruments.filter((i) => i.source.name === "binance-public-data")
    .every((i) => /matched its published \.CHECKSUM/.test(i.source.upstreamVerification)),
  "every Binance file was verified against the upstream published CHECKSUM at fetch time");
  const classes = new Set(manifest.instruments.map((i) => i.assetClass));
  assert(classes.has("fx") && classes.has("crypto") && classes.has("metal"), `covers FX, crypto and a metal (${[...classes].join(", ")})`);
  assert(loaded.every((i) => i.bars.length >= 1500), `every series is long enough to validate (min ${Math.min(...loaded.map((i) => i.bars.length))} bars)`);
  assert(manifest.instruments.filter((i) => i.ohlc === "close_only").every((i) => i.source.name === "fred"),
    "only FRED series are close-only, and the manifest says so");
  {
    const dir = mkdtempSync(join(tmpdir(), "arx-fixture-tamper-"));
    try {
      cpSync(FIXTURE_DIR, dir, { recursive: true });
      const f = join(dir, manifest.instruments[0]!.file);
      const body = readFileSync(f, "utf8");
      // Change ONE digit of one close price.
      const at = body.lastIndexOf("0");
      writeFileSync(f, `${body.slice(0, at)}1${body.slice(at + 1)}`);
      assert(throwsIntegrity(() => loadVerifiedFixture(dir, PINNED_FIXTURE_DATASET_HASH)), "a single changed digit in a fixture file is REFUSED before use");
    } finally { rmSync(dir, { recursive: true, force: true }); }
    assert(throwsIntegrity(() => loadVerifiedFixture(FIXTURE_DIR, "0".repeat(64))), "a dataset hash other than the pinned one is REFUSED");
    const reordered = [...manifest.instruments].reverse();
    assert(datasetHashOf(reordered) !== manifest.datasetHash, "the dataset hash covers instrument order and every file hash");
  }

  // ── 2. The lookahead verifiers can fail ────────────────────────────────────
  console.log("\n2. Lookahead verifiers catch planted leaks");
  const eur = loaded.find((i) => i.spec.symbol === "EURUSDT")!;
  {
    const leaky: Pick<StrategyVariant, "positions"> = {
      positions: (bars) => bars.map((b, i) => (i + 1 < bars.length ? Math.sign(bars[i + 1]!.close - b.close) : 0)),
    };
    assert(lookaheadViolation(leaky, eur.bars, 8) !== null, "a strategy that reads the NEXT bar is caught by the prefix-invariance check");
    const honest = allStrategyVariants()[0]!;
    assert(lookaheadViolation(honest, eur.bars, 8) === null, `…while a real family variant (${honest.key}) passes it`);

    const nObs = eur.bars.length - 1;
    const unpurged = cpcvSplits({ nObs, nGroups: 6, p: 2, horizon: 0, embargo: 0 });
    const leaks = unpurged.reduce((a, s) => a + cpcvIsolationViolations(s, nObs, 5, 5), 0);
    assert(leaks > 0, `CPCV splits built WITHOUT purge/embargo are caught (${leaks} leaking training indices across ${unpurged.length} splits)`);
    const purged = cpcvSplits({ nObs, ...DEFAULT_RUNNER_PARAMS.cpcv });
    assert(purged.every((s) => cpcvIsolationViolations(s, nObs, 5, 5) === 0), "…and the runner's purged+embargoed splits have none");
    const purgedTotal = purged.reduce((a, s) => a + s.purgedCount, 0);
    const embargoedTotal = purged.reduce((a, s) => a + s.embargoedCount, 0);
    assert(purgedTotal > 0 && embargoedTotal > 0 && purged.every((s) => s.purgedCount + s.embargoedCount > 0),
      `…because purge (${purgedTotal}) and embargo (${embargoedTotal}) actually removed observations, in every split`);

    const tight = walkForwardFolds(nObs, DEFAULT_RUNNER_PARAMS.walkForward).map((f) => ({ ...f, trainEnd: f.testStart, selected: "x", trainSharpe: 0, testSharpe: 0 }));
    assert(walkForwardViolations(tight, 5, 5) === tight.length, "walk-forward folds whose training runs up to the test start are caught");
  }

  // ── 3–6. The real run ──────────────────────────────────────────────────────
  console.log("\n3. Real-data run over every family and instrument");
  const { datasetHash, instruments } = fixtureInstruments();
  const t0 = Date.now();
  const real = runRealDataValidation({ instruments, datasetHash });
  console.log(`    (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  console.log(formatFindings(real).split("\n").map((l) => `    ${l}`).join("\n"));
  console.log("");

  const nVariants = allStrategyVariants().length;
  const m = instruments.length * nVariants + instruments.length * FAMILY_KEYS.length;
  assert(real.runnerVersion === REAL_DATA_RUNNER_VERSION && real.datasetHash === PINNED_FIXTURE_DATASET_HASH, "the run is stamped with the runner version and the pinned dataset hash");
  assert(FAMILY_KEYS.every((f) => real.families.includes(f)), `all ${FAMILY_KEYS.length} strategyEngine families were swept`);
  assert(real.variants.length === instruments.length * nVariants, `every variant ran on every instrument (${real.variants.length})`);
  assert(real.walkForward.length === instruments.length * FAMILY_KEYS.length, `one walk-forward selection series per instrument × family (${real.walkForward.length})`);
  const ohlcSymbols = new Set(instruments.filter((i) => i.ohlc === "ohlc").map((i) => i.symbol));
  assert(FAMILY_KEYS.every((f) => real.summary.some((s) => s.familyKey === f && ohlcSymbols.has(s.symbol) && s.activeVariants > 0)),
    "every family actually TRADED on at least one real-OHLC instrument — no family was skipped");
  const silent = real.summary.filter((s) => s.activeVariants === 0);
  assert(silent.every((s) => s.rangesDerived), `families that never traded are only on close-only (derived-range) series, and are reported NOT SEARCHED (${silent.map((s) => `${s.symbol}:${s.familyKey}`).join(", ") || "none"})`);

  console.log("\n   no lookahead");
  assert(real.checks.cpcvSplitsChecked === instruments.length * 15 && real.checks.cpcvViolations === 0,
    `0 purge/embargo violations across ${real.checks.cpcvSplitsChecked} CPCV splits on real data`);
  assert(real.checks.walkForwardFoldsChecked > 0 && real.checks.walkForwardViolations === 0,
    `0 gap violations across ${real.checks.walkForwardFoldsChecked} walk-forward folds (train end + horizon + embargo ≤ test start)`);
  assert(real.checks.lookaheadVariantsChecked === real.variants.length && real.checks.lookaheadViolations.length === 0,
    `every one of ${real.checks.lookaheadVariantsChecked} variant×instrument signals is prefix-invariant on real bars`);
  assert(real.walkForward.every((w) => w.folds.every((f) => f.trainEnd + 10 <= f.testStart)), "walk-forward selection only ever saw bars ≥10 before each test window");

  console.log("\n   multiple-testing correction");
  assert(real.fdr.familySize === m && real.checks.testsSupplied === m, `BH ran ONCE over the whole search with m = ${m} (${instruments.length} instruments × (${nVariants} variants + ${FAMILY_KEYS.length} walk-forward series))`);
  assert(real.checks.dsrTrialsCharged === m, `the Deflated Sharpe was charged for the same m = ${m}`);
  assert(real.checks.dsrTrialSharpeSd > 0, `the DSR null field is the run-wide Sharpe spread (sd ${real.checks.dsrTrialSharpeSd})`);
  const allP = [...real.variants.map((v) => v.pValue), ...real.walkForward.map((w) => w.pValue)];
  const naive = allP.filter((p) => p < 0.05).length;
  console.log(`    naive per-test p<0.05 "discoveries": ${naive}; after BH at q=${real.fdr.q}: ${real.fdr.rejections}`);
  assert(naive > real.fdr.rejections, `the correction changes the answer: ${naive} naive p<0.05 hits vs ${real.fdr.rejections} BH certifications`);
  const surv = real.variants.filter((v) => v.survivor);
  assert(surv.every((v) => v.factoryVerdict === "PASS" && v.fdrCertified), "a survivor must pass the factory AND the family-wide BH — never one or the other");

  console.log("\n   the finding (pinned)");
  assert(real.survivors.length === 0, `ZERO survivors on real data across ${m} tests (got ${real.survivors.length}: ${real.survivors.map((s) => s.key).join(", ") || "none"})`);
  assert(real.walkForward.every((w) => !w.survivor), "no walk-forward parameter selection survived out of sample");

  console.log("\n4. Positive control — a seeded synthetic edge on real data IS detected");
  const planted = { symbol: "EURUSD", familyKey: "TrendContinuation", hitRate: 0.58, seed: 20261109 };
  const ctl = runRealDataValidation({ instruments, datasetHash, planted, params: { ...DEFAULT_RUNNER_PARAMS, lookaheadSamples: 1 } });
  const pv = ctl.variants.find((v) => v.planted)!;
  console.log(`    planted (hit rate ${planted.hitRate}, seed ${planted.seed}): ann.SR ${pv.annualisedSharpe.toFixed(2)}, DSR ${pv.dsr.toFixed(4)}, PBO ${pv.pbo}, p ${pv.pValue.toExponential(2)}`);
  assert(ctl.fdr.familySize === m + 1, `the planted control is charged as one more trial (m = ${ctl.fdr.familySize})`);
  assert(pv.factoryVerdict === "PASS", `it clears CPCV + DSR + PBO (${pv.vetoes.join("; ") || "no vetoes"})`);
  assert(pv.fdrCertified, "…and is certified by the family-wide BH");
  assert(ctl.survivors.length === 1 && ctl.survivors[0]!.key === pv.key, "…and it is the ONLY survivor — no real strategy rode in with it");
  assert(ctl.walkForward.every((w) => w.folds.every((f) => !f.selected.includes("PLANTED"))), "the walk-forward selector never sees the planted control");

  console.log("\n5. Promotion ceiling");
  for (const r of [real, ctl]) {
    assert(r.survivors.every((s) => s.promotionCeiling === "SHADOW" && s.liveAllowed === false),
      `${r.planted ? "control" : "real"} run: every survivor is ceiling SHADOW, liveAllowed=false`);
    assert(!JSON.stringify(r).includes('"liveAllowed":true'), `${r.planted ? "control" : "real"} run: nothing serialises liveAllowed as true`);
  }

  console.log("\n6. Determinism");
  {
    const sub = instruments.slice(0, 2);
    const a = runRealDataValidation({ instruments: sub, datasetHash, params: { ...DEFAULT_RUNNER_PARAMS, lookaheadSamples: 1 } });
    const b = runRealDataValidation({ instruments: sub, datasetHash, params: { ...DEFAULT_RUNNER_PARAMS, lookaheadSamples: 1 } });
    assert(/^[0-9a-f]{64}$/.test(a.resultHash) && a.resultHash === b.resultHash, "the same data and parameters give the same result hash");
    assert(a.paramsHash !== real.paramsHash, "a parameter change changes the params hash");
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "realDataValidationTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => { console.error("[realDataValidationTest] FAILED:", err); process.exit(1); },
  );
}
