// C8 TURN-OF-MONTH — THE OWNER'S PRESS. Not runnable by accident.
//
// READ THIS BEFORE RUNNING ANYTHING HERE
// --------------------------------------
// This script is the only path from a provisioned dataset to a C8 verdict. It
// is gated because a verdict here is IRREVERSIBLE: a MISS retires the
// experiment, emits an FDR charge against the family, and permanently refuses
// re-evaluation of the same spec on the same data. There is no undo and no
// second spin.
//
// THE TWO PHASES, AND WHY THEY ARE SEPARATE
// ------------------------------------------
//   --phase evaluate   Reads the holdout, computes the OOS statistics, and
//                      STOPS. Requires --confirm-oos-read. This does not retire
//                      anything and can be re-run — but it is still a real
//                      threshold, because a human who has seen the OOS Sharpe
//                      cannot unsee it, and every later decision is made by
//                      someone who knows the answer.
//
//   --phase verdict    Calls harness.verdict(). THIS IS THE ONE SHOT. Requires
//                      --confirm-one-shot AND a shadow-P&L file.
//
// WHY THE VERDICT PHASE DEMANDS SHADOW DATA — a trap worth naming
// ----------------------------------------------------------------
// The pre-registered pass bar has FOUR clauses and one of them is SHADOW_CI:
// at least `minShadowObservations` live-shadow observations whose 95% CI
// excludes zero from the positive side. The verdict is an AND. So calling
// verdict() with zero shadow observations produces a GUARANTEED MISS — and that
// MISS is terminal: it retires the experiment and charges FDR exactly as a
// real failure would, on a technicality, before the strategy was ever given a
// chance to fail on its merits.
//
// That is not a hypothetical. It is what happens if someone runs this script
// end-to-end the day the data lands. So the verdict phase REFUSES to run
// without at least the pre-registered number of shadow observations, and says
// why. Accruing them is a separate, slower job: shadow the strategy live across
// at least that many month boundaries, recording each boundary's P&L.
//
// Nothing in this script places, sizes, or authorises a trade. It reads a
// snapshot file and writes an evidence file.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import {
  TURN_OF_MONTH_SPEC,
  TransferProofHarness,
  buildCostModel,
  buildFitSelectionField,
  buildTurnOfMonthEvaluationInput,
  isRefusal,
  isTurnOfMonthBuildRefusal,
  verifyTurnOfMonthPreRegistration,
} from "@workspace/validation";
import { checkSeriesIntegrity, formatIntegrityReport, parseSnapshot } from "@workspace/markets";
import { parseArgv, requireStr } from "./c8DataFeed.js";

const SPEC = TURN_OF_MONTH_SPEC;

function line(s = ""): void {
  console.log(s);
}

function usage(): void {
  line("C8 TURN-OF-MONTH EVALUATION — the owner's press");
  line("");
  line("  PHASE 1 (repeatable, but you cannot unsee the answer):");
  line("    node --import tsx scripts/src/c8TurnOfMonthEvaluate.ts \\");
  line("      --phase evaluate --confirm-oos-read \\");
  line("      --snapshot docs/c8-data/<SYMBOL>.snapshot.json \\");
  line("      --at <iso instant> --evidence docs/c8-data/<SYMBOL>.evaluation.json");
  line("");
  line("  PHASE 2 (ONE SHOT — a miss retires the niche and charges FDR):");
  line("    node --import tsx scripts/src/c8TurnOfMonthEvaluate.ts \\");
  line("      --phase verdict --confirm-one-shot \\");
  line("      --snapshot docs/c8-data/<SYMBOL>.snapshot.json \\");
  line(`      --shadow docs/c8-data/<SYMBOL>.shadow.json   # >= ${SPEC.passBar.minShadowObservations} observations`);
  line("      --at <iso instant> --evidence docs/c8-data/<SYMBOL>.verdict.json");
  line("");
  line("  Both phases refuse without their confirmation flag. --at is always required:");
  line("  the harness never reads a clock.");
}

