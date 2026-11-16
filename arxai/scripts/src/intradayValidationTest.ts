// Test: the INTRADAY real-data validation lane — the Deriv feeds ARX trades.
//
// Runs the full validation factory (every strategyEngine family, walk-forward
// selection, purged/embargoed CPCV, Deflated Sharpe, PBO, one run-wide BH pass)
// over the pinned Deriv M1/M5/M15/H1 fixture and asserts:
//
//   1. DATA      the fixture is the fixture: every file re-hashes, the dataset
//                hash is the one pinned in code, one changed digit is refused,
//                an off-grid (partial) bar is refused even with a re-signed
//                manifest, every page boundary was cross-checked at fetch, and
//                short series are listed as excluded rather than padded.
//   2. RESULT    the real run is reported EXACTLY: its platform-stable finding
//                digest (every float at 8 significant figures, every verdict,
//                veto, FDR decision and walk-forward pick exact), its survivor
//                set and its survivor count per symbol × timeframe are pinned.
//                The full-precision resultHash is NOT pinned: V8's libm differs
//                in the last ulp between arm64 and x64, so it is a per-machine
//                identity. A change in code or data that moves the finding fails.
//   3. GROSS     the same search at ZERO cost is reported and pinned too, so no
//                cost assumption can be what hides an edge.
//   4. CONTROL   a seeded synthetic edge planted in a real intraday series IS
//                detected and is the only survivor.
//   5. DETERMINISM  same data + params ⇒ same result hash, twice.
//   6. CEILING   every survivor anywhere is SHADOW / liveAllowed=false.
//
// Pure: no DB, no network, no clock. Strategies are NOT tuned here — the grid is
// allStrategyVariants(), unchanged.

import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allStrategyVariants, FAMILY_KEYS } from "@workspace/validation";
import { FixtureIntegrityError } from "./research/realHistoryFixture.js";
import {
  loadVerifiedIntradayFixture, intradayDatasetHashOf, TIMEFRAME_ORDER, type IntradayFixtureManifest,
} from "./research/intradayHistoryFixture.js";
import {
  runRealDataValidation, INTRADAY_RUNNER_PARAMS, DEFAULT_RUNNER_PARAMS, grossParams, paramsHashOf, findingDigest,
  type RealDataRunResult,
} from "./research/realDataValidation.js";
import {
  intradayFixtureInstruments, INTRADAY_FIXTURE_DIR, PINNED_INTRADAY_DATASET_HASH, INTRADAY_PLANTED_CONTROL,
  formatFindings, survivorGrid,
} from "./research/runRealDataValidation.js";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

/**
 * THE MEASURED FINDING, pinned. Produced by this exact code on the pinned
 * fixture; if either moves, a human must look at why before it is re-pinned.
 */
export const PINNED_INTRADAY_RESULT = {
  findingDigest: "7ab4ae53718d46eb39544cab9ea4180ba03c3c52161006ef3133e3cbedbb3ac5",
  survivorKeys: [] as string[],
  grossFindingDigest: "3a2973f747e2e72d4e2656ea2e9deec788e003864c447e1629fd92f2639d4556",
  grossSurvivorKeys: [] as string[],
};

