// C8 DRY RUN — prove the plumbing without spending the one shot.
//
// WHAT THIS DOES AND, MORE IMPORTANTLY, WHAT IT REFUSES TO DO
// -----------------------------------------------------------
// The turn-of-month evaluation is ONE-SHOT: a miss retires the niche and
// charges FDR. So the plumbing has to be provable without touching the holdout,
// and this script is that proof. It NEVER reads a bar dated inside the
// pre-registered holdout window — the bars are clipped to the fit window before
// anything else happens, and the clip is ASSERTED, not assumed.
//
// Two modes, and the report always says which one ran:
//
//   --snapshot <path>   REAL fit-era data from an ARX snapshot, clipped to the
//                       fit window. Real bars, real trades, real costs, real
//                       fingerprint. The numbers are fit-window numbers and are
//                       labelled as such.
//   (default)           SYNTHETIC fixture: seeded driftless geometric Brownian
//                       motion on real NYSE session dates, with NO turn-of-month
//                       effect in it by construction. It proves the machinery
//                       moves; it says NOTHING about any edge, and it is never
//                       used for the real experiment (transferProof.ts section
//                       "THE experiment" pins exactly that prohibition).
//
// The plumbing proof has three parts:
//
//   1. TRADES. The generator's entries and exits are printed against the bar
//      dates, so a human can check "close of T−1 → close of T+3" by eye.
//   2. REFUSAL. The fit-window input is offered to the harness under the REAL
//      pre-registered spec and must come back FIT_WINDOW_OVERLAP. That is the
//      discipline demonstrated live, not asserted in a comment.
//   3. END-TO-END. A THROWAWAY spec — different experiment key, windows carved
//      out of the fit era — is registered, evaluated and given a verdict, so
//      every stage of the pipe is exercised. Its verdict is a statement about
//      plumbing and about nothing else.
//
// Exit 0 when every stage behaved. Nothing here places, sizes or authorises a
// trade, and nothing here can produce a verdict on the real experiment.

import { readFile } from "node:fs/promises";
import {
  TURN_OF_MONTH_SPEC,
  TransferProofHarness,
  buildCostModel,
  buildFitSelectionField,
  buildTurnOfMonthEvaluationInput,
  gaussian,
  isRefusal,
  isTurnOfMonthBuildRefusal,
  seeded,
  verifyTurnOfMonthPreRegistration,
  type ExperimentSpec,
} from "@workspace/validation";
import {
  expectedTradingDays,
  isCalendarSpanRefusal,
  parseSnapshot,
  type DailyBar,
  type PriceAdjustment,
} from "@workspace/markets";
import { parseArgv } from "./c8DataFeed.js";

const FIT = TURN_OF_MONTH_SPEC.fitWindow;
const HOLDOUT = TURN_OF_MONTH_SPEC.holdoutWindow;

interface DryRunSeries {
  label: string;
  symbol: string;
  adjustment: PriceAdjustment;
  bars: DailyBar[];
  synthetic: boolean;
  provenanceDetail: string;
}

/**
 * Driftless GBM on REAL session dates. Seeded, so the run is reproducible
 * rather than flaky. There is no turn-of-month term in the generator: this
 * fixture cannot contain the effect, which is precisely why it can only ever
 * prove plumbing.
 */
function syntheticFixture(): DryRunSeries {
  const days = expectedTradingDays(FIT.start, FIT.end);
  if (isCalendarSpanRefusal(days)) throw new Error(`calendar refused the fit window: ${days.detail}`);
  const rnd = gaussian(seeded(20260829));
  const bars: DailyBar[] = [];
  let px = 100;
  for (const d of days) {
    px *= Math.exp(0.01 * rnd() - 0.00005);
    bars.push({ date: d, close: Math.round(px * 1e6) / 1e6 });
  }
  return {
    label: "SYNTHETIC FIXTURE (driftless GBM, seed 20260829)",
    symbol: "FIXTURE",
    adjustment: "split_dividend_adjusted",
    bars,
    synthetic: true,
    provenanceDetail:
      "Generated, not observed. Contains NO turn-of-month effect by construction. Proves the machinery " +
      "moves and NOTHING about any edge. Never valid input for the real experiment.",
  };
}