/** Shadow P&L file: a JSON array of numbers, or of {pnl:number} objects. */
function parseShadow(text: string): number[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error("shadow file must be a JSON array");
  return raw.map((r, i) => {
    const v = typeof r === "number" ? r : (r as { pnl?: unknown })?.pnl;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`shadow observation ${i} is not a finite number — a NaN observation is a failed read, not evidence`);
    }
    return v;
  });
}

async function main(): Promise<number> {
  const argv = parseArgv(process.argv.slice(2));
  const phase = argv.phase;
  if (phase !== "evaluate" && phase !== "verdict") {
    usage();
    return 2;
  }
  if (typeof argv.at !== "string") {
    line("REFUSED: --at <iso instant> is required. This path never reads a clock.");
    return 2;
  }
  const at = argv.at;

  if (phase === "evaluate" && argv["confirm-oos-read"] !== true) {
    line("REFUSED: --phase evaluate needs --confirm-oos-read.");
    line("Reading the holdout is a threshold: once you have seen the out-of-sample result, every later");
    line("decision is made by someone who knows the answer. Confirm deliberately.");
    return 2;
  }
  if (phase === "verdict" && argv["confirm-one-shot"] !== true) {
    line("REFUSED: --phase verdict needs --confirm-one-shot.");
    line("A verdict is irreversible: a MISS retires the experiment, charges the family's FDR, and the same");
    line("spec can never be re-run on this data. Confirm deliberately.");
    return 2;
  }

  // ── 0. pre-registration ───────────────────────────────────────────────────
  line("0. PRE-REGISTRATION");
  const pre = verifyTurnOfMonthPreRegistration();
  if (!pre.intact) {
    line(`   REFUSED — ${pre.detail}`);
    return 1;
  }
  line(`   intact: ${pre.specHash}`);
  line(`   ${SPEC.experimentKey}`);
  line(`   instrument ${SPEC.instrument} (${SPEC.instrumentClass}), size ${SPEC.size}`);
  line(`   rule "${SPEC.calendarRule}"  offsets entry ${SPEC.entryOffsetDays}, exit ${SPEC.exitOffsetDays}`);
  line(`   fit ${SPEC.fitWindow.start}..${SPEC.fitWindow.end}, holdout ${SPEC.holdoutWindow.start}..${SPEC.holdoutWindow.end}`);
  line(
    `   pass bar: netDSR >= ${SPEC.passBar.minNetDsr}, PBO < ${SPEC.passBar.maxPbo}, ` +
      `netSharpe >= ${SPEC.passBar.minNetSharpe}, shadow n >= ${SPEC.passBar.minShadowObservations}`,
  );
  line();

  // ── 1. the dataset ────────────────────────────────────────────────────────
  const snapshotPath = requireStr(argv, "snapshot");
  const snap = parseSnapshot(await readFile(snapshotPath, "utf8"));
  if (!snap.ok) {
    line(`1. DATASET — REFUSED ${snap.code}: ${snap.detail}`);
    return 1;
  }
  line("1. DATASET");
  line(`   ${snapshotPath}`);
  line(`   symbol ${snap.series.symbol}, adjustment ${snap.series.provenance.adjustment}, terms ${snap.series.provenance.termsOfUse}`);
  line(`   source ${snap.series.provenance.source} via ${snap.series.provenance.request}`);
  line(`   fetchedAt ${snap.series.provenance.fetchedAt}`);
  line(`   ${snap.series.provenance.detail}`);
  if (snap.series.provenance.termsOfUse === "UNVERIFIED") {
    line("   NOTE: this dataset's licence is UNVERIFIED. That is an owner gate before it backs capital.");
  }
  if (snap.series.symbol !== SPEC.instrument) {
    line(
      `   NOTE: the pre-registered instrument is "${SPEC.instrument}" and this dataset is "${snap.series.symbol}". ` +
        "The spec's notes leave the venue instrument to the owner; this substitution is the owner's call and is recorded here, not decided here.",
    );
  }
  const integrity = checkSeriesIntegrity(snap.series, {
    requiredCoverage: [
      { label: "fitWindow", start: SPEC.fitWindow.start, end: SPEC.fitWindow.end },
      { label: "holdoutWindow", start: SPEC.holdoutWindow.start, end: SPEC.holdoutWindow.end },
    ],
  });
  line("   INTEGRITY GUARD");
  line(formatIntegrityReport(integrity));
  if (!integrity.ok) {
    line("   REFUSED: the dataset does not pass the integrity guard. No evaluation runs on refused data.");
    return 1;
  }
  line();

  // ── 2. the fit-stage selection field (PBO's input) ────────────────────────
  const costModel = buildCostModel({
    instrument: SPEC.instrument,
    instrumentClass: SPEC.instrumentClass,
    venue: typeof argv.venue === "string" ? argv.venue : "unpriced-research-venue",
  });
  const selection = buildFitSelectionField(snap.series.bars, SPEC, SPEC.fitWindow, costModel);
  line("2. FIT-STAGE SELECTION FIELD (for PBO)");
  line(
    `   ${selection.variants.length} variants over ${selection.commonBoundaryMonths.length} common boundary months; ` +
      `the pre-registered variant is index ${selection.specVariantIndex}`,
  );
  if (selection.specVariantIndex < 0) {
    line("   REFUSED: the pre-registered (entry, exit) offsets are not in the declared fit grid.");
    line("   PBO against a field the search never contained is measuring a fiction.");
    return 1;
  }
  line(
    `   costs applied to every variant row: perSide ${costModel.perSideCostFrac.toFixed(6)} ` +
      `(spread ${costModel.spread.provenance}, slippage ${costModel.slippage.provenance}, commission ${costModel.commission.provenance})`,
  );
  line();

  // ── 3. the OOS input ──────────────────────────────────────────────────────
  const build = buildTurnOfMonthEvaluationInput(snap.series.bars, SPEC, SPEC.holdoutWindow, {
    at,
    costModel,
    fingerprintSymbol: snap.series.symbol,
    fingerprintAdjustment: snap.series.provenance.adjustment,
    // The experiment itself is a trial, and the fit grid was searched. Charging
    // the DSR only for the one variant would understate the multiplicity.
    nTrials: selection.variants.length,
    selectionField: selection.field,
    pboBlocks: 10,
  });
  if (isTurnOfMonthBuildRefusal(build)) {
    line(`3. OOS TRACK — REFUSED ${build.code}: ${build.detail}`);
    return 1;
  }
  line("3. OOS TRACK");
  line(`   ${build.trades.length} round trips, ${build.skipped.length} boundary/boundaries skipped at the window seams`);
  for (const s of build.skipped) line(`     SKIPPED ${s.boundaryMonth} (${s.reason})`);
  line(`   data window ${build.input.dataWindow.start}..${build.input.dataWindow.end}`);
  line(`   dataFingerprint ${build.input.dataFingerprint}`);
  line(`   total cost charged over the track ${build.totalCostCharged.toFixed(6)}`);
  line();

  // ── 4. register + evaluate ────────────────────────────────────────────────
  const harness = new TransferProofHarness();
  const reg = harness.register(SPEC, at);
  if (isRefusal(reg)) {
    line(`4. REGISTER — REFUSED ${reg.code}: ${reg.detail}`);
    return 1;
  }
  const ev = harness.evaluate(SPEC, build.input);
  if (isRefusal(ev)) {
    line(`4. EVALUATE — REFUSED ${ev.code}: ${ev.detail}`);
    return 1;
  }
  const e = ev.evaluation!;
  line("4. EVALUATION (out of sample, net of costs)");
  line(`   observations ${e.nObs} over ${e.dataWindow.start}..${e.dataWindow.end}`);
  line(`   net Sharpe   ${e.netSharpe.toFixed(6)}   (bar >= ${SPEC.passBar.minNetSharpe})`);
  line(`   net DSR      ${e.netDsr.toFixed(6)}   (bar >= ${SPEC.passBar.minNetDsr})`);
  line(
    `   PBO          ${Number.isFinite(e.pbo) ? e.pbo.toFixed(6) : "UNMEASURABLE"}   (bar < ${SPEC.passBar.maxPbo})`,
  );
  line(`   cost model   ${e.costModelHash}`);
  line();

  const evidencePath = typeof argv.evidence === "string" ? argv.evidence : undefined;

  if (phase === "evaluate") {
    line("PHASE STOPS HERE. No verdict has been issued and nothing has been retired.");
    line(
      `To reach a verdict the SHADOW_CI clause needs at least ${SPEC.passBar.minShadowObservations} live-shadow ` +
        "observations; calling verdict() with none is a guaranteed MISS on a technicality.",
    );
    if (evidencePath !== undefined) await writeEvidence(evidencePath, { phase, at, harness, build, integrity, snapshotPath });
    return 0;
  }

  // ── 5. shadow observations — required before a verdict may be sought ──────
  const shadowPath = typeof argv.shadow === "string" ? argv.shadow : undefined;
  if (shadowPath === undefined) {
    line("5. VERDICT — REFUSED: no --shadow file.");
    line(
      `   The pass bar is an AND over four clauses and one of them needs >= ${SPEC.passBar.minShadowObservations} ` +
        "live-shadow observations. Seeking a verdict without them GUARANTEES a MISS, and that MISS retires the",
    );
    line("   experiment and charges FDR exactly as a real failure would. This script will not spend the shot that way.");
    return 2;
  }
  const shadow = parseShadow(await readFile(shadowPath, "utf8"));
  if (shadow.length < SPEC.passBar.minShadowObservations) {
    line(
      `5. VERDICT — REFUSED: ${shadow.length} shadow observation(s) < the pre-registered ${SPEC.passBar.minShadowObservations}.`,
    );
    return 2;
  }
  for (const pnl of shadow) {
    const r = harness.recordShadowPnl(reg.specHash, pnl, at);
    if (isRefusal(r)) {
      line(`5. SHADOW — REFUSED ${r.code}: ${r.detail}`);
      return 1;
    }
  }
  line(`5. SHADOW: ${shadow.length} observation(s) accrued from ${shadowPath}`);
  line();

  // ── 6. THE VERDICT ────────────────────────────────────────────────────────
  const verdict = harness.verdict(reg.specHash, at);
  if (isRefusal(verdict)) {
    line(`6. VERDICT — REFUSED ${verdict.code}: ${verdict.detail}`);
    return 1;
  }
  line("6. VERDICT");
  line(`   ${verdict.verdict}  ${verdict.experimentKey}`);
  for (const c of verdict.clauses) {
    line(`     ${c.pass ? "pass" : "FAIL"}  ${c.clause.padEnd(12)} ${c.bar.padEnd(44)} ${c.detail}`);
  }
  line(`   ${verdict.detail}`);
  if (verdict.fdrCharge) {
    line(`   FDR charge emitted: key ${verdict.fdrCharge.key}, p ${verdict.fdrCharge.p.toFixed(6)}`);
    line("   Feed this to lib/discovery controlFdr — choosing this niche was itself a trial.");
  }
  if (evidencePath !== undefined) {
    await writeEvidence(evidencePath, { phase, at, harness, build, integrity, snapshotPath, verdict });
  }
  return 0;
}

async function writeEvidence(
  path: string,
  data: Record<string, unknown> & { harness: TransferProofHarness },
): Promise<void> {
  const abs = resolvePath(path);
  await mkdir(dirname(abs), { recursive: true });
  const { harness, ...rest } = data;
  await writeFile(abs, JSON.stringify({ ...rest, chain: harness.chain() }, null, 2) + "\n", "utf8");
  line(`EVIDENCE written to ${abs}`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error(`c8TurnOfMonthEvaluate FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exitCode = 2;
  });