/** The daily lane's params hash must not move because the intraday lane exists. */
const DAILY_PARAMS_HASH_PREFIX = "729e1ec9e6f8692198dc0dd0e175e82e7647ba8107c80e536bff6ba246c315c1";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;
  const assert = (cond: boolean, label: string) => {
    if (cond) { passes++; console.log(`  ✓ ${label}`); } else { failures++; console.error(`  ✗ ${label}`); }
  };
  const integrityError = (fn: () => unknown): string | null => {
    try { fn(); return null; } catch (e) { return e instanceof FixtureIntegrityError ? e.message : `non-integrity error: ${String(e)}`; }
  };

  console.log("intradayValidationTest");
  console.log("======================\n");

  // ── 1. The data ───────────────────────────────────────────────────────────
  console.log("1. Pinned Deriv intraday fixture");
  const { manifest, instruments: loaded } = loadVerifiedIntradayFixture(INTRADAY_FIXTURE_DIR, PINNED_INTRADAY_DATASET_HASH);
  assert(manifest.datasetHash === PINNED_INTRADAY_DATASET_HASH, `dataset hash matches the hash pinned in code (${PINNED_INTRADAY_DATASET_HASH.slice(0, 16)}…)`);
  assert(manifest.syntheticData === false, "manifest attests syntheticData=false (served by Deriv, not generated here)");
  assert(manifest.instruments.every((i) => i.source.name === "deriv-public-ws" && i.source.url.startsWith("wss://api.derivws.com/")),
    "every series comes from Deriv's public market-data WebSocket");
  assert(manifest.instruments.every((i) => i.bars === manifest.barCapPerSeries), `every included series holds exactly the cap of ${manifest.barCapPerSeries} closed bars`);
  assert(manifest.instruments.every((i) => /(\d+) page-boundary bars re-served complete and matched exactly/.test(i.source.upstreamVerification)
    && Number(/(\d+) page-boundary/.exec(i.source.upstreamVerification)![1]) > 0),
  "every series had its page boundaries cross-checked against a re-served complete bar at fetch time");
  const syms = new Set(manifest.instruments.map((i) => i.symbol));
  for (const s of ["R_50", "R_75", "R_100", "1HZ75V", "1HZ100V", "frxEURUSD", "frxGBPUSD", "frxUSDJPY", "frxXAUUSD"]) {
    assert(syms.has(s), `${s} is in the fixture`);
  }
  for (const tf of TIMEFRAME_ORDER) assert(manifest.instruments.some((i) => i.timeframe === tf), `timeframe ${tf} is covered`);
  assert(manifest.excluded.every((e) => e.closedBarsAvailable < manifest.barCapPerSeries && /not padded/.test(e.reason)),
    `short series are EXCLUDED and listed, never padded (${manifest.excluded.map((e) => `${e.symbol}@${e.timeframe}=${e.closedBarsAvailable}`).join(", ") || "none"})`);
  assert(manifest.instruments.length + manifest.excluded.length === 9 * TIMEFRAME_ORDER.length,
    "every requested symbol × timeframe is accounted for (included or excluded)");
  {
    const dir = mkdtempSync(join(tmpdir(), "arx-intraday-tamper-"));
    try {
      cpSync(INTRADAY_FIXTURE_DIR, dir, { recursive: true });
      const spec = manifest.instruments[0]!;
      const f = join(dir, spec.file);
      const body = readFileSync(f, "utf8");
      const at = body.lastIndexOf("1");
      writeFileSync(f, `${body.slice(0, at)}2${body.slice(at + 1)}`);
      assert(integrityError(() => loadVerifiedIntradayFixture(dir, PINNED_INTRADAY_DATASET_HASH)) !== null, "a single changed digit in a fixture file is REFUSED before use");

      // An off-grid bar (a partial bucket) is refused even when the attacker re-signs the manifest.
      const lines = body.split("\n");
      lines[2] = lines[2]!.replace(/:00Z,/, ":30Z,");
      const offGrid = lines.join("\n");
      writeFileSync(f, offGrid);
      const m2 = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as IntradayFixtureManifest;
      m2.instruments[0]!.sha256 = sha256(offGrid);
      m2.datasetHash = intradayDatasetHashOf(m2.instruments);
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(m2));
      const err = integrityError(() => loadVerifiedIntradayFixture(dir, m2.datasetHash));
      assert(err !== null && /off the .* grid/.test(err), `an off-grid (partial) bar is REFUSED even with a re-signed manifest (${err})`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    assert(integrityError(() => loadVerifiedIntradayFixture(INTRADAY_FIXTURE_DIR, "0".repeat(64))) !== null, "a dataset hash other than the pinned one is REFUSED");
  }
  assert(loaded.every((i) => i.bars.every((b, k) => k === 0 || Date.parse(i.dates[k]!) > Date.parse(i.dates[k - 1]!))), "open times strictly increase in every series");

  // ── 2. The real run ───────────────────────────────────────────────────────
  console.log("\n2. Real intraday run — every family, every series, net of assumed costs");
  const { datasetHash, instruments } = intradayFixtureInstruments();
  const t0 = Date.now();
  const real = runRealDataValidation({ instruments, datasetHash, params: INTRADAY_RUNNER_PARAMS });
  console.log(`    (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  console.log(formatFindings(real).split("\n").map((l) => `    ${l}`).join("\n"));
  console.log(`\n    survivors per symbol × timeframe (net):\n${survivorGrid(real).split("\n").map((l) => `      ${l}`).join("\n")}\n`);

  const nVariants = allStrategyVariants().length;
  const m = instruments.length * (nVariants + FAMILY_KEYS.length);
  assert(FAMILY_KEYS.every((f) => real.families.includes(f)), `all ${FAMILY_KEYS.length} strategyEngine families were swept`);
  assert(real.variants.length === instruments.length * nVariants, `every variant ran on every series (${real.variants.length})`);
  assert(real.fdr.familySize === m && real.checks.dsrTrialsCharged === m, `BH and the Deflated Sharpe were both charged the whole search, m = ${m}`);
  assert(real.checks.cpcvViolations === 0 && real.checks.cpcvSplitsChecked === instruments.length * 15, `0 purge/embargo leaks across ${real.checks.cpcvSplitsChecked} CPCV splits`);
  assert(real.checks.walkForwardViolations === 0 && real.checks.walkForwardFoldsChecked > 0, `0 gap violations across ${real.checks.walkForwardFoldsChecked} walk-forward folds`);
  assert(real.checks.lookaheadViolations.length === 0 && real.checks.lookaheadVariantsChecked === real.variants.length,
    `every one of ${real.checks.lookaheadVariantsChecked} signals is prefix-invariant on real intraday bars`);
  assert(real.instruments.every((i) => typeof i.timeframe === "string") && real.summary.every((s) => typeof s.timeframe === "string"),
    "the stored result carries the timeframe on every instrument and summary row");
  assert(real.instruments.every((i) => i.source.startsWith("fixture:real-history-intraday-v1/")), "…and the source file of every series");
  assert(FAMILY_KEYS.every((f) => real.summary.some((s) => s.familyKey === f && s.activeVariants > 0)), "every family actually traded on at least one series");
  const allP = [...real.variants.map((v) => v.pValue), ...real.walkForward.map((w) => w.pValue)];
  console.log(`    naive per-test p<0.05 "discoveries": ${allP.filter((p) => p < 0.05).length}; after BH: ${real.fdr.rejections}`);
  const keysOf = (r: RealDataRunResult) => r.survivors.map((x) => x.key).sort();
  console.log(`    resultHash (full precision, this machine) ${real.resultHash}`);
  assert(JSON.stringify(keysOf(real)) === JSON.stringify(PINNED_INTRADAY_RESULT.survivorKeys),
    `the real survivor set is reported exactly: [${keysOf(real).join(", ")}] (pinned [${PINNED_INTRADAY_RESULT.survivorKeys.join(", ")}])`);
  assert(findingDigest(real) === PINNED_INTRADAY_RESULT.findingDigest, `the real finding digest is the pinned one (${findingDigest(real)})`);
  {
    // The digest must ignore last-ulp platform noise and still catch a real change.
    const jitter = (v: unknown): unknown => typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v) ? v * (1 + 4e-16)
      : Array.isArray(v) ? v.map(jitter) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jitter(x)])) : v;
    const noisy = jitter(real) as RealDataRunResult;
    assert(findingDigest(noisy) === findingDigest(real), "the finding digest is unchanged by last-ulp float noise (the arm64/x64 difference)");
    const moved = structuredClone(real);
    moved.variants[0]!.dsr += 1e-5;
    assert(findingDigest(moved) !== findingDigest(real), "…but a real change (one DSR moved by 1e-5) changes it");
    const vetoed = structuredClone(real);
    vetoed.variants[0]!.vetoes = [...vetoed.variants[0]!.vetoes, "X"];
    assert(findingDigest(vetoed) !== findingDigest(real), "…and so does any change to a verdict or veto");
  }

  // ── 3. Zero-cost diagnostic ───────────────────────────────────────────────
  console.log("\n3. Same search at ZERO cost (diagnostic — no cost assumption can hide an edge)");
  const gross = runRealDataValidation({ instruments, datasetHash, params: grossParams(INTRADAY_RUNNER_PARAMS) });
  console.log(`    m=${gross.fdr.familySize} BH rejections=${gross.fdr.rejections} survivors=${gross.survivors.length} result ${gross.resultHash.slice(0, 16)}…`);
  console.log(`    survivors per symbol × timeframe (gross):\n${survivorGrid(gross).split("\n").map((l) => `      ${l}`).join("\n")}`);
  for (const s of gross.survivors) console.log(`      gross survivor ${s.key} ann.SR ${s.annualisedSharpe.toFixed(2)} DSR ${s.dsr.toFixed(3)} p ${s.pValue.toExponential(2)}`);
  assert(gross.paramsHash !== real.paramsHash && Object.values(gross.params.costPerTurnover).every((c) => c === 0), "the diagnostic really is zero-cost, and hashes as different parameters");
  assert(JSON.stringify(keysOf(gross)) === JSON.stringify(PINNED_INTRADAY_RESULT.grossSurvivorKeys),
    `gross survivor set reported exactly: [${keysOf(gross).join(", ")}] (pinned [${PINNED_INTRADAY_RESULT.grossSurvivorKeys.join(", ")}])`);
  assert(findingDigest(gross) === PINNED_INTRADAY_RESULT.grossFindingDigest, `the gross finding digest is the pinned one (${findingDigest(gross)})`);

  // ── 4. Positive control ───────────────────────────────────────────────────
  console.log("\n4. Positive control — a seeded synthetic edge in a real intraday series IS detected");
  const planted = INTRADAY_PLANTED_CONTROL;
  const ctl = runRealDataValidation({ instruments, datasetHash, planted, params: { ...INTRADAY_RUNNER_PARAMS, lookaheadSamples: 1 } });
  const pv = ctl.variants.find((v) => v.planted)!;
  console.log(`    planted on ${planted.symbol} ${planted.familyKey} (hit rate ${planted.hitRate}, seed ${planted.seed}): ann.SR ${pv.annualisedSharpe.toFixed(2)}, DSR ${pv.dsr.toFixed(4)}, PBO ${pv.pbo}, p ${pv.pValue.toExponential(2)}`);
  assert(ctl.fdr.familySize === m + 1, `the planted control is charged as one more trial (m = ${ctl.fdr.familySize})`);
  assert(pv.factoryVerdict === "PASS", `it clears CPCV + DSR + PBO (${pv.vetoes.join("; ") || "no vetoes"})`);
  assert(pv.fdrCertified, "…and the run-wide BH certifies it");
  assert(ctl.survivors.length === 1 && ctl.survivors[0]!.key === pv.key, "…and it is the ONLY survivor — no real strategy rode in with it");
  assert(ctl.walkForward.every((w) => w.folds.every((f) => !f.selected.includes("PLANTED"))), "the walk-forward selector never sees the planted control");

  // ── 5. Determinism ────────────────────────────────────────────────────────
  console.log("\n5. Determinism");
  {
    // The full real run is already pinned to a constant (section 2); here a
    // subset is run twice in-process as well.
    const sub = instruments.filter((i) => i.timeframe === "H1").slice(0, 3);
    const quick = { ...INTRADAY_RUNNER_PARAMS, lookaheadSamples: 1 };
    const a = runRealDataValidation({ instruments: sub, datasetHash, params: quick });
    const b = runRealDataValidation({ instruments: sub, datasetHash, params: quick });
    assert(/^[0-9a-f]{64}$/.test(a.resultHash) && a.resultHash === b.resultHash, "the same data and parameters give the same result hash, run after run");
    assert(paramsHashOf(DEFAULT_RUNNER_PARAMS).startsWith(DAILY_PARAMS_HASH_PREFIX), "the daily lane's parameters (and so its stored evidence identity) are unchanged");
  }

  // ── 6. Ceiling ────────────────────────────────────────────────────────────
  console.log("\n6. Promotion ceiling");
  for (const [label, r] of [["real", real], ["gross", gross], ["control", ctl]] as Array<[string, RealDataRunResult]>) {
    assert(r.survivors.every((s) => s.promotionCeiling === "SHADOW" && s.liveAllowed === false) && !JSON.stringify(r).includes('"liveAllowed":true'),
      `${label} run: every survivor is ceiling SHADOW, liveAllowed=false, nothing serialises liveAllowed true`);
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "intradayValidationTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => { console.error("[intradayValidationTest] FAILED:", err); process.exit(1); },
  );
}