async function snapshotFixture(path: string): Promise<DryRunSeries> {
  const parsed = parseSnapshot(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error(`snapshot ${path}: ${parsed.code} — ${parsed.detail}`);
  return {
    label: `REAL SNAPSHOT ${path}`,
    symbol: parsed.series.symbol,
    adjustment: parsed.series.provenance.adjustment,
    bars: parsed.series.bars,
    synthetic: false,
    provenanceDetail: parsed.series.provenance.detail,
  };
}

function line(s = ""): void {
  console.log(s);
}

async function main(): Promise<number> {
  const argv = parseArgv(process.argv.slice(2));
  const at = typeof argv.at === "string" ? argv.at : "1970-01-01T00:00:00.000Z";

  line("C8 TURN-OF-MONTH DRY RUN — plumbing proof, FIT WINDOW ONLY");
  line("=========================================================");
  line();

  // ── 0. the pre-registration must be intact before anything else ───────────
  const pre = verifyTurnOfMonthPreRegistration();
  line("0. PRE-REGISTRATION");
  if (!pre.intact) {
    line(`   BROKEN: ${pre.detail}`);
    return 1;
  }
  line(`   intact — spec hash ${pre.specHash}`);
  line(`   fit ${FIT.start}..${FIT.end}   holdout ${HOLDOUT.start}..${HOLDOUT.end}`);
  line(`   rule "${TURN_OF_MONTH_SPEC.calendarRule}"`);
  line();

  // ── 1. the series, clipped to the fit window BEFORE anything reads it ─────
  const source =
    typeof argv.snapshot === "string" ? await snapshotFixture(argv.snapshot) : syntheticFixture();
  const clipped = source.bars.filter((b) => b.date >= FIT.start && b.date <= FIT.end);
  const leaked = clipped.filter((b) => b.date >= HOLDOUT.start && b.date <= HOLDOUT.end);
  line("1. SERIES");
  line(`   ${source.label}`);
  line(`   ${source.provenanceDetail}`);
  line(`   ${source.bars.length} bars supplied; ${clipped.length} inside the fit window after clipping`);
  if (leaked.length > 0) {
    line(`   FAILED: ${leaked.length} holdout bar(s) survived the clip — the dry run refuses to continue`);
    return 1;
  }
  line("   asserted: ZERO holdout bars are in memory for the rest of this run");
  if (clipped.length < 100) {
    line(`   FAILED: only ${clipped.length} fit-window bars — too few to prove anything`);
    return 1;
  }
  line();

  // ── 2. trades ─────────────────────────────────────────────────────────────
  const costModel = buildCostModel({
    instrument: TURN_OF_MONTH_SPEC.instrument,
    instrumentClass: TURN_OF_MONTH_SPEC.instrumentClass,
    venue: "unpriced-research-venue",
  });
  const build = buildTurnOfMonthEvaluationInput(clipped, TURN_OF_MONTH_SPEC, FIT, {
    at,
    costModel,
    fingerprintSymbol: source.symbol,
    fingerprintAdjustment: source.adjustment,
    nTrials: 1,
  });
  if (isTurnOfMonthBuildRefusal(build)) {
    line(`2. TRADES — REFUSED ${build.code}: ${build.detail}`);
    return 1;
  }
  line("2. TRADES (fit window)");
  line(`   ${build.trades.length} round trips, ${build.skipped.length} boundary/boundaries skipped`);
  line("   first three, so 'close of T-1 -> close of T+3' can be checked by eye:");
  for (const t of build.trades.slice(0, 3)) {
    line(
      `     ${t.boundaryMonth}  anchor T=${t.anchorDate}  enter ${t.entryDate} @ ${t.entryClose}  ` +
        `exit ${t.exitDate} @ ${t.exitClose}  gross ${(t.grossReturn * 100).toFixed(3)}%`,
    );
  }
  for (const s of build.skipped.slice(0, 3)) {
    line(`     SKIPPED ${s.boundaryMonth} (${s.reason}) ${s.detail}`);
  }
  line(`   data window read: ${build.input.dataWindow.start}..${build.input.dataWindow.end}`);
  line(`   fingerprint over the ${build.fingerprintedBars.length} bars used: ${build.input.dataFingerprint}`);
  line(
    `   costs: perSide ${costModel.perSideCostFrac.toFixed(6)} ` +
      `(spread ${costModel.spread.provenance}, slippage ${costModel.slippage.provenance}, commission ${costModel.commission.provenance}); ` +
      `total charged over the track ${build.totalCostCharged.toFixed(6)}`,
  );
  const grossMean = build.grossReturns.reduce((a, b) => a + b, 0) / build.grossReturns.length;
  const netMean = build.input.netOosReturns.reduce((a, b) => a + b, 0) / build.input.netOosReturns.length;
  line(
    `   mean per-trade return  gross ${(grossMean * 100).toFixed(4)}%  ->  net ${(netMean * 100).toFixed(4)}%  ` +
      "(netting only ever subtracts, by construction)",
  );
  line();

  // ── 3. the harness must REFUSE this input under the real spec ─────────────
  line("3. THE DISCIPLINE, DEMONSTRATED LIVE");
  const h = new TransferProofHarness();
  const unregistered = h.evaluate(TURN_OF_MONTH_SPEC, build.input);
  if (!isRefusal(unregistered) || unregistered.code !== "NOT_REGISTERED") {
    line(`   FAILED: an unregistered spec was not refused (got ${JSON.stringify(unregistered).slice(0, 120)})`);
    return 1;
  }
  line(`   a) unregistered spec -> REFUSED ${unregistered.code}`);

  const reg = h.register(TURN_OF_MONTH_SPEC, at);
  if (isRefusal(reg)) {
    line(`   FAILED: registration refused — ${reg.detail}`);
    return 1;
  }
  const overlap = h.evaluate(TURN_OF_MONTH_SPEC, build.input);
  if (!isRefusal(overlap) || overlap.code !== "FIT_WINDOW_OVERLAP") {
    line(`   FAILED: fit-window data was NOT refused (got ${JSON.stringify(overlap).slice(0, 160)})`);
    return 1;
  }
  line(`   b) fit-window data under the real spec -> REFUSED ${overlap.code}`);
  line(`      ${overlap.detail}`);
  const grossOnly = h.evaluate(TURN_OF_MONTH_SPEC, {
    ...build.input,
    dataWindow: { start: HOLDOUT.start, end: HOLDOUT.end },
    costs: { ...build.input.costs, applied: true, perSideCostFrac: 0 },
  });
  if (!isRefusal(grossOnly) || grossOnly.code !== "GROSS_ONLY") {
    line(`   FAILED: a zero-cost evaluation was NOT refused (got ${JSON.stringify(grossOnly).slice(0, 160)})`);
    return 1;
  }
  line(`   c) zero-cost (gross) evaluation -> REFUSED ${grossOnly.code}`);
  line();

  // ── 4. end-to-end on a THROWAWAY spec inside the fit era ──────────────────
  line("4. END-TO-END PIPE (throwaway spec, fit-era windows)");
  line("   THIS IS A PLUMBING PROOF. It is not evidence about the turn-of-month edge, it carries no");
  line("   FDR meaning, and its key is deliberately not the pre-registered experiment key.");
  const innerFit = { start: FIT.start, end: "2009-12-31" };
  const innerHoldout = { start: "2010-01-01", end: FIT.end };
  const throwaway: ExperimentSpec = {
    ...TURN_OF_MONTH_SPEC,
    experimentKey: "PLUMBING_PROOF_NOT_AN_EXPERIMENT",
    fitWindow: innerFit,
    holdoutWindow: innerHoldout,
    notes: "Throwaway spec used only by the C8 dry run to exercise the pipe. Never a claim about a market.",
  };
  const innerBuild = buildTurnOfMonthEvaluationInput(clipped, throwaway, innerHoldout, {
    at,
    costModel,
    fingerprintSymbol: source.symbol,
    fingerprintAdjustment: source.adjustment,
    nTrials: 1,
    selectionField: buildFitSelectionField(clipped, throwaway, innerFit, costModel).field,
    pboBlocks: 10,
  });
  if (isTurnOfMonthBuildRefusal(innerBuild)) {
    line(`   REFUSED ${innerBuild.code}: ${innerBuild.detail}`);
    return 1;
  }
  const h2 = new TransferProofHarness();
  const reg2 = h2.register(throwaway, at);
  if (isRefusal(reg2)) {
    line(`   FAILED: throwaway registration refused — ${reg2.detail}`);
    return 1;
  }
  const ev = h2.evaluate(throwaway, innerBuild.input);
  if (isRefusal(ev)) {
    line(`   FAILED: throwaway evaluation refused — ${ev.code}: ${ev.detail}`);
    return 1;
  }
  line(
    `   evaluated ${ev.evaluation!.nObs} trades over ${ev.evaluation!.dataWindow.start}..${ev.evaluation!.dataWindow.end}`,
  );
  line(
    `   net Sharpe ${ev.evaluation!.netSharpe.toFixed(4)}  net DSR ${ev.evaluation!.netDsr.toFixed(4)}  ` +
      `PBO ${Number.isFinite(ev.evaluation!.pbo) ? ev.evaluation!.pbo.toFixed(4) : "UNMEASURABLE"}`,
  );
  const verdict = h2.verdict(reg2.specHash, at);
  if (isRefusal(verdict)) {
    line(`   FAILED: verdict refused — ${verdict.code}`);
    return 1;
  }
  line(`   verdict (PLUMBING ONLY): ${verdict.verdict}`);
  for (const c of verdict.clauses) {
    line(`     ${c.pass ? "pass" : "FAIL"}  ${c.clause.padEnd(12)} ${c.bar.padEnd(42)} ${c.detail}`);
  }
  line(`   chain rows written: ${h2.chain().length}`);
  line();

  line("RESULT: plumbing proven on the fit window. The holdout was never read.");
  line(
    `MODE:   ${source.synthetic ? "SYNTHETIC FIXTURE — machinery only, no market claim of any kind" : "REAL fit-era bars"}`,
  );
  line("PRESS:  the OOS evaluation is the owner's, via scripts/src/c8TurnOfMonthEvaluate.ts.");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error(`c8TurnOfMonthDryRun FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exitCode = 2;
  });
